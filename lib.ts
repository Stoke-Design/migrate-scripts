/**
 * Offline WordPress cleanup helpers. Everything here works on a site folder on disk (an extracted cPanel
 * backup): no PHP, no WP-CLI, no database server. Nothing in this file writes inside the site — only
 * `removeToQuarantine` and `installPackage` (called from cli.ts) change files.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'

export const WORK_DIR = '_wp-cleanup' // reports + quarantine live here; always skipped by scans

/** Packages every site should carry. Override per run with --plugin-zip / --theme-zip / --child-zip. */
export const PACKAGES = {
  plugin: { url: 'https://sd-plugin.stokedesign.co/update-dist/stoke-internal-tools.3.7.1.zip', folder: 'stoke-internal-tools', version: '3.7.1' },
  theme: { url: 'https://hellotheme.stokecloud.dev/update-parent-dist/hello-stoke.1.2.0.zip', folder: 'hello-stoke', version: '1.2.0' },
  child: { url: 'https://hellotheme.stokecloud.dev/update-child-dist/hello-stoke-child.1.2.0.zip', folder: 'hello-stoke-child', version: '1.2.0' },
} as const

export type Severity = 'high' | 'medium' | 'low'
export interface Finding {
  severity: Severity
  rule: string
  path: string // relative to the WP root
  detail?: string
  line?: number
  size?: number
  action?: 'remove' | 'review'
}

/** Collects findings, keeping at most `cap` per rule but counting them all. */
export class Findings {
  items: Finding[] = []
  counts: Record<string, number> = {}
  constructor(private cap = 40) {}
  add(f: Finding) {
    this.counts[f.rule] = (this.counts[f.rule] ?? 0) + 1
    if (this.counts[f.rule]! <= this.cap) this.items.push(f)
  }
}

// ---------- locating the site ----------

/** Every folder under `dir` that looks like a WP install (has wp-content + wp-includes). */
export function findWpRoots(dir: string, maxDepth = 6): string[] {
  const out: string[] = []
  const go = (d: string, depth: number) => {
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name))
    const isRoot = dirs.has('wp-content') && dirs.has('wp-includes')
    if (isRoot) out.push(d)
    if (depth >= maxDepth) return
    for (const name of dirs) {
      if (name === 'node_modules' || name === WORK_DIR) continue
      if (isRoot && ['wp-content', 'wp-admin', 'wp-includes'].includes(name)) continue
      go(path.join(d, name), depth + 1)
    }
  }
  go(dir, 0)
  return out
}

export function readHeader(file: string, bytes = 8192): Record<string, string> {
  const fd = fs.openSync(file, 'r')
  let text = ''
  try {
    const buf = Buffer.alloc(bytes)
    text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0))
  } finally {
    fs.closeSync(fd)
  }
  const h: Record<string, string> = {}
  for (const m of text.matchAll(/^[ \t/*#@]*([A-Za-z][A-Za-z ]{1,30}):[ \t]*(.+?)\s*$/gm)) {
    const k = m[1]!.trim().toLowerCase()
    if (!(k in h)) h[k] = m[2]!.replace(/\s*\*\/.*$/, '')
  }
  return h
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

function* walk(dir: string, skip: (abs: string, name: string) => boolean): Generator<{ abs: string; name: string; isDir: boolean }> {
  let ents: fs.Dirent[]
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const abs = path.join(dir, e.name)
    if (e.isSymbolicLink() || skip(abs, e.name)) continue
    yield { abs, name: e.name, isDir: e.isDirectory() }
    if (e.isDirectory()) yield* walk(abs, skip)
  }
}

/** Size in bytes and file count of a folder or file; stops counting past `cap` files. */
export function sizeOf(p: string, cap = 50000): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  try {
    const st = fs.lstatSync(p)
    if (!st.isDirectory()) return { bytes: st.size, files: 1 }
    for (const f of walk(p, () => false)) {
      if (f.isDir) continue
      bytes += fs.lstatSync(f.abs).size
      if (++files >= cap) break
    }
  } catch {
    /* unreadable: report what we have */
  }
  return { bytes, files }
}

// ---------- wp-config / dump ----------

export interface WpConfig {
  prefix: string
  dbName: string | null
  constants: Record<string, string> // allowlisted, non-secret constants only
}

const CONFIG_CONSTANTS = ['WP_HOME', 'WP_SITEURL', 'WP_CONTENT_DIR', 'WP_CONTENT_URL', 'WP_PLUGIN_DIR', 'WP_TEMP_DIR', 'WP_CACHE', 'WP_DEBUG', 'WP_MEMORY_LIMIT', 'UPLOADS', 'WP_POST_REVISIONS', 'DISABLE_WP_CRON', 'DISALLOW_FILE_EDIT', 'AUTOMATIC_UPDATER_DISABLED', 'FORCE_SSL_ADMIN']

/** Reads wp-config.php. Credentials and salts are deliberately never returned. */
export function readWpConfig(root: string): WpConfig {
  let text = ''
  for (const p of [path.join(root, 'wp-config.php'), path.join(root, '..', 'wp-config.php')]) {
    if (fs.existsSync(p)) {
      text = fs.readFileSync(p, 'utf8')
      break
    }
  }
  const constants: Record<string, string> = {}
  for (const m of text.matchAll(/define\(\s*['"]([A-Z_]+)['"]\s*,\s*([^)]*?)\s*\)/g)) {
    if (CONFIG_CONSTANTS.includes(m[1]!)) constants[m[1]!] = m[2]!.slice(0, 120)
  }
  return {
    prefix: /\$table_prefix\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? 'wp_',
    dbName: /define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? null,
    constants,
  }
}

export function findSqlDump(searchDir: string, dbName: string | null): string | null {
  // cPanel puts dumps in <backup>/mysql/, so skip the (huge) homedir first and only fall back to a full search
  const search = (skipHome: boolean) => {
    const found: string[] = []
    for (const f of walk(searchDir, (_a, n) => n === 'node_modules' || n === WORK_DIR || n === 'wp-content' || (skipHome && n === 'homedir'))) {
      if (!f.isDir && /\.sql(\.gz)?$/i.test(f.name)) found.push(f.abs)
    }
    return found
  }
  const dumps = search(true)
  if (dumps.length === 0) dumps.push(...search(false))
  return dumps.find((d) => dbName && path.basename(d).replace(/\.sql(\.gz)?$/i, '') === dbName) ?? (dumps.length === 1 ? dumps[0]! : null)
}

export interface DumpInfo {
  file: string
  bytes: number
  siteurl?: string
  home?: string
  template?: string
  stylesheet?: string
  activePlugins: string[]
  autoloadBytes: number
  topAutoload: { name: string; bytes: number }[]
  transientCount: number
  transientBytes: number
  revisions: number
  hasCustomCss: boolean
  hasElementorData: boolean
  /** mediaKey()s of every wp-content/uploads/YYYY/MM/… file the database mentions; not serialised into the report */
  uploadRefs?: Set<string>
}

const unescapeSql = (s: string) => s.replace(/\\(['"\\])/g, '$1')
const SQ = String.raw`'([^'\\]*(?:\\.[^'\\]*)*)'`
const OPTION_ROW = new RegExp(String.raw`\((\d+),${SQ},${SQ},'(yes|no|on|off|auto|auto-on|auto-off)'\)`, 'g')

/** One streaming pass over the mysqldump; read-only. */
export async function parseDump(file: string, prefix: string): Promise<DumpInfo> {
  const info: DumpInfo = { file, bytes: fs.statSync(file).size, activePlugins: [], autoloadBytes: 0, topAutoload: [], transientCount: 0, transientBytes: 0, revisions: 0, hasCustomCss: false, hasElementorData: false, uploadRefs: new Set() }
  const raw = fs.createReadStream(file)
  const rl = readline.createInterface({ input: file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw, crlfDelay: Infinity })
  const heads = { options: `INSERT INTO \`${prefix}options\``, posts: `INSERT INTO \`${prefix}posts\``, postmeta: `INSERT INTO \`${prefix}postmeta\`` }
  const autoload: { name: string; bytes: number }[] = []
  const options = (line: string) => {
    for (const m of line.matchAll(OPTION_ROW)) {
      const name = m[2]!
      const bytes = m[3]!.length
      if (/^(yes|on|auto|auto-on)$/.test(m[4]!)) {
        info.autoloadBytes += bytes
        if (bytes > 10_000) autoload.push({ name, bytes })
      }
      if (/^_(site_)?transient_/.test(name)) {
        info.transientCount++
        info.transientBytes += bytes
      }
      const v = () => unescapeSql(m[3]!)
      if (name === 'siteurl') info.siteurl = v()
      else if (name === 'home') info.home = v()
      else if (name === 'template') info.template = v()
      else if (name === 'stylesheet') info.stylesheet = v()
      else if (name === 'active_plugins') info.activePlugins = [...v().matchAll(/"([^"]+\.php)"/g)].map((x) => x[1]!)
    }
  }
  const posts = (line: string) => {
    info.revisions += line.match(/'revision','',\d+\)/g)?.length ?? 0
    if (line.includes("'custom_css'")) info.hasCustomCss = true
  }
  const postmeta = (line: string) => {
    if (line.includes("'_elementor_data'")) info.hasElementorData = true
  }
  const refs = (line: string) => {
    const text = line.replace(/\\+\//g, '/') // JSON-escaped slashes in Elementor data etc.
    for (const m of text.matchAll(/uploads\/(\d{4}\/\d{2}\/[^\s"'\\<>)?#,;&]+)/g)) info.uploadRefs!.add(mediaKey(m[1]!))
    for (const m of text.matchAll(/'_wp_attached_file','([^']+)'/g)) info.uploadRefs!.add(mediaKey(m[1]!))
  }
  // mysqldump writes either one long INSERT per table or an INSERT header followed by one "(row)," line per row
  let current: ((line: string) => void) | null = null
  for await (const line of rl) {
    if (line.startsWith('INSERT INTO `')) current = line.startsWith(heads.options) ? options : line.startsWith(heads.posts) ? posts : line.startsWith(heads.postmeta) ? postmeta : null
    else if (!line.startsWith('(')) current = null
    if (line.includes('uploads') || line.includes('_wp_attached_file')) refs(line)
    current?.(line)
    if (line.endsWith(';')) current = null
  }
  info.topAutoload = autoload.sort((a, b) => b.bytes - a.bytes).slice(0, 15)
  return info
}

// ---------- plugins and themes ----------

export interface PluginInfo {
  slug: string
  kind: 'plugin' | 'mu-plugin' | 'dropin'
  name: string | null
  version: string | null
  author: string | null
  path: string // relative to the WP root
  bytes: number
  stoke: boolean
  active?: boolean // only known when a dump was parsed
}

const isStoke = (slug: string, name: string | null, author: string | null) => /^(stoke|sdc-wordpress-plugin)/i.test(slug) || /stoke/i.test(`${name ?? ''} ${author ?? ''}`)

export function listPlugins(root: string, activePlugins?: string[]): PluginInfo[] {
  const out: PluginInfo[] = []
  const base = path.join(root, 'wp-content')
  const activeSlugs = activePlugins && new Set(activePlugins.map((p) => p.split('/')[0]!.replace(/\.php$/, '')))
  for (const [sub, kind] of [['plugins', 'plugin'], ['mu-plugins', 'mu-plugin']] as const) {
    const dir = path.join(base, sub)
    if (!fs.existsSync(dir)) continue
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'index.php' || e.name === '__MACOSX' || e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      let header: Record<string, string> = {}
      if (e.isDirectory()) {
        const main = fs.readdirSync(abs).filter((f) => f.endsWith('.php')).find((f) => readHeader(path.join(abs, f))['plugin name'])
        if (main) header = readHeader(path.join(abs, main))
      } else if (e.name.endsWith('.php')) header = readHeader(abs)
      else continue
      const slug = e.name.replace(/\.php$/, '')
      out.push({ slug, kind, name: header['plugin name'] ?? null, version: header['version'] ?? null, author: header['author'] ?? null, path: path.relative(root, abs), bytes: sizeOf(abs).bytes, stoke: isStoke(slug, header['plugin name'] ?? null, header['author'] ?? null), active: kind === 'plugin' ? activeSlugs?.has(slug) : undefined })
    }
  }
  for (const d of ['advanced-cache.php', 'object-cache.php', 'db.php']) {
    const abs = path.join(base, d)
    if (fs.existsSync(abs)) out.push({ slug: d, kind: 'dropin', name: readHeader(abs)['plugin name'] ?? null, version: null, author: null, path: path.relative(root, abs), bytes: fs.statSync(abs).size, stoke: false })
  }
  return out
}

export interface ThemeInfo {
  slug: string
  name: string | null
  version: string | null
  author: string | null
  parent: string | null // Template header; set means child theme
  path: string
  bytes: number
  active?: boolean
  isDefaultWpTheme: boolean
  customCode: { verdict: 'likely' | 'none-detected' | 'unknown'; functionsPhpLines: number; extraPhpCount: number; extraPhpFiles: string[]; cssBytes: number; hooks: string[] }
}

const HOOK_RE = /\b(add_action|add_filter|add_shortcode|register_post_type|register_taxonomy|wp_enqueue_(?:script|style)|define|require(?:_once)?|include(?:_once)?|wp_mail|header)\s*\(/g
const CODE_LINE = (l: string) => l.trim() !== '' && !/^\s*(\/\/|#|\/\*|\*|<\?php|\?>)/.test(l)

export function listThemes(root: string, stylesheet?: string): ThemeInfo[] {
  const dir = path.join(root, 'wp-content', 'themes')
  if (!fs.existsSync(dir)) return []
  const out: ThemeInfo[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    const css = path.join(abs, 'style.css')
    if (!e.isDirectory() || !fs.existsSync(css)) continue
    const h = readHeader(css)
    const parent = h['template'] ?? null
    const fnFile = path.join(abs, 'functions.php')
    const fnText = fs.existsSync(fnFile) ? fs.readFileSync(fnFile, 'utf8') : ''
    const functionsPhpLines = fnText.split('\n').filter(CODE_LINE).length
    const extraPhpFiles = [...walk(abs, (_a, n) => n === 'node_modules')]
      .filter((f) => !f.isDir && f.name.endsWith('.php') && f.abs !== fnFile && f.name !== 'index.php')
      .map((f) => path.relative(abs, f.abs))
    const cssBytes = Math.max(0, fs.statSync(css).size - 600) // minus the header block, roughly
    const hooks = [...new Set([...fnText.matchAll(HOOK_RE)].map((m) => m[1]!))]
    // A child theme doing more than enqueueing its parent's stylesheet is custom code. For a parent we have no stock copy to diff against.
    const beyondEnqueue = hooks.some((h) => h !== 'add_action' && !h.startsWith('wp_enqueue_'))
    const verdict = parent ? (beyondEnqueue || functionsPhpLines > 12 || extraPhpFiles.length > 0 || cssBytes > 300 ? 'likely' : 'none-detected') : 'unknown'
    out.push({ slug: e.name, name: h['theme name'] ?? null, version: h['version'] ?? null, author: h['author'] ?? null, parent, path: path.relative(root, abs), bytes: sizeOf(abs).bytes, active: stylesheet ? stylesheet === e.name : undefined, isDefaultWpTheme: /^twenty/.test(e.name), customCode: { verdict, functionsPhpLines, extraPhpCount: extraPhpFiles.length, extraPhpFiles: extraPhpFiles.slice(0, 50), cssBytes, hooks } })
  }
  return out
}

export function isElementorSite(plugins: PluginInfo[], themes: ThemeInfo[], dump?: DumpInfo) {
  return plugins.some((p) => p.slug === 'elementor' || p.slug === 'elementor-pro') || themes.some((t) => t.slug === 'hello-elementor' || t.parent === 'hello-elementor') || !!dump?.hasElementorData
}

// ---------- junk folders and files ----------

type Rule = [RegExp, string, 'remove' | 'review', string]
const JUNK_RULES: Rule[] = [
  [/^(backups?|backup[-_ ].*|.*[-_]backups?|updraft|ai1wm-backups|wpvividbackups|backwpup.*|duplicator.*|wp-snapshots|backupbuddy.*|snapshots?|.*\.bak|.*\.orig|.*[-_.]old|old[-_.].*|.*[-_]copy|.*-\d{8}.*)$/i, 'backup', 'remove', 'Backup/old copy'],
  [/^(cache|w3tc-cache|w3tc-config|wp-rocket-config|litespeed|et-cache|breeze-cache|wpo-cache|wflogs|upgrade|upgrade-temp-backup|hyper-cache|nginx-cache|wp-cache.*|cache-enabler|comet-cache|autoptimize)$/i, 'cache', 'remove', 'Regenerable cache'],
  [/^(debug\.log|error_log|php_errorlog|.*\.log)$/i, 'log', 'remove', 'Log file'],
  [/\.(zip|tar|tar\.gz|tgz|gz|sql|bz2|7z|rar)$/i, 'archive', 'remove', 'Archive/dump left in the site'],
  [/^(info|phpinfo|test|php|adminer|shell)\.php$/i, 'tool', 'remove', 'Diagnostic/throwaway script'],
  [/^(\.DS_Store|__MACOSX|\.swp|thumbs\.db)$/i, 'os-junk', 'remove', 'OS junk'],
]
const CONTENT_KNOWN = /^(plugins|themes|uploads|mu-plugins|languages|index\.php|fonts?|advanced-cache\.php|object-cache\.php|db\.php)$/i

/** wp-content (minus uploads) and the site root. Names only, no content reads. */
export function scanJunk(root: string, f: Findings) {
  const rel = (p: string) => path.relative(root, p)
  const check = (abs: string, name: string, ctx: 'root' | 'content' | 'uploads') => {
    for (const [re, kind, action, reason] of JUNK_RULES) {
      if (re.test(name)) {
        f.add({ severity: kind === 'tool' ? 'high' : 'low', rule: `junk-${kind}`, path: rel(abs), detail: reason, size: sizeOf(abs).bytes, action })
        return true
      }
    }
    if (ctx === 'content' && !CONTENT_KNOWN.test(name)) {
      f.add({ severity: 'low', rule: 'unrecognised-content-entry', path: rel(abs), detail: 'Not a core wp-content entry — check which plugin created it', size: sizeOf(abs).bytes, action: 'review' })
    }
    return false
  }
  const content = path.join(root, 'wp-content')
  for (const e of safeDir(content)) if (e.name !== 'uploads') check(path.join(content, e.name), e.name, 'content')
  for (const e of safeDir(path.join(content, 'uploads'))) if (e.isDirectory() || e.name.endsWith('.log')) check(path.join(content, 'uploads', e.name), e.name, 'uploads')
  for (const e of safeDir(root)) {
    const abs = path.join(root, e.name)
    if (e.name === 'wp-config-sample.php') f.add({ severity: 'low', rule: 'junk-config-sample', path: rel(abs), detail: 'Core sample config', action: 'remove', size: fs.statSync(abs).size })
    else if (['readme.html', 'license.txt'].includes(e.name)) f.add({ severity: 'low', rule: 'junk-core-doc', path: rel(abs), detail: 'Leaks WP version; regenerated on update', action: 'remove', size: fs.statSync(abs).size })
    else if (!['wp-content', 'wp-admin', 'wp-includes', WORK_DIR].includes(e.name)) check(abs, e.name, 'root')
  }
  // error_log files turn up in every folder cPanel PHP ran in
  const skip = (abs: string, n: string) => {
    if (n === '__MACOSX') f.add({ severity: 'low', rule: 'junk-os-junk', path: rel(abs), detail: 'macOS zip leftover', action: 'remove', size: sizeOf(abs).bytes })
    return n === 'uploads' || n === WORK_DIR || n === 'node_modules' || n === '__MACOSX'
  }
  for (const w of walk(root, skip)) {
    if (!w.isDir && /^(error_log|php_errorlog)$/.test(w.name) && path.dirname(w.abs) !== root) f.add({ severity: 'low', rule: 'junk-log', path: rel(w.abs), detail: 'Log file', action: 'remove', size: fs.statSync(w.abs).size })
  }
}

function safeDir(d: string): fs.Dirent[] {
  try {
    return fs.readdirSync(d, { withFileTypes: true })
  } catch {
    return []
  }
}

// ---------- dev sites and uploads ----------

/** "2024/01/photo-300x200.jpg", "2024/01/photo-scaled.jpg", "2024/01/photo.jpg.webp" all map to "2024/01/photo". */
export function mediaKey(rel: string): string {
  let p = rel.replace(/^\/+/, '').replace(/[?#].*$/, '')
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep as is */
  }
  const dir = path.posix.dirname(p)
  const base = path.posix
    .basename(p)
    .replace(/\.(webp|avif)$/i, '')
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/(-(scaled|rotated|e\d{10,}|\d+x\d+))+$/, '')
  return dir === '.' ? base : `${dir}/${base}`
}

const DEV_NAME = /^(dev|development|staging|stage|stg|test|testing|demo|beta|sandbox|old|new|temp|tmp|v\d|wp-?(dev|old|new|test|staging)|.*[-_.](dev|staging|stage|stg|test|old|new|bak|copy))$/i

/** Other WordPress installs and dev-looking folders inside the WP root. Names/headers only, never deleted automatically. */
export function scanDevSites(root: string, f: Findings) {
  const main = readWpConfig(root).dbName
  const nested = new Set(findWpRoots(root, 3).filter((r) => r !== root))
  for (const abs of nested) {
    const v = /\$wp_version\s*=\s*'([^']+)'/.exec(fs.existsSync(path.join(abs, 'wp-includes', 'version.php')) ? fs.readFileSync(path.join(abs, 'wp-includes', 'version.php'), 'utf8') : '')?.[1]
    const db = readWpConfig(abs).dbName
    f.add({ severity: 'medium', rule: 'nested-wp-install', path: path.relative(root, abs), size: sizeOf(abs).bytes, action: 'review', detail: `Second WordPress${v ? ` ${v}` : ''} inside the site (${db && main && db === main ? 'same database as the main site' : 'its own database'}). Dev/staging copy, or an addon-domain site? Ask` })
  }
  for (const e of safeDir(root)) {
    const abs = path.join(root, e.name)
    if (e.isDirectory() && DEV_NAME.test(e.name) && ![...nested].some((n) => n === abs) && !['wp-content', 'wp-admin', 'wp-includes'].includes(e.name) && !/^(backups?|cache|tmp)$/i.test(e.name)) {
      f.add({ severity: 'low', rule: 'dev-site-folder', path: e.name, size: sizeOf(abs).bytes, action: 'review', detail: 'Folder name looks like a dev/staging/old copy' })
    }
  }
}

const UPLOAD_JUNK_FILE = /(\.(log|tmp|bak|sql|swp)|^\.DS_Store|^thumbs\.db)$/i
const REGENERABLE_UPLOADS = ['elementor/css', 'elementor/thumbs', 'elementor/tmp', 'cache', 'wc-logs', 'et_temp', 'ao_ccss', 'autoptimize', 'litespeed', 'wp-rocket', 'sucuri']

/**
 * Things in wp-content/uploads that serve no purpose: regenerable plugin output, logs and dumps, and (when a database
 * dump is available) media files that no attachment record or content references. The orphan test is a heuristic,
 * so it only ever produces a list for the user to confirm.
 */
export function scanUploads(root: string, f: Findings, dump?: DumpInfo): { orphans: { path: string; bytes: number }[]; orphanBytes: number; checked: boolean } {
  const up = path.join(root, 'wp-content', 'uploads')
  const rel = (p: string) => path.relative(root, p)
  for (const d of REGENERABLE_UPLOADS) {
    const abs = path.join(up, d)
    if (fs.existsSync(abs)) f.add({ severity: 'low', rule: 'uploads-regenerable', path: rel(abs), size: sizeOf(abs).bytes, action: 'remove', detail: 'Plugin output that is regenerated on demand' })
  }
  const orphans: { path: string; bytes: number }[] = []
  let orphanBytes = 0
  const checked = !!dump?.uploadRefs && dump.uploadRefs.size > 0
  const skip = (abs: string, n: string) => {
    if (n === '__MACOSX') f.add({ severity: 'low', rule: 'uploads-junk-file', path: rel(abs), action: 'remove', detail: 'macOS zip leftover' })
    return n === WORK_DIR || n === '__MACOSX' || REGENERABLE_UPLOADS.some((d) => path.join(up, d) === abs)
  }
  for (const w of walk(up, skip)) {
    if (w.isDir) continue
    const r = rel(w.abs).split(path.sep).join('/')
    const sub = r.slice('wp-content/uploads/'.length)
    const size = fs.statSync(w.abs).size
    if (UPLOAD_JUNK_FILE.test(w.name)) f.add({ severity: 'low', rule: 'uploads-junk-file', path: r, size, action: 'remove', detail: 'Log, dump or OS junk' })
    else if (checked && /^\d{4}\/\d{2}\//.test(sub) && !/^(index\.php|\.htaccess)$/.test(w.name) && !dump!.uploadRefs!.has(mediaKey(sub))) {
      orphans.push({ path: r, bytes: size })
      orphanBytes += size
    }
  }
  return { orphans, orphanBytes, checked }
}

// ---------- malware, leftovers ----------

const PHP_EXT = /\.(php[0-9]?|phtml|pht|phar|inc)$/i
const MAX_READ = 3_000_000

const MALWARE_PHP: [string, Severity, RegExp][] = [
  ['eval-obfuscated', 'high', /\beval\s*\(\s*(?:base64_decode|gzinflate|gzuncompress|str_rot13|rawurldecode|urldecode)\s*\(/i],
  ['eval-request-input', 'high', /\b(?:eval|assert)\s*\(\s*\$_(?:POST|GET|REQUEST|COOKIE|SERVER)/i],
  ['exec-request-input', 'high', /\b(?:system|shell_exec|passthru|exec|popen|proc_open|pcntl_exec)\s*\(\s*\$_(?:POST|GET|REQUEST|COOKIE)/i],
  ['preg-replace-e', 'high', /preg_replace\s*\(\s*['"][^'"]*\/[a-z]*e[a-z]*['"]\s*,/i],
  ['long-base64-blob', 'high', /base64_decode\s*\(\s*['"][A-Za-z0-9+/=]{300,}['"]/],
  ['gzinflate-base64', 'high', /gzinflate\s*\(\s*base64_decode/i],
  ['webshell-signature', 'high', /\b(?:FilesMan|c99shell|r57shell|b374k|IndoXploit|WSO_VERSION)\b/],
  ['hex-obfuscation', 'low', /(?:\\x[0-9a-f]{2}){25,}/i],
  ['chr-chain', 'low', /(?:chr\s*\(\s*\d+\s*\)\s*\.\s*){8,}/i],
]
const MALWARE_JS: [string, Severity, RegExp][] = [
  ['js-unescape-write', 'high', /document\.write\s*\(\s*unescape\s*\(/],
  ['js-packer', 'medium', /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k/],
]
const SUSPECT_NAMES = /^(wp-vcd|wp-tmp|wp-feed|class\.wp|wp-xmlrpc|\.[a-z0-9][a-z0-9_-]*)\.php$/i // hidden *.php, but not macOS "._x.php" files
const BUNDLED_LIB = /(^|\/)(vendor|sodium_compat)\//i // legit libraries are full of hex tables and byte-string builders

const LEFTOVER_RULES: [string, RegExp][] = [
  ['cpanel-php-handler', /# BEGIN cPanel-generated|suPHP_ConfigFile|AddHandler\s+application\/x-httpd-(?:ea-)?php|AddType\s+application\/x-httpd-php|^\s*php_(?:value|flag)\s/im],
  ['home-path', /\/home\d*\/[a-z0-9_.-]+\/(?:public_html|www|domains|tmp|logs)/i],
  ['synergy-reference', /synergy\s?wholesale|synergywholesale|\bsynergy\b/i],
  ['cpanel-reference', /cpanel|\bwhm\b|softaculous|cpsess|cpmove/i],
]
const LEFTOVER_NAMES = /synergy|cpanel|softaculous|cpmove|\.cphorde|\.htpasswd/i
const NO_SNIPPET = /^(wp-config\.php|\.htpasswd)$/i // never echo these back

/** One pass over the site's code: malware signatures and Synergy/cPanel leftovers. */
export function scanCode(root: string, malware: Findings, leftovers: Findings) {
  const rel = (p: string) => path.relative(root, p)
  for (const w of walk(root, (_a, n) => n === WORK_DIR || n === 'node_modules')) {
    const r = rel(w.abs)
    const inUploads = r.startsWith(path.join('wp-content', 'uploads') + path.sep)
    if (LEFTOVER_NAMES.test(w.name) && !inUploads) leftovers.add({ severity: 'medium', rule: 'leftover-name', path: r, detail: 'File/folder name points at the old host', action: 'review' })
    if (w.isDir) continue
    if (inUploads) {
      if (PHP_EXT.test(w.name) && !/^index\.php$/.test(w.name)) malware.add({ severity: 'high', rule: 'php-in-uploads', path: r, size: fs.statSync(w.abs).size, detail: 'Executable file in the media library' })
      continue
    }
    if (PHP_EXT.test(w.name) && SUSPECT_NAMES.test(w.name)) malware.add({ severity: 'medium', rule: 'suspicious-filename', path: r, size: fs.statSync(w.abs).size })

    const isCode = PHP_EXT.test(w.name) || /\.(js|ini|htaccess)$/i.test(w.name) || w.name === '.htaccess' || w.name === '.user.ini'
    if (!isCode) continue
    const st = fs.statSync(w.abs)
    if (st.size > MAX_READ || (w.name.endsWith('.js') && st.size > 1_000_000)) continue
    const text = fs.readFileSync(w.abs, 'latin1')
    const lineOf = (idx: number) => text.slice(0, idx).split('\n').length
    const snippet = (idx: number, len: number) => (NO_SNIPPET.test(w.name) ? undefined : text.slice(idx, idx + len).replace(/\s+/g, ' ').slice(0, 100))

    if (PHP_EXT.test(w.name)) {
      for (const [rule, severity, re] of MALWARE_PHP) {
        if ((rule === 'hex-obfuscation' || rule === 'chr-chain') && BUNDLED_LIB.test(r.split(path.sep).join('/'))) continue
        const m = re.exec(text)
        if (m) malware.add({ severity, rule, path: r, line: lineOf(m.index), detail: snippet(m.index, m[0].length), size: st.size })
      }
    } else if (w.name.endsWith('.js')) {
      for (const [rule, severity, re] of MALWARE_JS) {
        const m = re.exec(text)
        if (m) malware.add({ severity, rule, path: r, detail: snippet(m.index, 60), size: st.size })
      }
    }
    if (w.name === '.htaccess' || w.name === '.user.ini' || w.name === 'php.ini') {
      const m = /auto_(?:prepend|append)_file\s*[= ]\s*['"]?([^\s'"]+)/i.exec(text)
      if (m) {
        // Wordfence's WAF legitimately sets this, but with the old server's absolute path — fatal on the new host.
        if (/wordfence-waf\.php/.test(m[1]!)) leftovers.add({ severity: 'high', rule: 'wordfence-waf-prepend', path: r, line: lineOf(m.index), detail: 'auto_prepend_file points at the old server path; remove or the site fatals on the new host', action: 'review' })
        else malware.add({ severity: 'high', rule: 'auto-prepend', path: r, line: lineOf(m.index), detail: snippet(m.index, 80) })
      }
      if (/RewriteCond\s+%\{HTTP_(?:USER_AGENT|REFERER)\}[^\n]*(?:google|bing|yahoo|yandex)[^\n]*\n(?:[^\n]*\n){0,2}\s*RewriteRule[^\n]*https?:\/\//i.test(text)) malware.add({ severity: 'medium', rule: 'htaccess-search-referrer-redirect', path: r, detail: 'Redirects search visitors elsewhere — classic SEO spam' })
    }

    // leftovers: config-ish files, mu-plugins, drop-ins, theme functions.php (not every plugin: backup plugins legitimately say "cpanel")
    const isConfigish = /^(wp-config\.php|\.htaccess|php\.ini|\.user\.ini|\.maintenance|\.htpasswd)$/i.test(w.name) && path.dirname(w.abs) === root
    const isLooseCode = r.startsWith(path.join('wp-content', 'mu-plugins') + path.sep) || /^wp-content\/(advanced-cache|object-cache|db)\.php$/.test(r.split(path.sep).join('/')) || /^wp-content\/themes\/[^/]+\/functions\.php$/.test(r.split(path.sep).join('/'))
    if (isConfigish || isLooseCode || /^wp-content\/[^/]+\.php$/.test(r.split(path.sep).join('/'))) {
      for (const [rule, re] of LEFTOVER_RULES) {
        if (rule === 'cpanel-php-handler' && !w.name.startsWith('.')) continue
        const m = re.exec(text)
        if (m) leftovers.add({ severity: rule === 'cpanel-php-handler' || rule === 'home-path' ? 'medium' : 'low', rule, path: r, line: lineOf(m.index), detail: snippet(m.index, 80), action: 'review' })
      }
    }
  }
}

/** Optional: compare wp-admin / wp-includes / root files against wordpress.org's published checksums (a GET). */
export async function verifyCore(root: string, f: Findings): Promise<string> {
  const vp = path.join(root, 'wp-includes', 'version.php')
  const vt = fs.existsSync(vp) ? fs.readFileSync(vp, 'utf8') : ''
  const version = /\$wp_version\s*=\s*'([^']+)'/.exec(vt)?.[1]
  if (!version) return 'unknown'
  const locale = /\$wp_local_package\s*=\s*'([^']+)'/.exec(vt)?.[1] ?? 'en_US'
  let sums: Record<string, string> | false = false
  for (const loc of new Set([locale, 'en_US'])) {
    const res = await fetch(`https://api.wordpress.org/core/checksums/1.0/?version=${version}&locale=${loc}`)
    if (res.ok) sums = ((await res.json()) as { checksums: Record<string, string> | false }).checksums
    if (sums) break
  }
  if (!sums) return `${version} (no published checksums)`
  const intentionallyGone = new Set(['wp-config-sample.php', 'readme.html', 'license.txt'])
  for (const [file, md5] of Object.entries(sums)) {
    if (file.startsWith('wp-content/')) continue
    const abs = path.join(root, file)
    if (!fs.existsSync(abs)) {
      if (!intentionallyGone.has(file)) f.add({ severity: 'medium', rule: 'core-missing', path: file })
    } else if (crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex') !== md5) {
      f.add({ severity: 'high', rule: 'core-modified', path: file, detail: 'Differs from the official WordPress file' })
    }
  }
  for (const dir of ['wp-admin', 'wp-includes']) {
    for (const w of walk(path.join(root, dir), () => false)) {
      const r = path.relative(root, w.abs).split(path.sep).join('/')
      // logs and OS junk are reported as junk, not as tampering
      if (!w.isDir && !(r in sums) && !r.includes('/languages/') && !/(^|\/)(error_log|php_errorlog|\.DS_Store)$/.test(r)) f.add({ severity: PHP_EXT.test(w.name) ? 'high' : 'low', rule: 'core-extra-file', path: r, detail: 'Not part of this WordPress release' })
    }
  }
  return version
}

// ---------- performance ----------

const PLUGIN_GROUPS: Record<string, { slugs: RegExp; note: string }> = {
  'page-cache': { slugs: /^(wp-super-cache|w3-total-cache|wp-fastest-cache|wp-rocket|litespeed-cache|cache-enabler|comet-cache|hummingbird-performance|sg-cachepress|breeze|nginx-helper|hyper-cache)$/, note: 'SpinupWP serves a server-level page cache; a second cache plugin is redundant and can fight it' },
  'host-specific': { slugs: /^(sg-cachepress|sg-security|endurance-page-cache|bluehost-wordpress-plugin|godaddy-.*|wpengine-.*|kinsta-.*|synergy.*|wp-cpanel.*)$/, note: 'Tied to the old host' },
  backup: { slugs: /^(updraftplus|duplicator|duplicator-pro|backwpup|all-in-one-wp-migration|backupbuddy|wpvivid-backuprestore|backup-backup|jetpack-backup)$/, note: 'SpinupWP takes server backups; these add disk and cron load' },
  'dev-only': { slugs: /^(query-monitor|debug-bar.*|log-viewer|wp-crontrol|health-check)$/, note: 'Developer tool left installed' },
  heavy: { slugs: /^(broken-link-checker|wp-slimstat|yet-another-related-posts-plugin|similar-posts)$/, note: 'Known to be heavy on database/CPU' },
  'page-builder': { slugs: /^(elementor|divi-builder|js_composer|beaver-builder-lite-version|bb-plugin|siteorigin-panels|oxygen|bricks|so-.*)$/, note: 'Several page builders loaded together' },
}

export interface PerfItem {
  severity: Severity
  rule: string
  detail: string
  paths?: string[]
}

export function scanPerformance(root: string, plugins: PluginInfo[], cfg: WpConfig, dump?: DumpInfo): PerfItem[] {
  const out: PerfItem[] = []
  const real = plugins.filter((p) => p.kind === 'plugin')
  for (const [group, { slugs, note }] of Object.entries(PLUGIN_GROUPS)) {
    const hit = real.filter((p) => slugs.test(p.slug))
    if (group === 'page-builder' ? hit.length > 1 : hit.length > 0) out.push({ severity: group === 'page-builder' ? 'low' : 'medium', rule: `plugins-${group}`, detail: `${note}: ${hit.map((p) => p.slug).join(', ')}`, paths: hit.map((p) => p.path) })
  }
  const inactive = real.filter((p) => p.active === false)
  if (inactive.length) out.push({ severity: 'low', rule: 'inactive-plugins', detail: `${inactive.length} inactive plugins still on disk`, paths: inactive.map((p) => p.path) })
  if (real.length > 30) out.push({ severity: 'low', rule: 'plugin-count', detail: `${real.length} plugins installed` })
  const c = cfg.constants
  if (/true/i.test(c.WP_DEBUG ?? '')) out.push({ severity: 'medium', rule: 'wp-debug-on', detail: 'WP_DEBUG is true in wp-config.php' })
  if (/true/i.test(c.WP_CACHE ?? '') && !fs.existsSync(path.join(root, 'wp-content', 'advanced-cache.php'))) out.push({ severity: 'low', rule: 'wp-cache-without-dropin', detail: 'WP_CACHE is on but there is no advanced-cache.php' })
  if (!('DISALLOW_FILE_EDIT' in c)) out.push({ severity: 'low', rule: 'file-edit-allowed', detail: 'DISALLOW_FILE_EDIT not set' })
  if (/\/home\d*\//.test(`${c.WP_CONTENT_DIR ?? ''}${c.WP_TEMP_DIR ?? ''}${c.WP_PLUGIN_DIR ?? ''}`)) out.push({ severity: 'high', rule: 'hardcoded-paths', detail: 'wp-config.php defines absolute /home/... paths' })
  if (dump) {
    if (dump.autoloadBytes > 1_000_000) out.push({ severity: dump.autoloadBytes > 3_000_000 ? 'high' : 'medium', rule: 'autoload-bloat', detail: `Autoloaded options total ${(dump.autoloadBytes / 1e6).toFixed(1)} MB (aim for under 1 MB). Largest: ${dump.topAutoload.slice(0, 5).map((o) => `${o.name} ${(o.bytes / 1000).toFixed(0)}KB`).join(', ')}` })
    if (dump.transientBytes > 500_000 || dump.transientCount > 500) out.push({ severity: 'medium', rule: 'transients', detail: `${dump.transientCount} transient rows, ${(dump.transientBytes / 1e6).toFixed(1)} MB — safe to purge` })
    if (dump.revisions > 1000) out.push({ severity: 'medium', rule: 'revisions', detail: `${dump.revisions} post revisions` })
    if (dump.bytes > 200_000_000) out.push({ severity: 'low', rule: 'big-database', detail: `Dump is ${(dump.bytes / 1e6).toFixed(0)} MB` })
  }
  // uploads: stat only, no content reads
  let imgs = 0
  let big: { p: string; b: number }[] = []
  let total = 0
  for (const w of walk(path.join(root, 'wp-content', 'uploads'), () => false)) {
    if (w.isDir) continue
    const b = fs.statSync(w.abs).size
    total += b
    if (/\.(jpe?g|png|gif|webp)$/i.test(w.name)) {
      imgs++
      if (b > 1_000_000 && !/-\d+x\d+\./.test(w.name)) big.push({ p: path.relative(root, w.abs), b })
    }
  }
  big = big.sort((a, b) => b.b - a.b)
  if (big.length) out.push({ severity: 'medium', rule: 'oversized-images', detail: `${big.length} of ${imgs} originals are over 1 MB (uploads total ${(total / 1e6).toFixed(0)} MB); largest ${(big[0]!.b / 1e6).toFixed(1)} MB`, paths: big.slice(0, 15).map((x) => x.p) })
  return out
}

// ---------- Stoke packages ----------

export interface StokeStatus {
  plugin: { target: string; canonical: PluginInfo | null; status: 'missing' | 'current' | 'older' | 'newer'; otherCopies: PluginInfo[]; activeAtSource: string[] }
  themes: { elementor: boolean; hello: ThemeInfo | null; child: ThemeInfo | null; needsInstall: boolean; existingNeedsReview: boolean }
  plan: string[]
}

export function stokeStatus(plugins: PluginInfo[], themes: ThemeInfo[], elementor: boolean, target = PACKAGES.plugin.version): StokeStatus {
  const copies = plugins.filter((p) => p.stoke && p.kind === 'plugin')
  const canonical = copies.find((p) => p.slug === PACKAGES.plugin.folder) ?? null
  const status = !canonical ? 'missing' : !canonical.version ? 'older' : cmpVersion(canonical.version, target) === 0 ? 'current' : cmpVersion(canonical.version, target) < 0 ? 'older' : 'newer'
  const otherCopies = copies.filter((p) => p !== canonical)
  const hello = themes.find((t) => t.slug === PACKAGES.theme.folder) ?? null
  const child = themes.find((t) => t.slug === PACKAGES.child.folder) ?? null
  const needsInstall = elementor && (!hello || !child)
  const existingNeedsReview = !!(hello && hello.version !== PACKAGES.theme.version) || !!(child && child.version !== PACKAGES.child.version)
  const plan: string[] = []
  if (status === 'older') plan.push(`Remove ${canonical!.path} (v${canonical!.version ?? '?'}), then install ${PACKAGES.plugin.folder} ${target}`)
  if (status === 'missing') plan.push(`Install ${PACKAGES.plugin.folder} ${target}`)
  for (const c of otherCopies) plan.push(`Remove older Stoke plugin copy ${c.path} (v${c.version ?? '?'}${c.active ? ', ACTIVE at source' : ''})`)
  if (needsInstall) plan.push(`Elementor site: install ${[!hello && PACKAGES.theme.folder, !child && PACKAGES.child.folder].filter(Boolean).join(' + ')}`)
  if (existingNeedsReview) plan.push('hello-stoke/-child already present at another version — do not overwrite (wipes child customisations); review manually')
  return { plugin: { target, canonical, status, otherCopies, activeAtSource: copies.filter((p) => p.active).map((p) => p.slug) }, themes: { elementor, hello, child, needsInstall, existingNeedsReview }, plan }
}

// ---------- mutations ----------

const NEVER_REMOVE = new Set(['wp-config.php', 'wp-content', 'wp-content/uploads', 'wp-content/plugins', 'wp-content/themes', 'wp-admin', 'wp-includes', '.'])

/** Moves paths (relative to the WP root) into <workDir>/removed/<timestamp>/ so everything is reversible. */
export function removeToQuarantine(rootIn: string, workDir: string, rels: string[]): { moved: string[]; dest: string } {
  const root = fs.realpathSync(rootIn)
  const dest = path.join(workDir, 'removed', new Date().toISOString().replace(/[:.]/g, '-'))
  const moved: string[] = []
  for (const input of rels) {
    const rel = path.normalize(input).split(path.sep).join('/').replace(/\/$/, '')
    const abs = path.resolve(root, rel)
    if (NEVER_REMOVE.has(rel) || !abs.startsWith(root + path.sep)) throw new Error(`Refusing to remove "${input}"`)
    if (!fs.existsSync(abs)) throw new Error(`Not found: ${input}`)
    if (!(fs.realpathSync(path.dirname(abs)) + path.sep).startsWith(root + path.sep)) throw new Error(`Symlink escape: ${input}`)
    const to = path.join(dest, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(abs, to, { recursive: true, verbatimSymlinks: true })
    fs.rmSync(abs, { recursive: true, force: true })
    moved.push(rel)
  }
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ root, movedAt: new Date().toISOString(), moved }, null, 2))
  return { moved, dest }
}

/** Downloads (https GET) or copies a zip, unpacks it, checks the folder, and moves it into place. Never overwrites. */
export async function installPackage(root: string, workDir: string, kind: 'plugin' | 'theme', src: string, folder: string): Promise<{ installedTo: string; version: string | null; sha256: string }> {
  const dest = path.join(root, 'wp-content', kind === 'plugin' ? 'plugins' : 'themes', folder)
  if (fs.existsSync(dest)) throw new Error(`${path.relative(root, dest)} already exists — remove it first (never overwritten in place)`)
  const tmp = fs.mkdtempSync(path.join(fs.existsSync(workDir) ? workDir : os.tmpdir(), 'pkg-'))
  try {
    let buf: Buffer
    if (/^https:\/\//.test(src)) {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${src}`)
      buf = Buffer.from(await res.arrayBuffer())
    } else buf = fs.readFileSync(src)
    if (buf.subarray(0, 2).toString() !== 'PK') throw new Error(`${src} is not a zip`)
    const zip = path.join(tmp, 'pkg.zip')
    fs.writeFileSync(zip, buf)
    execFileSync('unzip', ['-q', zip, '-d', path.join(tmp, 'x')])
    const unpacked = path.join(tmp, 'x', folder)
    if (!fs.existsSync(unpacked)) throw new Error(`Zip does not unpack to ${folder}/`)
    const header = kind === 'plugin' ? pluginHeader(unpacked) : readHeader(path.join(unpacked, 'style.css'))
    fs.cpSync(unpacked, dest, { recursive: true })
    return { installedTo: path.relative(root, dest), version: header['version'] ?? null, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function pluginHeader(dir: string): Record<string, string> {
  const main = fs.readdirSync(dir).filter((f) => f.endsWith('.php')).find((f) => readHeader(path.join(dir, f))['plugin name'])
  return main ? readHeader(path.join(dir, main)) : {}
}

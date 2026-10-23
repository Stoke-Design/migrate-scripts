/**
 * Offline WordPress cleanup for a locally saved cPanel backup. Safe by default: `audit` only reads.
 *
 *   pnpm wp:cleanup audit   <backup-dir> [--root <wp-root>] [--sql <dump>] [--verify-core]
 *   pnpm wp:cleanup remove  <backup-dir> [--root <wp-root>] --paths wp-content/plugins/foo,wp-config-sample.php   (or --file paths.json | paths.txt)
 *   pnpm wp:cleanup install <backup-dir> [--root <wp-root>] [--plugin-zip <url|path>] [--theme-zip …] [--child-zip …] [--themes elementor|always|never]
 *
 *   pnpm wp:cleanup webp    <backup-dir> [--root <wp-root>] [--sql <dump>] [--format webp|avif] [--quality 82] [--png-lossy] [--dry-run] [--again]
 *                           (--format avif encodes with ImageMagick at its default quality, always lossy; --quality and --png-lossy then do not apply)
 *
 * <backup-dir> is the extracted backup (holds homedir/public_html and mysql/). Reports, the unused-media list and the
 * quarantine of removed files always live in <backup-dir>/_wp-cleanup/, which wp-deploy reads next. Nothing is deleted outright.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  Findings, PACKAGES, WORK_DIR, findSqlDump, findWpRoots, installPackage, isElementorSite, listPlugins, listThemes, parseDump, readWpConfig, removeToQuarantine, scanCode, scanDevSites, scanJunk, scanPerformance, scanUploads, stokeStatus, verifyCore,
  type DumpInfo,
} from './lib'
import { checkCwebp, convertAll, countBy, findConvertedAttachments, listUploadImages, precheck, rewriteDump, setImageFormat, type ImageFormat } from './webp'

const [cmd, dirArg, ...rest] = process.argv.slice(2)
const opt = (n: string) => {
  const i = rest.indexOf(`--${n}`)
  return i >= 0 ? rest[i + 1] : undefined
}
const flag = (n: string) => rest.includes(`--${n}`)

function resolveSite() {
  if (!dirArg) throw new Error('Usage: wp-cleanup <audit|remove|install|webp> <backup-dir> [options]')
  const dir = path.resolve(dirArg)
  if (!fs.existsSync(dir)) throw new Error(`Not found: ${dir}`)
  const explicit = opt('root')
  let roots = explicit ? [path.resolve(dir, explicit)] : findWpRoots(dir)
  // Only public_html migrates; installs nested inside it are reported as dev-site candidates, not chosen.
  const main = roots.find((r) => r.endsWith(`${path.sep}homedir${path.sep}public_html`)) ?? roots.find((r) => path.basename(r) === 'public_html')
  if (!explicit && main) roots = [main]
  if (roots.length === 0) throw new Error('No WordPress install found (looked for a folder holding wp-content and wp-includes)')
  if (roots.length > 1) throw new Error(`Several WordPress installs found — pass --root <one of>:\n  ${roots.join('\n  ')}`)
  return { dir, root: roots[0]!, work: path.join(dir, WORK_DIR) }
}

async function buildReport(dir: string, root: string, work: string) {
  const cfg = readWpConfig(root)
  const sql = opt('sql') ? path.resolve(opt('sql')!) : findSqlDump(dir, cfg.dbName)
  let dump: DumpInfo | undefined
  if (sql) dump = await parseDump(sql, cfg.prefix)

  const plugins = listPlugins(root, dump?.activePlugins)
  const themes = listThemes(root, dump?.stylesheet)
  const elementor = isElementorSite(plugins, themes, dump)
  const junk = new Findings(500)
  const malware = new Findings()
  const leftovers = new Findings()
  scanJunk(root, junk)
  scanDevSites(root, junk)
  const uploads = scanUploads(root, junk, dump)
  if (uploads.orphans.length) {
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'orphaned-uploads.txt'), uploads.orphans.map((o) => o.path).join('\n') + '\n')
  }
  scanCode(root, malware, leftovers)
  const wpVersion = flag('verify-core') ? await verifyCore(root, malware) : 'not checked (--verify-core)'
  if (!fs.existsSync(path.join(root, 'wp-config.php'))) leftovers.add({ severity: 'low', rule: 'no-wp-config', path: 'wp-config.php', detail: 'Not found in the WP root', action: 'review' })

  return {
    generatedAt: new Date().toISOString(),
    root,
    dump: dump ? { ...dump, uploadRefs: undefined } : null,
    uploads: { orphanChecked: uploads.checked, orphanCount: uploads.orphans.length, orphanBytes: uploads.orphanBytes, listFile: uploads.orphans.length ? path.join(work, 'orphaned-uploads.txt') : null },
    wpVersion,
    elementor,
    wpConfig: cfg.constants,
    plugins,
    themes,
    stoke: stokeStatus(plugins, themes, elementor),
    junk: { items: junk.items, counts: junk.counts },
    malware: { items: malware.items, counts: malware.counts },
    leftovers: { items: leftovers.items, counts: leftovers.counts },
    performance: scanPerformance(root, plugins, cfg, dump),
  }
}
type Report = Awaited<ReturnType<typeof buildReport>>

async function audit() {
  const { dir, root, work } = resolveSite()
  const report = await buildReport(dir, root, work)
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2))
  const md = toMarkdown(report)
  fs.writeFileSync(path.join(work, 'report.md'), md)
  console.log(md)
  console.log(`\nFull report: ${path.join(work, 'report.json')}`)
}

function toMarkdown(r: Report): string {
  const mb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`)
  const L: string[] = []
  const section = (title: string, f: { items: { severity: string; rule: string; path: string; line?: number; detail?: string; size?: number }[]; counts: Record<string, number> }) => {
    L.push(`\n## ${title} (${Object.values(f.counts).reduce((a, b) => a + b, 0)})`)
    if (!f.items.length) L.push('None found.')
    const shown: Record<string, number> = {}
    for (const i of f.items) {
      shown[i.rule] = (shown[i.rule] ?? 0) + 1
      if (shown[i.rule]! > 8) continue // the rest are in report.json
      L.push(`- [${i.severity}] ${i.rule} — \`${i.path}${i.line ? `:${i.line}` : ''}\`${i.size ? ` (${mb(i.size)})` : ''}${i.detail ? ` — ${i.detail}` : ''}`)
    }
    for (const [rule, n] of Object.entries(f.counts)) if (n > 8) L.push(`- …${rule}: ${n} in total, first 8 shown (all in report.json)`)
  }
  L.push(`# WP cleanup audit\nRoot: \`${r.root}\`\nWordPress: ${r.wpVersion} · Elementor site: ${r.elementor ? 'yes' : 'no'} · Database dump: ${r.dump ? `${mb(r.dump.bytes)} (active plugins/theme known)` : 'not found (activity unknown — pass --sql)'}`)
  L.push('\n## Plugins')
  for (const p of r.plugins) L.push(`- ${p.slug} ${p.version ?? '?'} [${p.kind}]${p.active === undefined ? '' : p.active ? ' ACTIVE' : ' inactive'}${p.stoke ? ' STOKE' : ''} — ${mb(p.bytes)}${p.name ? '' : ' (no plugin header)'}`)
  L.push('\n## Themes')
  for (const t of r.themes) L.push(`- ${t.slug} ${t.version ?? '?'}${t.parent ? ` (child of ${t.parent})` : ''}${t.active ? ' ACTIVE' : ''}${t.isDefaultWpTheme ? ' default-WP' : ''} — custom code: ${t.customCode.verdict} (functions.php ${t.customCode.functionsPhpLines} lines, ${t.customCode.extraPhpCount} extra php, ${t.customCode.cssBytes}B css)`)
  if (r.dump?.hasCustomCss) L.push('- Customizer "Additional CSS" exists in the database — it will not survive a theme swap by itself.')
  L.push(`\n## Stoke packages\n- Plugin target ${r.stoke.plugin.target}: ${r.stoke.plugin.status}${r.stoke.plugin.activeAtSource.length ? ` (active at source: ${r.stoke.plugin.activeAtSource.join(', ')})` : ''}`)
  L.push(...(r.stoke.plan.length ? r.stoke.plan.map((p) => `- PLAN: ${p}`) : ['- Nothing to do.']))
  section('Junk, dev sites and uploads clutter', r.junk)
  const u = r.uploads
  L.push(u.orphanChecked ? `\n## Unused media in uploads\n${u.orphanCount} file(s), ${mb(u.orphanBytes)}, referenced by no attachment record or content in the database${u.listFile ? ` — full list: \`${u.listFile}\` (pass it to \`remove --file\`)` : ''}. Heuristic: media used only by theme/plugin code would be listed too, so confirm before removing.` : '\n## Unused media in uploads\nNot checked: needs the database dump (pass --sql).')
  section('Malware scan', r.malware)
  section('Synergy / cPanel leftovers', r.leftovers)
  L.push(`\n## Performance (${r.performance.length})`)
  for (const p of r.performance) L.push(`- [${p.severity}] ${p.rule} — ${p.detail}`)
  return L.join('\n')
}

async function remove() {
  const { root, work } = resolveSite()
  const file = opt('file') && path.resolve(opt('file')!)
  const rels = file ? (file.endsWith('.txt') ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : (JSON.parse(fs.readFileSync(file, 'utf8')) as string[])) : (opt('paths') ?? '').split(',').filter(Boolean)
  if (!rels.length) throw new Error('Nothing to remove: pass --paths a,b or --file paths.json (paths relative to the WP root)')
  const { moved, dest } = removeToQuarantine(root, work, rels)
  console.log(`Moved ${moved.length} item(s) to ${dest}\n${moved.map((m) => `  - ${m}`).join('\n')}\nTo undo, move them back; delete the folder when you are sure.`)
}

async function install() {
  const { root, work } = resolveSite()
  fs.mkdirSync(work, { recursive: true })
  const plugins = listPlugins(root)
  const themes = listThemes(root)
  const mode = opt('themes') ?? 'elementor'
  const wantThemes = mode === 'always' || (mode === 'elementor' && isElementorSite(plugins, themes))
  const jobs: ['plugin' | 'theme', string, string][] = [['plugin', opt('plugin-zip') ?? PACKAGES.plugin.url, PACKAGES.plugin.folder]]
  if (wantThemes) jobs.push(['theme', opt('theme-zip') ?? PACKAGES.theme.url, PACKAGES.theme.folder], ['theme', opt('child-zip') ?? PACKAGES.child.url, PACKAGES.child.folder])
  for (const [kind, src, folder] of jobs) {
    try {
      const r = await installPackage(root, work, kind, src, folder)
      console.log(`installed ${r.installedTo} v${r.version ?? '?'} (sha256 ${r.sha256.slice(0, 16)}…) — left INACTIVE`)
    } catch (e) {
      console.log(`SKIPPED ${folder}: ${(e as Error).message}`)
    }
  }
}

/** JPEG/PNG to WebP, with a rewritten copy of the dump. The original dump is never edited. */
async function webp() {
  const { dir, root, work } = resolveSite()
  const format = (opt('format') ?? 'webp') as ImageFormat
  if (format !== 'webp' && format !== 'avif') throw new Error('--format must be webp or avif')
  setImageFormat(format)
  const quality = Number(opt('quality') ?? 82)
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error('--quality must be 1 to 100')
  const opts = { quality, pngLossy: flag('png-lossy') }
  const dry = flag('dry-run')
  const cfg = readWpConfig(root)
  const sql = opt('sql') ? path.resolve(opt('sql')!) : findSqlDump(dir, cfg.dbName)
  if (!sql) throw new Error('No SQL dump found. Pass --sql <dump>: converting the files without rewriting the database would break every image URL.')
  const outDir = path.join(work, 'webp')
  const out = path.join(outDir, path.basename(sql))
  const reportFile = path.join(outDir, 'report.json')
  const again = flag('again')
  if (fs.existsSync(reportFile) && !again && !dry) throw new Error(`Already converted (${reportFile}). Run it once; pass --again only if you really want a second pass.`)
  // A second pass must start from the first pass's dump, or it would throw its rewrites away.
  const input = again && fs.existsSync(out) ? out : sql

  const images = listUploadImages(root)
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`
  const total = images.reduce((a, i) => a + i.bytes, 0)
  const settings = format === 'avif' ? 'AVIF via ImageMagick, default quality, lossy' : `Quality ${quality}${opts.pngLossy ? ', PNG lossy' : ', PNG lossless'}`
  console.log(`${images.length} JPEG/PNG file(s) in wp-content/uploads/YYYY/MM, ${mb(total)}. ${settings}. Dump: ${input}`)

  if (dry) {
    const skipped = images.map(precheck).filter((s): s is NonNullable<typeof s> => s !== null)
    console.log(`Dry run, nothing written. ${images.length - skipped.length} would be attempted; ${skipped.length} skipped already: ${JSON.stringify(countBy(skipped, (s) => s.reason))}`)
    console.log(`Files that turn out larger as ${format.toUpperCase()} are also left as they are, so the final count and saving are known only after the real run (usually about 25 to 40 percent smaller${format === 'avif' ? ' for WebP; AVIF is often a little smaller again' : ''}).`)
    return
  }

  console.log(checkCwebp())
  fs.mkdirSync(outDir, { recursive: true })
  const { converted, skipped, created } = await convertAll(images, opts, undefined, (d, n) => {
    if (d % 500 === 0) console.error(`  ${d}/${n}`)
  })
  let stats
  const tmp = `${out}.new`
  try {
    const conv = new Map(converted.map((c) => [c.path, c.to]))
    const ids = await findConvertedAttachments(input, conv)
    stats = await rewriteDump(input, tmp, cfg.prefix, conv, ids)
    fs.renameSync(tmp, out)
  } catch (e) {
    for (const f of created) fs.rmSync(f, { force: true })
    fs.rmSync(tmp, { force: true })
    throw new Error(`Dump rewrite failed, the new .${format} files were removed and the originals are untouched: ${(e as Error).message}`)
  }
  const { dest } = converted.length ? removeToQuarantine(root, work, converted.map((c) => `wp-content/uploads/${c.path}`)) : { dest: null }
  if (fs.existsSync(reportFile)) fs.renameSync(reportFile, path.join(outDir, `report-before-${Date.now()}.json`))
  const before = converted.reduce((a, c) => a + c.before, 0)
  const after = converted.reduce((a, c) => a + c.after, 0)
  fs.writeFileSync(reportFile, JSON.stringify({ generatedAt: new Date().toISOString(), format, options: opts, input, output: out, quarantine: dest, totals: { converted: converted.length, bytesBefore: before, bytesAfter: after, skipped: countBy(skipped, (s) => s.reason) }, rewrite: stats, converted, skipped }, null, 2))
  console.log(`Converted ${converted.length} of ${images.length}: ${mb(before)} -> ${mb(after)} (saved ${mb(before - after)}).`)
  console.log(`Left as they are: ${skipped.length} ${JSON.stringify(countBy(skipped, (s) => s.reason))}`)
  console.log(`Dump rewrite: ${stats.textRewrites} text reference(s), ${stats.metadataRows} attachment metadata row(s), ${stats.mimeChanged} mime type(s), ${stats.serializedFixed} serialized length(s) fixed${stats.metadataFallback ? `, ${stats.metadataFallback} metadata value(s) NOT parsed (check them)` : ''}.`)
  console.log(`Rewritten dump:  ${out}\nQuarantine:      ${dest ?? '(nothing moved)'}\nReport:          ${reportFile}\nwp-deploy must import the rewritten dump, not the original.`)
}

const main = cmd === 'audit' ? audit : cmd === 'remove' ? remove : cmd === 'install' ? install : cmd === 'webp' ? webp : null
if (!main) {
  console.error('Usage: wp-cleanup <audit|remove|install|webp> <backup-dir> [options] (see header of scripts/wp-cleanup/cli.ts)')
  process.exit(2)
}
main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})

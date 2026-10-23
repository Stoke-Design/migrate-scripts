/**
 * Offline media -> WebP for a locally saved cPanel backup (the `webp` command of the wp-cleanup CLI).
 *
 * Converts every JPEG/PNG in wp-content/uploads/YYYY/MM with `cwebp`, writes a REWRITTEN COPY of the SQL dump
 * that points at the new files, and moves the originals into the wp-cleanup quarantine. The original dump is
 * never edited. Nothing here needs PHP, WP-CLI or a database server.
 *
 * The dump is handled as latin1 (one char = one byte) so PHP-serialized string lengths, which count bytes, can be
 * recomputed exactly without decoding UTF-8.
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'

export const IMG_EXT = /\.(jpe?g|png)$/i

// ---------- files ----------

export interface UploadImage {
  /** 'YYYY/MM/name.ext', relative to wp-content/uploads */
  rel: string
  abs: string
  bytes: number
}

/** Every .jpg/.jpeg/.png directly inside wp-content/uploads/YYYY/MM (originals and generated sizes). */
export function listUploadImages(root: string): UploadImage[] {
  const uploads = path.join(root, 'wp-content', 'uploads')
  const out: UploadImage[] = []
  const dirs = (p: string, re: RegExp) => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && re.test(d.name)).map((d) => d.name) : [])
  for (const y of dirs(uploads, /^\d{4}$/)) {
    for (const m of dirs(path.join(uploads, y), /^\d{2}$/)) {
      const dir = path.join(uploads, y, m)
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile() || !IMG_EXT.test(e.name)) continue
        const abs = path.join(dir, e.name)
        out.push({ rel: `${y}/${m}/${e.name}`, abs, bytes: fs.statSync(abs).size })
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** Target format of the run. WebP via cwebp by default; AVIF via ImageMagick (`--format avif`). */
export type ImageFormat = 'webp' | 'avif'
let FORMAT: ImageFormat = 'webp'
export const setImageFormat = (f: ImageFormat) => {
  FORMAT = f
}
export const imageMime = () => `image/${FORMAT}`

/** Name of the converted file in the current target format (the function is named webpName for history). */
// AVIF keeps the source extension (photo.jpg -> photo.jpg.avif) so the original format stays visible; WebP replaces it.
export const webpName = (name: string) => (FORMAT === 'avif' ? (IMG_EXT.test(name) ? `${name}.avif` : name) : name.replace(IMG_EXT, `.${FORMAT}`))

/** EXIF orientation of a JPEG (1 = upright), or undefined when there is no EXIF block. cwebp ignores this tag. */
export function jpegOrientation(file: string): number | undefined {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(65536)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined
    let i = 2
    while (i + 4 < n) {
      if (buf[i] !== 0xff) return undefined
      const marker = buf[i + 1]!
      if (marker === 0xda || marker === 0xd9) return undefined // start of scan / end of image: no EXIF before it
      const len = buf.readUInt16BE(i + 2)
      if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10 // TIFF header
        const le = buf.toString('latin1', t, t + 2) === 'II'
        const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
        const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
        const ifd = t + u32(t + 4)
        if (ifd + 2 > n) return undefined
        const count = u16(ifd)
        for (let k = 0; k < count; k++) {
          const e = ifd + 2 + k * 12
          if (e + 12 > n) return undefined
          if (u16(e) === 0x0112) return u16(e + 8)
        }
        return undefined
      }
      i += 2 + len
    }
    return undefined
  } finally {
    fs.closeSync(fd)
  }
}

// ---------- text rewriting (dump lines) ----------

export type Conversions = Map<string, string> // 'YYYY/MM/name.ext' -> 'YYYY/MM/name.webp'

export interface RewriteStats {
  textRewrites: number
  serializedFixed: number
  metadataRows: number
  metadataFallback: number
  mimeChanged: number
}
export const newStats = (): RewriteStats => ({ textRewrites: 0, serializedFixed: 0, metadataRows: 0, metadataFallback: 0, mimeChanged: 0 })

/** A path like 2024/01/photo.jpg, written with plain, JSON-escaped (\/) or SQL-escaped JSON (\\/) slashes. */
const PATH_RE = /(\d{4})(\\\\\/|\\\/|\/)(\d{2})\2([^"'\\/\s<>?#]+?\.(?:jpe?g|png))(?![A-Za-z0-9]|\.(?:webp|avif))/gi

/** Replaces references to converted files in free text. Pure: no serialized-length handling. */
export function makeTextRewriter(conv: Conversions, stats: RewriteStats = newStats()) {
  return (s: string): string =>
    s.replace(PATH_RE, (whole, y: string, sep: string, m: string, name: string) => {
      let hit = conv.has(`${y}/${m}/${name}`)
      if (!hit) {
        try {
          hit = conv.has(`${y}/${m}/${decodeURIComponent(name)}`)
        } catch {
          /* not URL-encoded */
        }
      }
      if (!hit) return whole
      stats.textRewrites++
      return `${y}${sep}${m}${sep}${webpName(name)}`
    })
}

/** Bytes in an SQL-escaped string: a backslash pair is one byte. */
export function sqlByteLength(escaped: string): number {
  let n = 0
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '\\') i++
    n++
  }
  return n
}

/**
 * Applies `plain` to a dump line while keeping PHP-serialized strings valid: each `s:N:\"...\";` in SQL-escaped
 * form is read using its ORIGINAL length, rewritten, and written back with the recomputed length.
 * Strings nested inside another serialized string are not re-measured (see README: known limits).
 */
export function rewriteSerializedAware(text: string, plain: (s: string) => string, stats?: RewriteStats): string {
  const re = /s:(\d+):\\"/g
  let out = ''
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length
    const want = Number(m[1])
    let i = start
    let bytes = 0
    while (bytes < want && i < text.length) {
      i += text[i] === '\\' ? 2 : 1
      bytes++
    }
    if (bytes !== want || !text.startsWith('\\";', i)) {
      re.lastIndex = m.index + 1
      continue
    }
    const content = text.slice(start, i)
    const next = plain(content)
    out += plain(text.slice(last, m.index))
    if (next === content) out += text.slice(m.index, i + 3)
    else {
      out += `s:${sqlByteLength(next)}:\\"${next}\\";`
      if (stats) stats.serializedFixed++
    }
    last = i + 3
    re.lastIndex = last
  }
  return out + plain(text.slice(last))
}

// ---------- PHP serialize (just enough for _wp_attachment_metadata) ----------

type PhpNode = { t: 'a'; items: { k: PhpNode; v: PhpNode }[] } | { t: 's'; v: string } | { t: 'raw'; v: string }

/** Parses PHP-serialized arrays of strings/numbers/null/bool. Returns null on anything else. */
export function phpParse(src: string): PhpNode | null {
  let i = 0
  const readUntil = (ch: string) => {
    const j = src.indexOf(ch, i)
    if (j < 0) throw new Error('eof')
    const s = src.slice(i, j)
    i = j + 1
    return s
  }
  const value = (): PhpNode => {
    const type = src[i]
    if (type === 's') {
      i += 2
      const len = Number(readUntil(':'))
      if (src[i] !== '"') throw new Error('s')
      const v = src.slice(i + 1, i + 1 + len)
      i += 1 + len
      if (src.slice(i, i + 2) !== '";') throw new Error('s-end')
      i += 2
      return { t: 's', v }
    }
    if (type === 'a') {
      i += 2
      const n = Number(readUntil(':'))
      if (src[i] !== '{') throw new Error('a')
      i++
      const items: { k: PhpNode; v: PhpNode }[] = []
      for (let k = 0; k < n; k++) items.push({ k: value(), v: value() })
      if (src[i] !== '}') throw new Error('a-end')
      i++
      return { t: 'a', items }
    }
    if (type === 'i' || type === 'd' || type === 'b') {
      const start = i
      readUntil(';')
      return { t: 'raw', v: src.slice(start, i) }
    }
    if (type === 'N' && src[i + 1] === ';') {
      i += 2
      return { t: 'raw', v: 'N;' }
    }
    throw new Error('type')
  }
  try {
    const v = value()
    return i === src.length ? v : null
  } catch {
    return null
  }
}

export function phpSerialize(n: PhpNode): string {
  if (n.t === 'raw') return n.v
  if (n.t === 's') return `s:${n.v.length}:"${n.v}";`
  return `a:${n.items.length}:{${n.items.map((e) => phpSerialize(e.k) + phpSerialize(e.v)).join('')}}`
}

const field = (arr: PhpNode, key: string) => (arr.t === 'a' ? arr.items.find((e) => e.k.t === 's' && e.k.v === key)?.v : undefined)

/** Points an attachment's metadata (file, sizes, original_image, mime types) at the converted files. */
export function rewriteMetadata(meta: PhpNode, conv: Conversions): boolean {
  let changed = false
  const file = field(meta, 'file')
  if (!file || file.t !== 's') return false
  const dir = file.v.includes('/') ? file.v.slice(0, file.v.lastIndexOf('/') + 1) : ''
  if (conv.has(file.v)) {
    file.v = conv.get(file.v)!
    changed = true
  }
  const orig = field(meta, 'original_image')
  if (orig && orig.t === 's' && conv.has(dir + orig.v)) {
    orig.v = webpName(orig.v)
    changed = true
  }
  const sizes = field(meta, 'sizes')
  if (sizes && sizes.t === 'a') {
    for (const { v: size } of sizes.items) {
      const f = field(size, 'file')
      if (!f || f.t !== 's' || !conv.has(dir + f.v)) continue
      f.v = webpName(f.v)
      const mime = field(size, 'mime-type')
      if (mime && mime.t === 's' && /^image\/(jpeg|png)$/.test(mime.v)) mime.v = imageMime()
      changed = true
    }
  }
  return changed
}

// ---------- SQL strings ----------

const UNESC: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' }
export function unescapeSql(s: string): string {
  return s.replace(/\\(.)|''/gs, (m, c: string | undefined) => (c === undefined ? "'" : (UNESC[c] ?? c)))
}
export function escapeSql(s: string): string {
  return s.replace(/[\0\n\r\\'"\x1a]/g, (c) => ({ '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '"': '\\"', '\x1a': '\\Z' })[c]!)
}

/** Index just past the closing quote of an SQL string whose first content char is at `from`. */
function endOfSqlString(line: string, from: number): number {
  let j = from
  while (j < line.length) {
    const c = line[j]
    if (c === '\\') j += 2
    else if (c === "'") {
      if (line[j + 1] === "'") j += 2
      else return j
    } else j++
  }
  return -1
}

/** Calls fn on each top-level "(...)" tuple of an INSERT line, copying everything else through. */
export function mapTuples(line: string, fn: (tuple: string) => string): string {
  let out = ''
  let i = 0
  const valuesAt = line.startsWith('INSERT INTO') ? line.indexOf(' VALUES ') : -1
  if (valuesAt >= 0) {
    out = line.slice(0, valuesAt + 8)
    i = valuesAt + 8
  }
  while (i < line.length) {
    if (line[i] !== '(') {
      out += line[i++]
      continue
    }
    let j = i + 1
    let depth = 1
    while (j < line.length && depth > 0) {
      const c = line[j]
      if (c === "'") {
        const e = endOfSqlString(line, j + 1)
        if (e < 0) return out + line.slice(i)
        j = e + 1
      } else {
        if (c === '(') depth++
        else if (c === ')') depth--
        j++
      }
    }
    out += fn(line.slice(i, j))
    i = j
  }
  return out
}

const META_MARK = "'_wp_attachment_metadata','"

export interface LineContext {
  conv: Conversions
  /** post IDs whose _wp_attached_file was converted */
  attachmentIds: Set<string>
  stats: RewriteStats
}

/** Rewrites a line containing _wp_attachment_metadata rows, parsing each metadata value properly. */
function rewriteMetaLine(line: string, ctx: LineContext, plain: (s: string) => string): string {
  let out = ''
  let pos = 0
  for (let at = line.indexOf(META_MARK); at >= 0; at = line.indexOf(META_MARK, pos)) {
    const start = at + META_MARK.length
    const end = endOfSqlString(line, start)
    if (end < 0) break
    out += rewriteSerializedAware(line.slice(pos, start), plain, ctx.stats)
    const escaped = line.slice(start, end)
    const tree = phpParse(unescapeSql(escaped))
    if (tree && rewriteMetadata(tree, ctx.conv)) {
      out += escapeSql(phpSerialize(tree))
      ctx.stats.metadataRows++
    } else if (tree) out += escaped
    else {
      out += rewriteSerializedAware(escaped, plain, ctx.stats)
      ctx.stats.metadataFallback++
    }
    pos = end
  }
  return out + rewriteSerializedAware(line.slice(pos), plain, ctx.stats)
}

export type TableKind = 'posts' | 'postmeta' | null

/** Rewrites one dump line. `kind` is the table of the INSERT the line belongs to. */
export function rewriteDumpLine(line: string, kind: TableKind, ctx: LineContext, plain = makeTextRewriter(ctx.conv, ctx.stats)): string {
  const hasImg = /\.(?:jpe?g|png)/i.test(line)
  if (kind === 'posts' && ctx.attachmentIds.size > 0 && line.includes("'attachment'")) {
    return mapTuples(line, (t) => {
      const id = /^\((\d+),/.exec(t)?.[1]
      let next = t
      if (id && ctx.attachmentIds.has(id)) {
        const m = next.replace(/,'image\/(?:jpeg|png)',/, `,'${imageMime()}',`)
        if (m !== next) ctx.stats.mimeChanged++
        next = m
      }
      return hasImg ? rewriteSerializedAware(next, plain, ctx.stats) : next
    })
  }
  if (!hasImg) return line
  if (line.includes(META_MARK)) return rewriteMetaLine(line, ctx, plain)
  return rewriteSerializedAware(line, plain, ctx.stats)
}

// ---------- dump streaming ----------

const ATTACHED = /\((\d+),(\d+),'_wp_attached_file','((?:[^'\\]|\\.)*)'\)/g

function openDump(file: string): readline.Interface {
  const raw = fs.createReadStream(file)
  const stream = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw
  stream.setEncoding('latin1')
  return readline.createInterface({ input: stream, crlfDelay: Infinity })
}

/** Pass 1: which attachments had their main file converted. */
export async function findConvertedAttachments(dumpFile: string, conv: Conversions): Promise<Set<string>> {
  const ids = new Set<string>()
  for await (const line of openDump(dumpFile)) {
    if (!line.includes("'_wp_attached_file'")) continue
    for (const m of line.matchAll(ATTACHED)) if (conv.has(unescapeSql(m[3]!))) ids.add(m[2]!)
  }
  return ids
}

/** Pass 2: stream the dump through the rewriter into `outFile` (gzipped when the input is). */
export async function rewriteDump(dumpFile: string, outFile: string, prefix: string, conv: Conversions, attachmentIds: Set<string>): Promise<RewriteStats> {
  const stats = newStats()
  const ctx: LineContext = { conv, attachmentIds, stats }
  const plain = makeTextRewriter(conv, stats)
  const heads = { posts: `INSERT INTO \`${prefix}posts\``, postmeta: `INSERT INTO \`${prefix}postmeta\`` }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const sink = fs.createWriteStream(outFile)
  const gz = dumpFile.endsWith('.gz') ? zlib.createGzip() : null
  if (gz) gz.pipe(sink)
  const target = gz ?? sink
  const done = new Promise<void>((resolve, reject) => {
    sink.on('finish', resolve)
    sink.on('error', reject)
    gz?.on('error', reject)
  })
  let kind: TableKind = null
  try {
    for await (const line of openDump(dumpFile)) {
      if (line.startsWith('INSERT INTO `')) kind = line.startsWith(heads.posts) ? 'posts' : line.startsWith(heads.postmeta) ? 'postmeta' : null
      else if (!line.startsWith('(')) kind = null
      const next = rewriteDumpLine(line, kind, ctx, plain)
      if (line.endsWith(';')) kind = null
      if (!target.write(next + '\n', 'latin1')) await new Promise<void>((r) => target.once('drain', () => r()))
    }
    target.end()
    await done
  } catch (e) {
    target.destroy()
    fs.rmSync(outFile, { force: true })
    throw e
  }
  return stats
}

// ---------- conversion ----------

export type SkipReason = 'webp-not-smaller' | 'webp-exists' | 'exif-rotated' | 'cwebp-failed'

export interface Converted {
  path: string
  to: string
  before: number
  after: number
}
export interface Skipped {
  path: string
  reason: SkipReason
  detail?: string
}

export interface WebpOptions {
  quality: number
  pngLossy: boolean
}

export const cwebpBinary = () => process.env.CWEBP || 'cwebp'

export const magickBinary = () => process.env.MAGICK || 'magick'

export function checkCwebp(): string {
  if (FORMAT === 'avif') {
    try {
      const v = execFileSync(magickBinary(), ['-version'], { encoding: 'utf8' }).trim().split('\n')[0]!
      const formats = execFileSync(magickBinary(), ['-list', 'format'], { encoding: 'utf8' })
      if (!/^\s*AVIF\*?\s.*rw/m.test(formats)) throw new Error('no AVIF write support')
      return v
    } catch {
      throw new Error('ImageMagick with AVIF support not found. Install it with `brew install imagemagick`, then check `magick -list format | grep AVIF`.')
    }
  }
  try {
    return execFileSync(cwebpBinary(), ['-version'], { encoding: 'utf8' }).trim().split('\n')[0]!
  } catch {
    throw new Error('cwebp not found. Install it with `brew install webp`, then check `cwebp -version`.')
  }
}

function runCwebp(src: string, dest: string, opts: WebpOptions, png: boolean): Promise<string | null> {
  // AVIF: ImageMagick at its default quality and speed, always lossy, longest side capped at 2560px (shrink only; PNG alpha is kept in the AVIF alpha channel).
  const [bin, args] =
    FORMAT === 'avif'
      ? [magickBinary(), [src, '-resize', '2560x2560>', dest]]
      : [cwebpBinary(), png && !opts.pngLossy ? ['-quiet', '-lossless', '-z', '9', src, '-o', dest] : ['-quiet', '-q', String(opts.quality), '-m', '6', src, '-o', dest]]
  return new Promise((resolve) => execFile(bin, args, { maxBuffer: 1 << 20 }, (err, _o, stderr) => resolve(err ? (stderr || err.message).toString().trim().slice(0, 200) : null)))
}

/** Cheap checks shared by the dry run and the real run. */
export function precheck(img: UploadImage): Skipped | null {
  const dest = path.join(path.dirname(img.abs), webpName(path.basename(img.abs)))
  if (fs.existsSync(dest)) return { path: img.rel, reason: 'webp-exists' }
  if (/\.jpe?g$/i.test(img.rel)) {
    const o = jpegOrientation(img.abs)
    if (o !== undefined && o !== 1) return { path: img.rel, reason: 'exif-rotated', detail: `orientation ${o}` }
  }
  return null
}

export async function convertAll(
  images: UploadImage[],
  opts: WebpOptions,
  concurrency = Math.min(8, Math.max(1, os.cpus().length - 1)),
  onProgress?: (done: number, total: number) => void,
): Promise<{ converted: Converted[]; skipped: Skipped[]; created: string[] }> {
  const converted: Converted[] = []
  const skipped: Skipped[] = []
  const created: string[] = []
  // photo.jpg and photo.png would both become photo.webp: convert the first, skip the rest.
  const taken = new Set<string>()
  const queue: UploadImage[] = []
  for (const img of images) {
    const dest = webpName(img.rel)
    if (taken.has(dest)) skipped.push({ path: img.rel, reason: 'webp-exists', detail: 'another image would become the same .webp name' })
    else {
      taken.add(dest)
      queue.push(img)
    }
  }
  let done = 0
  const worker = async () => {
    for (let img = queue.shift(); img; img = queue.shift()) {
      const skip = precheck(img)
      if (skip) skipped.push(skip)
      else {
        const dest = path.join(path.dirname(img.abs), webpName(path.basename(img.abs)))
        const err = await runCwebp(img.abs, dest, opts, /\.png$/i.test(img.rel))
        if (err !== null || !fs.existsSync(dest)) {
          fs.rmSync(dest, { force: true })
          skipped.push({ path: img.rel, reason: 'cwebp-failed', detail: err ?? 'no output' })
        } else {
          const after = fs.statSync(dest).size
          if (after >= img.bytes) {
            fs.rmSync(dest, { force: true })
            skipped.push({ path: img.rel, reason: 'webp-not-smaller', detail: `${img.bytes} -> ${after} bytes` })
          } else {
            created.push(dest)
            converted.push({ path: img.rel, to: webpName(img.rel), before: img.bytes, after })
          }
        }
      }
      onProgress?.(++done, images.length)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { converted: converted.sort((a, b) => a.path.localeCompare(b.path)), skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)), created }
}

export const countBy = <T>(items: T[], key: (t: T) => string) => items.reduce<Record<string, number>>((acc, t) => ((acc[key(t)] = (acc[key(t)] ?? 0) + 1), acc), {})

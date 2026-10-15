/**
 * Offline PNG/JPEG -> WebP conversion of a WordPress media library saved on disk (extracted cPanel backup).
 * Converts every wp-content/uploads/YYYY/MM/*.{jpg,jpeg,png} (originals and generated sizes) with `cwebp`, writes a
 * *rewritten copy* of the SQL dump with every reference updated (URLs, `_wp_attached_file`, `_wp_attachment_metadata`,
 * attachment mime types, PHP-serialized string lengths), then moves the originals into the quarantine. The original
 * dump is never edited.
 */
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { removeToQuarantine } from './lib'

const run = promisify(execFile)
const SRC = /\.(jpe?g|png)$/i
const DATED = /^\d{4}\/\d{2}\//

export interface WebpOptions {
  quality: number
  pngLossy: boolean
  dryRun: boolean
}
export interface WebpResult {
  candidates: number
  candidateBytes: number
  converted: { from: string; to: string; before: number; after: number }[] // paths relative to wp-content/uploads
  skipped: { path: string; reason: string }[]
  dump?: { out: string; changedLines: number }
  quarantine?: string
}

// ---------- dump rewriting (pure, unit-tested) ----------

const UNESC: Record<string, string> = { '0': '\0', n: '\n', r: '\r', b: '\b', t: '\t', Z: '\x1a' }
const unesc = (s: string) => s.replace(/\\([\s\S])/g, (m, c: string) => (c in UNESC ? UNESC[c]! : c === '%' || c === '_' ? m : c))
const ESC: Record<string, string> = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' }
const esc = (s: string) => s.replace(/[\0\n\r\x1a'"\\]/g, (c) => ESC[c] ?? `\\${c}`)

const LITERAL = /'([^'\\]*(?:\\.[^'\\]*)*)'/g
// uploads/2024/01/name.jpg, also with JSON-escaped slashes (uploads\/2024\/01\/name.jpg)
const URL_REF = /uploads\\?\/(\d{4})\\?\/(\d{2})\\?\/([^\s"'\\<>)?#,;&|]+?)\.(jpe?g|png)(?![\w-]|\.webp)/gi
const GUID = /^https?:\S*?uploads\/(\d{4}\/\d{2}\/[^\s?#]+\.(?:jpe?g|png))$/i
const META = /s:4:"file";s:\d+:"([^"]*)";|s:14:"original_image";s:\d+:"([^"]*)";|s:9:"mime-type";s:\d+:"image\/(?:jpeg|png)";/g

/** Rewrites `s:N:"…";` strings (recursively, for serialized data inside serialized data) with correct lengths. */
function rewriteSerialized(s: string, rewrite: (plain: string) => string): string {
  const re = /s:(\d+):"/g
  let out = ''
  let pos = 0
  for (let m; (m = re.exec(s)); ) {
    const start = m.index + m[0].length
    const end = start + Number(m[1])
    if (s.slice(end, end + 2) !== '";') continue // not a real serialized string
    const inner = rewriteSerialized(s.slice(start, end), rewrite)
    out += `${rewrite(s.slice(pos, m.index))}s:${inner.length}:"${inner}";`
    pos = re.lastIndex = end + 2
  }
  return out + rewrite(s.slice(pos))
}

/**
 * Returns a function that rewrites one line of a mysqldump. `converted` holds the uploads-relative paths that became
 * WebP ("2024/01/photo.jpg"). The line is treated as latin1 (1 char = 1 byte) so serialized lengths are byte lengths;
 * pass keys through `latin1()` if they contain non-ASCII.
 */
export function makeRewriter(converted: Set<string>): (line: string) => string {
  const toWebp = (p: string) => p.replace(SRC, '.webp')
  const swapUrls = (t: string) => t.replace(URL_REF, (m, y, mo, name, ext) => (converted.has(`${y}/${mo}/${name}.${ext}`) ? `${m.slice(0, -ext.length)}webp` : m))
  const swapMeta = (s: string) => {
    const dir = /s:4:"file";s:\d+:"([^"]*)\/[^"/]*";/.exec(s)?.[1] ?? ''
    let hit = false
    return s.replace(META, (m, file?: string, orig?: string) => {
      const name = file ?? orig
      if (name === undefined) return hit ? 's:9:"mime-type";s:10:"image/webp";' : m // mime-type belongs to the file entry just above it
      hit = converted.has(name.includes('/') ? name : `${dir}/${name}`)
      if (!hit) return m
      const n = toWebp(name)
      return `s:${file !== undefined ? '4:"file"' : '14:"original_image"'};s:${n.length}:"${n}";`
    })
  }
  return (line) => {
    if (!(line.startsWith('INSERT INTO `') || line.startsWith('('))) return line
    if (!line.includes('uploads') && !line.includes('_wp_attach')) return line
    let prev = ''
    let guid = '' // uploads path of the attachment row being read; its guid comes before its post_mime_type
    return line.replace(LITERAL, (whole, raw: string) => {
      const before = prev
      prev = raw
      let next = raw
      if (before === '_wp_attached_file') next = converted.has(raw) ? toWebp(raw) : raw
      else if (before === '_wp_attachment_metadata') next = esc(swapMeta(unesc(raw)))
      else if (before === 'attachment') {
        if (/^image\/(jpeg|png)$/.test(raw) && converted.has(guid)) next = 'image/webp'
        guid = ''
      } else if (raw.includes('uploads')) {
        const plain = unesc(raw)
        guid = GUID.exec(plain)?.[1] ?? guid
        const swapped = rewriteSerialized(plain, swapUrls)
        if (swapped !== plain) next = esc(swapped)
      }
      return next === raw ? whole : `'${next}'`
    })
  }
}

/** Streams `inFile` (.sql or .sql.gz) through `rewrite` into `outFile`, byte-for-byte except for rewritten lines. */
export async function rewriteDump(inFile: string, outFile: string, rewrite: (line: string) => string): Promise<number> {
  const raw = fs.createReadStream(inFile)
  const src = inFile.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw
  src.setEncoding('latin1') // keep bytes 1:1 so non-UTF-8 dumps survive
  const file = fs.createWriteStream(outFile)
  const out = outFile.endsWith('.gz') ? zlib.createGzip() : file
  if (out !== file) out.pipe(file)
  let changed = 0
  for await (const line of readline.createInterface({ input: src, crlfDelay: Infinity })) {
    const r = rewrite(line)
    if (r !== line) changed++
    if (!out.write(`${r}\n`, 'latin1')) await once(out, 'drain')
  }
  out.end()
  await once(file, 'finish')
  return changed
}

// ---------- file conversion ----------

/** EXIF orientation of a JPEG (1 = upright). cwebp ignores the tag, so rotated photos would come out sideways. */
function exifOrientation(file: string): number {
  try {
    const fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(65536)
    const n = fs.readSync(fd, b, 0, b.length, 0)
    fs.closeSync(fd)
    const t = b.subarray(0, n).indexOf('Exif\0\0') + 6
    if (t < 6) return 1
    const le = b.toString('latin1', t, t + 2) === 'II'
    const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
    const ifd = t + (le ? b.readUInt32LE(t + 4) : b.readUInt32BE(t + 4))
    for (let k = 0, cnt = u16(ifd); k < cnt; k++) if (u16(ifd + 2 + k * 12) === 0x0112) return u16(ifd + 2 + k * 12 + 8)
  } catch {
    /* unreadable EXIF: treat as upright */
  }
  return 1
}

export const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1')

export async function convertUploads(root: string, work: string, dumpFile: string, o: WebpOptions): Promise<WebpResult> {
  const up = path.join(root, 'wp-content', 'uploads')
  const res: WebpResult = { candidates: 0, candidateBytes: 0, converted: [], skipped: [] }
  const files = fs
    .readdirSync(up, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => DATED.test(p) && SRC.test(p) && fs.lstatSync(path.join(up, p)).isFile())
    .sort()
  res.candidates = files.length
  for (const f of files) res.candidateBytes += fs.statSync(path.join(up, f)).size
  if (o.dryRun) return res

  try {
    await run('cwebp', ['-version'])
  } catch {
    throw new Error('cwebp not found. Install it with: brew install webp')
  }
  const claimed = new Set<string>()
  const queue = files.filter((f) => {
    const to = f.replace(SRC, '.webp')
    const reason = claimed.has(to) || fs.existsSync(path.join(up, to)) ? 'a .webp with that name already exists' : /\.jpe?g$/i.test(f) && exifOrientation(path.join(up, f)) !== 1 ? 'EXIF-rotated JPEG (cwebp would drop the rotation)' : ''
    if (reason) res.skipped.push({ path: f, reason })
    else claimed.add(to)
    return !reason
  })
  const one = async (f: string) => {
    const src = path.join(up, f)
    const to = f.replace(SRC, '.webp')
    const tmp = `${path.join(up, to)}.tmp`
    const isPng = /\.png$/i.test(f)
    const args = ['-quiet', '-metadata', 'icc', ...(isPng && !o.pngLossy ? ['-lossless', '-z', '6'] : ['-q', String(o.quality), '-alpha_q', '100']), src, '-o', tmp]
    try {
      await run('cwebp', args)
      const before = fs.statSync(src).size
      const after = fs.statSync(tmp).size
      if (after >= before) res.skipped.push({ path: f, reason: 'WebP is not smaller' })
      else {
        fs.renameSync(tmp, path.join(up, to))
        res.converted.push({ from: f, to, before, after })
      }
    } catch (e) {
      res.skipped.push({ path: f, reason: `cwebp failed: ${String((e as Error).message).split('\n').find((l) => l.trim() && !l.startsWith('Command failed')) ?? 'unknown'}` })
    }
    fs.rmSync(tmp, { force: true })
  }
  const pending = [...queue]
  await Promise.all(Array.from({ length: os.availableParallelism() }, async () => { for (let f; (f = pending.shift()); ) await one(f) }))
  res.converted.sort((a, b) => a.from.localeCompare(b.from))
  res.skipped.sort((a, b) => a.path.localeCompare(b.path))

  const outDir = path.join(work, 'webp')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, path.basename(dumpFile))
  try {
    const changedLines = await rewriteDump(dumpFile, out, makeRewriter(new Set(res.converted.map((c) => latin1(c.from)))))
    res.dump = { out, changedLines }
  } catch (e) {
    // nothing is lost yet: originals are still in place, so undo the half-finished conversion
    for (const c of res.converted) fs.rmSync(path.join(up, c.to), { force: true })
    fs.rmSync(out, { force: true })
    throw e
  }
  res.quarantine = removeToQuarantine(root, work, res.converted.map((c) => `wp-content/uploads/${c.from}`)).dest
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(res, null, 2))
  return res
}

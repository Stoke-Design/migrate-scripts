import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { convertUploads, makeRewriter } from './webp'

const keys = new Set(['2024/01/photo.jpg', '2024/01/photo-300x200.jpg', '2024/01/photo-scaled.jpg', '2024/01/logo.png', '2024/01/shot.jpeg'])
const rw = makeRewriter(keys)

describe('makeRewriter', () => {
  it('leaves non-INSERT lines and unrelated rows alone', () => {
    expect(rw("-- uploads/2024/01/photo.jpg 'x'")).toBe("-- uploads/2024/01/photo.jpg 'x'")
    const row = "INSERT INTO `wp_options` VALUES (1,'siteurl','https://a.com','yes');"
    expect(rw(row)).toBe(row)
  })

  it('swaps plain, srcset and JSON-escaped URLs; skips files that were not converted', () => {
    const line = `INSERT INTO \`wp_posts\` VALUES (1,'<img src=\\"https://a.com/wp-content/uploads/2024/01/photo.jpg?ver=2\\" srcset=\\"https://a.com/wp-content/uploads/2024/01/photo-300x200.jpg 300w, https://a.com/wp-content/uploads/2024/01/other.jpg 600w\\">'),('{\\\\"u\\\\":\\\\"https:\\\\/\\\\/a.com\\\\/wp-content\\\\/uploads\\\\/2024\\\\/01\\\\/logo.png\\\\"}');`
    const out = rw(line)
    expect(out).toContain('uploads/2024/01/photo.webp?ver=2')
    expect(out).toContain('photo-300x200.webp 300w')
    expect(out).toContain('other.jpg 600w')
    expect(out).toContain('uploads\\\\/2024\\\\/01\\\\/logo.webp')
  })

  it('fixes PHP serialized lengths, including serialized data nested in a string', () => {
    const url = 'https://a.com/wp-content/uploads/2024/01/shot.jpeg'
    const inner = `a:1:{s:3:"img";s:${url.length}:"${url}";}`
    const outer = `a:1:{s:4:"blob";s:${inner.length}:"${inner}";}`
    const out = rw(`INSERT INTO \`wp_options\` VALUES (1,'x','${outer.replace(/"/g, '\\"')}','no');`)
    const newUrl = url.replace('.jpeg', '.webp')
    const newInner = `a:1:{s:3:"img";s:${newUrl.length}:"${newUrl}";}`
    expect(out).toContain(`s:${newInner.length}:\\"${newInner.replace(/"/g, '\\"')}\\"`)
  })

  it('rewrites attachment meta, attached file, guid and mime type together', () => {
    const S = (x: string) => `s:${x.length}:"${x}";`
    const size = (file: string) => `a:3:{${S('file')}${S(file)}${S('mime-type')}${S('image/jpeg')}${S('filesize')}i:5;}`
    const meta = `a:3:{${S('width')}i:1;${S('file')}${S('2024/01/photo.jpg')}${S('sizes')}a:2:{${S('thumbnail')}${size('photo-300x200.jpg')}${S('other')}${size('other.jpg')}}}`
    const out = rw(`INSERT INTO \`wp_postmeta\` VALUES (1,9,'_wp_attached_file','2024/01/photo.jpg'),(2,9,'_wp_attachment_metadata','${meta.replace(/"/g, '\\"')}');`)
    expect(out).toContain("'_wp_attached_file','2024/01/photo.webp'")
    expect(out).toContain('s:4:\\"file\\";s:18:\\"2024/01/photo.webp\\"')
    expect(out).toContain('s:4:\\"file\\";s:18:\\"photo-300x200.webp\\"')
    expect(out.match(/image\/webp/g)).toHaveLength(1) // thumbnail only: other.jpg was not converted
    expect(out.match(/image\/jpeg/g)).toHaveLength(1)

    const post = "(9,1,'2024-01-01','2024-01-01','','photo','','inherit','open','closed','','photo','','','2024-01-01','2024-01-01','',0,'https://a.com/wp-content/uploads/2024/01/photo.jpg',0,'attachment','image/jpeg',0),(10,1,'','','','x','','inherit','open','closed','','x','','','','','',0,'https://a.com/wp-content/uploads/2024/01/other.jpg',0,'attachment','image/jpeg',0);"
    const o2 = rw(post)
    expect(o2).toContain("uploads/2024/01/photo.webp',0,'attachment','image/webp'")
    expect(o2).toContain("uploads/2024/01/other.jpg',0,'attachment','image/jpeg'")
  })

  it('round-trips escapes (newlines, quotes, backslashes) in changed rows', () => {
    const out = rw("INSERT INTO `wp_posts` VALUES (1,'it\\'s\\nok \\\\ \\\"q\\\" https://a.com/wp-content/uploads/2024/01/photo.jpg');")
    expect(out).toBe("INSERT INTO `wp_posts` VALUES (1,'it\\'s\\nok \\\\ \\\"q\\\" https://a.com/wp-content/uploads/2024/01/photo.webp');")
  })
})

const hasCwebp = (() => {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// 64x64 gradient PNG built by hand so the test needs no fixtures
function png(): Buffer {
  const w = 64
  const raw = Buffer.alloc((w * 3 + 1) * w)
  for (let y = 0; y < w; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x + y * 2) & 255
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t), d])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

describe.skipIf(!hasCwebp)('convertUploads (needs cwebp)', () => {
  it('converts, rewrites a gzipped dump, quarantines originals and leaves the source dump alone', async () => {
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'webp-'))
    const root = path.join(backup, 'homedir', 'public_html')
    const up = path.join(root, 'wp-content', 'uploads', '2024', '01')
    fs.mkdirSync(up, { recursive: true })
    fs.writeFileSync(path.join(up, 'a.png'), png())
    fs.writeFileSync(path.join(up, 'tiny.png'), png().subarray(0, 0)) // not a PNG: must be skipped, not crash
    const dump = path.join(backup, 'db.sql.gz')
    const sql = "INSERT INTO `wp_postmeta` VALUES (1,9,'_wp_attached_file','2024/01/a.png');\nINSERT INTO `wp_posts` VALUES (1,'<img src=\\\"/wp-content/uploads/2024/01/a.png\\\">');\n"
    fs.writeFileSync(dump, zlib.gzipSync(sql))
    const work = path.join(backup, '_wp-cleanup')

    const dry = await convertUploads(root, work, dump, { quality: 82, pngLossy: false, dryRun: true })
    expect(dry.candidates).toBe(2)
    expect(fs.existsSync(path.join(up, 'a.png'))).toBe(true)

    const r = await convertUploads(root, work, dump, { quality: 82, pngLossy: false, dryRun: false })
    expect(r.converted.map((c) => c.from)).toEqual(['2024/01/a.png'])
    expect(r.skipped.map((s) => s.path)).toContain('2024/01/tiny.png')
    expect(fs.existsSync(path.join(up, 'a.webp'))).toBe(true)
    expect(fs.existsSync(path.join(up, 'a.png'))).toBe(false)
    expect(fs.existsSync(path.join(r.quarantine!, 'wp-content/uploads/2024/01/a.png'))).toBe(true)
    const out = zlib.gunzipSync(fs.readFileSync(r.dump!.out)).toString()
    expect(out).toContain("'_wp_attached_file','2024/01/a.webp'")
    expect(out).toContain('uploads/2024/01/a.webp')
    expect(zlib.gunzipSync(fs.readFileSync(dump)).toString()).toBe(sql)
  })
})

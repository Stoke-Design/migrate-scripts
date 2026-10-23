import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  convertAll,
  escapeSql,
  findConvertedAttachments,
  jpegOrientation,
  listUploadImages,
  makeTextRewriter,
  mapTuples,
  newStats,
  phpParse,
  phpSerialize,
  precheck,
  rewriteDump,
  rewriteMetadata,
  rewriteSerializedAware,
  setImageFormat,
  sqlByteLength,
  unescapeSql,
  webpName,
} from './webp'

const conv = new Map([
  ['2024/01/photo.jpg', '2024/01/photo.webp'],
  ['2024/01/photo-300x225.jpg', '2024/01/photo-300x225.webp'],
  ['2024/01/logo.png', '2024/01/logo.webp'],
])
const plain = makeTextRewriter(conv)

describe('text rewriting', () => {
  it('rewrites plain, JSON-escaped and SQL-escaped JSON paths, and srcset lists', () => {
    expect(plain('https://x.com/wp-content/uploads/2024/01/photo.jpg')).toBe('https://x.com/wp-content/uploads/2024/01/photo.webp')
    expect(plain('uploads\\/2024\\/01\\/photo.jpg')).toBe('uploads\\/2024\\/01\\/photo.webp')
    expect(plain('uploads\\\\/2024\\\\/01\\\\/photo.jpg')).toBe('uploads\\\\/2024\\\\/01\\\\/photo.webp')
    expect(plain('a/2024/01/photo-300x225.jpg 300w, a/2024/01/photo.jpg 800w')).toBe('a/2024/01/photo-300x225.webp 300w, a/2024/01/photo.webp 800w')
    expect(plain('/2024/01/photo.jpg?ver=2')).toBe('/2024/01/photo.webp?ver=2')
  })

  it('leaves files that were not converted, other folders and existing .webp names alone', () => {
    expect(plain('/2024/01/other.jpg')).toBe('/2024/01/other.jpg')
    expect(plain('/theme/img/photo.jpg')).toBe('/theme/img/photo.jpg')
    expect(plain('/2024/01/photo.jpg.webp')).toBe('/2024/01/photo.jpg.webp')
    expect(plain('/2024/01/photo.jpgx')).toBe('/2024/01/photo.jpgx')
  })

  it('matches URL-encoded file names', () => {
    const c = new Map([['2024/01/my photo.jpg', '2024/01/my photo.webp']])
    expect(makeTextRewriter(c)('/2024/01/my%20photo.jpg')).toBe('/2024/01/my%20photo.webp')
  })
})

describe('serialized strings', () => {
  it('recomputes the length of a serialized string that holds a converted path', () => {
    const url = 'https://x.com/wp-content/uploads/2024/01/photo.jpg'
    const row = `(1,'w','a:1:{s:3:\\"url\\";s:${url.length}:\\"${url}\\";}')`
    const stats = newStats()
    const out = rewriteSerializedAware(row, makeTextRewriter(conv, stats), stats)
    expect(out).toContain(`s:${url.length + 1}:\\"https://x.com/wp-content/uploads/2024/01/photo.webp\\";`)
    expect(stats.serializedFixed).toBe(1)
  })

  it('counts a backslash pair as one byte and multibyte characters as their bytes', () => {
    expect(sqlByteLength('a\\"b\\\\c')).toBe(5)
    const bytes = Buffer.from('Zoë /2024/01/photo.jpg', 'utf8').toString('latin1')
    const row = `s:${bytes.length}:\\"${bytes}\\";`
    expect(rewriteSerializedAware(row, plain)).toBe(`s:${bytes.length + 1}:\\"${bytes.replace('.jpg', '.webp')}\\";`)
  })

  it('does not touch serialized strings without converted paths', () => {
    const row = `s:5:\\"hello\\";s:9:\\"photo.jpg\\";`
    expect(rewriteSerializedAware(row, plain)).toBe(row)
  })

  it('still rewrites plain text when a serialized length is wrong', () => {
    expect(rewriteSerializedAware('s:99:\\"/2024/01/photo.jpg\\";', plain)).toBe('s:99:\\"/2024/01/photo.webp\\";')
  })
})

describe('attachment metadata', () => {
  const s = (v: string) => `s:${v.length}:"${v}";`
  const arr = (...pairs: [string, string][]) => `a:${pairs.length}:{${pairs.map(([k, v]) => s(k) + v).join('')}}`
  const meta = arr(
    ['file', s('2024/01/photo.jpg')],
    ['sizes', arr(['medium', arr(['file', s('photo-300x225.jpg')], ['mime-type', s('image/jpeg')], ['filesize', 'i:99;'])], ['other', arr(['file', s('other-10x10.jpg')], ['mime-type', s('image/jpeg')])])],
    ['original_image', s('photo.jpg')],
    ['image_meta', arr(['keywords', 'a:0:{}'])],
    ['extra', 'N;'],
  )

  it('round-trips through the parser unchanged', () => {
    const tree = phpParse(meta)!
    expect(phpSerialize(tree)).toBe(meta)
  })

  it('converts file, sizes, original_image and mime types, only for converted files', () => {
    const tree = phpParse(meta)!
    expect(rewriteMetadata(tree, conv)).toBe(true)
    const out = phpSerialize(tree)
    expect(out).toContain('s:18:"2024/01/photo.webp";')
    expect(out).toContain('s:18:"photo-300x225.webp";')
    expect(out).toContain('s:10:"image/webp";')
    expect(out).toContain('s:10:"photo.webp";')
    expect(out).toContain('s:15:"other-10x10.jpg";s:9:"mime-type";s:10:"image/jpeg";')
    expect(phpParse(out)).not.toBeNull()
  })

  it('refuses malformed serialized data', () => {
    expect(phpParse('a:1:{s:4:"file";s:99:"x";}')).toBeNull()
  })

  it('escapes and unescapes SQL strings symmetrically', () => {
    const s = 'a"b\'c\\d\ne\0f'
    expect(unescapeSql(escapeSql(s))).toBe(s)
  })
})

describe('tuples', () => {
  it('maps each row, even with parentheses and quotes inside strings', () => {
    const line = "INSERT INTO `wp_posts` VALUES (1,'a (b) \\'c\\''),(2,'x');"
    expect(mapTuples(line, (t) => t.toUpperCase())).toBe("INSERT INTO `wp_posts` VALUES (1,'A (B) \\'C\\''),(2,'X');")
  })
})

describe('EXIF', () => {
  const jpegWithOrientation = (o: number) => {
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0])
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255])
    return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])])
  }
  it('reads the orientation tag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exif-'))
    fs.writeFileSync(path.join(dir, 'a.jpg'), jpegWithOrientation(6))
    fs.writeFileSync(path.join(dir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(jpegOrientation(path.join(dir, 'a.jpg'))).toBe(6)
    expect(jpegOrientation(path.join(dir, 'b.jpg'))).toBeUndefined()
  })
})

describe('end to end with a stand-in cwebp', () => {
  let backup: string
  let root: string
  const oldCwebp = process.env.CWEBP
  const dumpText = [
    "INSERT INTO `wp_posts` VALUES (10,1,'<img src=\\\"https://x.com/wp-content/uploads/2024/01/photo.jpg\\\">','attachment','image/jpeg',0),(11,1,'p','page','',0);",
    "INSERT INTO `wp_postmeta` VALUES (1,10,'_wp_attached_file','2024/01/photo.jpg'),(2,10,'_wp_attachment_metadata','a:2:{s:4:\\\"file\\\";s:17:\\\"2024/01/photo.jpg\\\";s:5:\\\"sizes\\\";a:0:{}}');",
    '',
  ].join('\n')

  beforeAll(() => {
    backup = fs.mkdtempSync(path.join(os.tmpdir(), 'webp-e2e-'))
    root = path.join(backup, 'homedir', 'public_html')
    const up = path.join(root, 'wp-content', 'uploads', '2024', '01')
    fs.mkdirSync(up, { recursive: true })
    fs.writeFileSync(path.join(up, 'photo.jpg'), Buffer.alloc(4000, 1))
    fs.writeFileSync(path.join(up, 'big-after.png'), Buffer.alloc(100, 2)) // stand-in output is bigger for this one
    fs.writeFileSync(path.join(up, 'photo.png'), Buffer.alloc(300, 3)) // would also become photo.webp
    fs.writeFileSync(path.join(up, 'note.txt'), 'x')
    fs.mkdirSync(path.join(root, 'wp-content', 'uploads', 'misc'), { recursive: true })
    fs.writeFileSync(path.join(root, 'wp-content', 'uploads', 'misc', 'skip.jpg'), 'x') // not in YYYY/MM
    const stub = path.join(backup, 'cwebp-stub.sh')
    fs.writeFileSync(
      stub,
      '#!/bin/sh\nsrc=""; dest=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) dest="$2"; shift 2;; -q|-m|-z) shift 2;; -*) shift;; *) src="$1"; shift;; esac; done\n' +
        'case "$src" in *big-after*) head -c 500 /dev/zero > "$dest";; *) size=$(wc -c < "$src"); head -c $((size / 4)) "$src" > "$dest";; esac\n',
      { mode: 0o755 },
    )
    process.env.CWEBP = stub
  })
  afterAll(() => {
    if (oldCwebp === undefined) delete process.env.CWEBP
    else process.env.CWEBP = oldCwebp
  })

  it('lists only dated upload images', () => {
    expect(listUploadImages(root).map((i) => i.rel)).toEqual(['2024/01/big-after.png', '2024/01/photo.jpg', '2024/01/photo.png'])
    expect(webpName('a/b.JPEG')).toBe('a/b.webp')
  })

  it('converts, skips what is not smaller or collides, rewrites the dump, and cleans up on failure', async () => {
    const images = listUploadImages(root)
    expect(images.map(precheck)).toEqual([null, null, null])
    const r = await convertAll(images, { quality: 82, pngLossy: false }, 2)
    expect(r.converted.map((c) => c.path)).toEqual(['2024/01/photo.jpg'])
    expect(r.skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual(['2024/01/big-after.png:webp-not-smaller', '2024/01/photo.png:webp-exists'])
    expect(fs.existsSync(path.join(root, 'wp-content/uploads/2024/01/big-after.webp'))).toBe(false)

    const dump = path.join(backup, 'db.sql')
    fs.writeFileSync(dump, dumpText)
    const map = new Map(r.converted.map((c) => [c.path, c.to]))
    const ids = await findConvertedAttachments(dump, map)
    expect([...ids]).toEqual(['10'])
    const out = path.join(backup, 'out', 'db.sql')
    const stats = await rewriteDump(dump, out, 'wp_', map, ids)
    const text = fs.readFileSync(out, 'latin1')
    expect(text).toContain("uploads/2024/01/photo.webp\\\">','attachment','image/webp',0),(11,1,'p','page','',0)")
    expect(text).toContain("'_wp_attached_file','2024/01/photo.webp'")
    expect(text).toContain('s:18:\\"2024/01/photo.webp\\";')
    expect(text).not.toContain('photo.jpg')
    expect(stats).toMatchObject({ mimeChanged: 1, metadataRows: 1 })
    expect(fs.readFileSync(dump, 'latin1')).toBe(dumpText) // the original is untouched

    // gzip in, gzip out
    const gz = path.join(backup, 'db.sql.gz')
    fs.writeFileSync(gz, zlib.gzipSync(dumpText))
    const gzOut = path.join(backup, 'out', 'db.sql.gz')
    await rewriteDump(gz, gzOut, 'wp_', map, ids)
    expect(zlib.gunzipSync(fs.readFileSync(gzOut)).toString('latin1')).toBe(text)

    // a failed rewrite leaves no output file behind
    await expect(rewriteDump(path.join(backup, 'missing.sql'), path.join(backup, 'out', 'x.sql'), 'wp_', map, ids)).rejects.toThrow()
    expect(fs.existsSync(path.join(backup, 'out', 'x.sql'))).toBe(false)
  })
})

describe('avif target', () => {
  it('rewrites names and mime types to AVIF, and is reset to WebP afterwards', () => {
    setImageFormat('avif')
    try {
      expect(webpName('photo-300x225.jpg')).toBe('photo-300x225.jpg.avif')
      const avifConv = new Map([['2024/01/photo.jpg', '2024/01/photo.jpg.avif']])
      const rewrite = makeTextRewriter(avifConv)
      expect(rewrite('<img src="/wp-content/uploads/2024/01/photo.jpg">')).toBe('<img src="/wp-content/uploads/2024/01/photo.jpg.avif">')
      // an already converted reference is left alone, whatever the target
      expect(rewrite('2024/01/photo.jpg.avif')).toBe('2024/01/photo.jpg.avif')
    } finally {
      setImageFormat('webp')
    }
    expect(webpName('photo.jpg')).toBe('photo.webp')
  })
})

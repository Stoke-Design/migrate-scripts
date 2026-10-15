import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Findings, mediaKey, scanDevSites, scanUploads, findSqlDump, findWpRoots, installPackage, isElementorSite, listPlugins, listThemes, parseDump, readWpConfig, removeToQuarantine, scanCode, scanJunk, scanPerformance, stokeStatus } from './lib'

let backup: string
let root: string
const w = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

beforeAll(() => {
  backup = fs.mkdtempSync(path.join(os.tmpdir(), 'wpclean-'))
  root = path.join(backup, 'homedir', 'public_html')
  w('wp-config.php', "<?php\ndefine('DB_NAME','site_db');\ndefine('DB_PASSWORD','hunter2-secret');\ndefine('WP_DEBUG', true);\n$table_prefix = 'xy_';\n")
  w('wp-config-sample.php', '<?php')
  w('wp-includes/version.php', "<?php $wp_version = '6.5';")
  w('.htaccess', '# BEGIN cPanel-generated php ini directives\nAddHandler application/x-httpd-ea-php81 .php\n')
  w('.user.ini', 'auto_prepend_file = /home/user123/public_html/wordfence-waf.php\n')
  w('wp-content/plugins/elementor/elementor.php', '/*\nPlugin Name: Elementor\nVersion: 3.20.0\n*/')
  w('wp-content/plugins/stoke-tools/stoke-tools.php', '/*\nPlugin Name: Stoke Tools\nVersion: 3.1.0\nAuthor: Stoke Design\n*/')
  w('wp-content/plugins/w3-total-cache/w3-total-cache.php', '/*\nPlugin Name: W3 Total Cache\nVersion: 2.0\n*/')
  w('wp-content/plugins/evil/evil.php', "<?php\n/*\nPlugin Name: Innocent\n*/\neval(base64_decode('aGVsbG8='));")
  w('wp-content/themes/hello-child/style.css', '/*\nTheme Name: Hello Child\nTemplate: hello-elementor\nVersion: 1.0\n*/\nbody{color:red}'.padEnd(900, ' '))
  w('wp-content/themes/hello-child/functions.php', "<?php\nadd_action('init', function(){ a(); });\nadd_filter('the_content', 'x');\nadd_shortcode('s', 'y');\nregister_post_type('p');\nwp_enqueue_style('z');\ndefine('A',1);\n")
  w('wp-content/themes/hello-elementor/style.css', '/*\nTheme Name: Hello Elementor\nVersion: 3.0\n*/')
  w('wp-content/themes/twentytwenty/style.css', '/*\nTheme Name: Twenty Twenty\nVersion: 2.0\n*/')
  w('wp-content/updraft/backup.zip', 'x')
  w('wp-content/cache/page.html', 'x')
  w('wp-content/uploads/2024/01/shell.php', '<?php system($_GET["c"]);')
  w('wp-content/uploads/2024/01/photo.jpg', 'x')
  w('wp-content/uploads/backup-old/site.zip', 'x')
  w('wp-content/mu-plugins/synergy.php', '<?php // Synergy Wholesale helper')
  w('error_log', 'x')
  w('staging/wp-config.php', "<?php define('DB_NAME','staging_db');")
  w('staging/wp-includes/version.php', "<?php $wp_version = '6.4';")
  w('staging/wp-content/index.php', '<?php')
  w('dev-old/index.html', 'x')
  w('wp-content/uploads/2024/01/photo.jpg', 'x')
  w('wp-content/uploads/2024/01/photo-150x150.jpg', 'x')
  w('wp-content/uploads/2024/02/used-scaled.jpg', 'x')
  w('wp-content/uploads/2024/02/elem.png', 'x')
  w('wp-content/uploads/2024/03/orphan.png', 'x')
  w('wp-content/uploads/2024/03/old.log', 'x')
  w('wp-content/uploads/elementor/css/post-1.css', 'x')
  w('wp-content/uploads/woocommerce_uploads/keep.pdf', 'x')
  w('wp-content/plugins/__MACOSX/stoke-tools/._a.php', 'x')
  w('wp-content/plugins/elementor/vendor/lib.php', '<?php $x = "' + '\\x41'.repeat(30) + '";')
  fs.mkdirSync(path.join(backup, 'mysql'))
  fs.writeFileSync(path.join(backup, 'mysql', 'site_db.sql'), [
    "INSERT INTO `xy_options` VALUES (1,'siteurl','https://example.com','yes'),(2,'template','hello-elementor','yes'),(3,'stylesheet','hello-child','yes'),(4,'active_plugins','a:2:{i:0;s:23:\\\"elementor/elementor.php\\\";i:1;s:25:\\\"stoke-tools/stoke-tools.php\\\";}','yes'),(5,'_transient_foo','bar','no');",
    "INSERT INTO `xy_posts` VALUES (1,'a','revision','',0),(2,'b','custom_css','',0);",
    "INSERT INTO `xy_postmeta` VALUES (1,1,'_elementor_data','[{\\\"image\\\":\\\"https:\\\\/\\\\/x.com\\\\/wp-content\\\\/uploads\\\\/2024\\\\/02\\\\/elem-300x200.png\\\"}]'),(2,9,'_wp_attached_file','2024/01/photo.jpg');",
    "INSERT INTO `xy_posts` VALUES (3,'<img src=\\\"https://x.com/wp-content/uploads/2024/02/used.jpg\\\">','post','',0);",
  ].join('\n'))
})
afterAll(() => fs.rmSync(backup, { recursive: true, force: true }))

describe('wp-cleanup', () => {
  it('finds the root and the right dump, and never returns credentials', () => {
    expect(findWpRoots(backup)).toEqual([root, path.join(root, 'staging')]) // the nested install is a dev-site candidate, not the site
    const cfg = readWpConfig(root)
    expect(cfg.prefix).toBe('xy_')
    expect(findSqlDump(backup, cfg.dbName)).toBe(path.join(backup, 'mysql', 'site_db.sql'))
    expect(JSON.stringify(cfg)).not.toContain('hunter2')
  })

  it('reads active state and options from the dump', async () => {
    const d = await parseDump(path.join(backup, 'mysql', 'site_db.sql'), 'xy_')
    expect(d).toMatchObject({ stylesheet: 'hello-child', template: 'hello-elementor', revisions: 1, hasCustomCss: true, hasElementorData: true, transientCount: 1 })
    expect(d.activePlugins).toEqual(['elementor/elementor.php', 'stoke-tools/stoke-tools.php'])
  })

  it('parses the one-row-per-line mysqldump format too', async () => {
    const f = path.join(backup, 'multiline.sql')
    fs.writeFileSync(f, [
      'INSERT INTO `xy_options` (`option_id`, `option_name`, `option_value`, `autoload`) VALUES',
      "(1,'stylesheet','hello-child','yes'),",
      "(2,'active_plugins','a:1:{i:0;s:23:\\\"elementor/elementor.php\\\";}','yes');",
      'INSERT INTO `xy_other` VALUES',
      "(3,'stylesheet','nope','yes');",
    ].join('\n'))
    const d = await parseDump(f, 'xy_')
    expect(d.stylesheet).toBe('hello-child')
    expect(d.activePlugins).toEqual(['elementor/elementor.php'])
  })

  it('classifies plugins, themes and the Stoke plan', async () => {
    const d = await parseDump(path.join(backup, 'mysql', 'site_db.sql'), 'xy_')
    const plugins = listPlugins(root, d.activePlugins)
    const themes = listThemes(root, d.stylesheet)
    expect(plugins.find((p) => p.slug === 'stoke-tools')).toMatchObject({ stoke: true, active: true, version: '3.1.0' })
    expect(plugins.find((p) => p.slug === 'w3-total-cache')?.active).toBe(false)
    expect(themes.find((t) => t.slug === 'hello-child')).toMatchObject({ parent: 'hello-elementor', active: true, customCode: { verdict: 'likely' } })
    expect(themes.find((t) => t.slug === 'twentytwenty')?.isDefaultWpTheme).toBe(true)
    const elementor = isElementorSite(plugins, themes, d)
    expect(elementor).toBe(true)
    const s = stokeStatus(plugins, themes, elementor)
    expect(s.plugin.status).toBe('missing')
    expect(s.plan.join('\n')).toMatch(/Remove older Stoke plugin copy .*stoke-tools.*ACTIVE/)
    expect(s.plan.join('\n')).toMatch(/install hello-stoke \+ hello-stoke-child/)
  })

  it('flags junk, malware, leftovers and performance issues', async () => {
    const junk = new Findings()
    const malware = new Findings()
    const leftovers = new Findings()
    scanJunk(root, junk)
    scanCode(root, malware, leftovers)
    const j = junk.items.map((i) => i.path)
    expect(j).toEqual(expect.arrayContaining(['wp-config-sample.php', 'wp-content/updraft', 'wp-content/cache', 'wp-content/uploads/backup-old', 'error_log']))
    expect(malware.items.map((i) => i.rule)).toEqual(expect.arrayContaining(['php-in-uploads', 'eval-obfuscated']))
    expect(malware.items.some((i) => i.rule === 'auto-prepend')).toBe(false) // wordfence is a leftover, not malware
    expect(malware.items.some((i) => i.rule === 'hex-obfuscation' || i.rule === 'suspicious-filename')).toBe(false) // bundled vendor libs and macOS ._ files are not malware
    expect(j).toContain('wp-content/plugins/__MACOSX')
    expect(leftovers.items.map((i) => i.rule)).toEqual(expect.arrayContaining(['wordfence-waf-prepend', 'cpanel-php-handler', 'synergy-reference', 'leftover-name']))
    const perf = scanPerformance(root, listPlugins(root), readWpConfig(root))
    expect(perf.map((p) => p.rule)).toEqual(expect.arrayContaining(['plugins-page-cache', 'wp-debug-on']))
  })

  it('maps resized, scaled and webp variants onto one media key', () => {
    expect(mediaKey('2024/01/photo-300x200.jpg')).toBe('2024/01/photo')
    expect(mediaKey('2024/01/photo-scaled.jpg')).toBe('2024/01/photo')
    expect(mediaKey('2024/01/photo-scaled-1024x768.jpg.webp')).toBe('2024/01/photo')
    expect(mediaKey('2024/01/my%20pic.JPG')).toBe('2024/01/my pic')
  })

  it('finds dev sites, regenerable uploads and genuinely unused media', async () => {
    const f = new Findings()
    scanDevSites(root, f)
    expect(f.items.map((i) => [i.rule, i.path])).toEqual(expect.arrayContaining([['nested-wp-install', 'staging'], ['dev-site-folder', 'dev-old']]))
    expect(f.items.find((i) => i.rule === 'nested-wp-install')?.detail).toMatch(/its own database/)
    const d = await parseDump(path.join(backup, 'mysql', 'site_db.sql'), 'xy_')
    const u = new Findings()
    const r = scanUploads(root, u, d)
    const orphans = r.orphans.map((o) => o.path)
    expect(r.checked).toBe(true)
    expect(orphans).toEqual(expect.arrayContaining(['wp-content/uploads/2024/03/orphan.png', 'wp-content/uploads/2024/01/shell.php']))
    for (const used of ['2024/01/photo.jpg', '2024/01/photo-150x150.jpg', '2024/02/used-scaled.jpg', '2024/02/elem.png']) expect(orphans, used).not.toContain(`wp-content/uploads/${used}`)
    expect(orphans.some((o) => o.includes('woocommerce_uploads') || o.includes('elementor'))).toBe(false) // plugin-managed folders are not judged
    expect(u.items.map((i) => i.path)).toEqual(expect.arrayContaining(['wp-content/uploads/elementor/css', 'wp-content/uploads/2024/03/old.log']))
    expect(scanUploads(root, new Findings()).checked).toBe(false) // no dump, no orphan verdicts
  })

  it('quarantines instead of deleting, and refuses dangerous paths', () => {
    const work = path.join(backup, '_wp-cleanup')
    expect(() => removeToQuarantine(root, work, ['wp-config.php'])).toThrow(/Refusing/)
    expect(() => removeToQuarantine(root, work, ['../outside'])).toThrow(/Refusing/)
    const { dest, moved } = removeToQuarantine(root, work, ['wp-config-sample.php', 'wp-content/updraft'])
    expect(moved).toHaveLength(2)
    expect(fs.existsSync(path.join(root, 'wp-config-sample.php'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'wp-content/updraft/backup.zip'))).toBe(true)
  })

  it('installs a package once and never overwrites', async () => {
    const pkg = path.join(backup, 'pkg')
    fs.mkdirSync(path.join(pkg, 'stoke-internal-tools'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'stoke-internal-tools', 'stoke-internal-tools.php'), '/*\nPlugin Name: Stoke Internal Tools\nVersion: 3.7.1\n*/')
    const zip = path.join(backup, 'sit.zip')
    execFileSync('zip', ['-qr', zip, 'stoke-internal-tools'], { cwd: pkg })
    const r = await installPackage(root, path.join(backup, '_wp-cleanup'), 'plugin', zip, 'stoke-internal-tools')
    expect(r.version).toBe('3.7.1')
    await expect(installPackage(root, path.join(backup, '_wp-cleanup'), 'plugin', zip, 'stoke-internal-tools')).rejects.toThrow(/already exists/)
  })
})

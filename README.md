# WP cleanup: how to run it

Cleans a WordPress site saved locally from a cPanel backup before migration. Only `public_html` and the database migrate, so that is all it looks at. Claude drives it through the **wp-cleanup** skill; the scripts in this folder do the file work. Nothing is deleted: removals go to a quarantine folder.

## You need
- The `wp-cleanup` skill installed in Claude Code.
- Node 20+ and `unzip` (both already on a Stoke Mac).
- The scripts folder. Ours is on the shared drive:
  `~/Library/CloudStorage/GoogleDrive-<you>/Shared drives/SD Work In Progress/[26181] The great Website Migration of 26' - Stoke Design Co/scripts/` (holds `cli.ts` and `lib.ts`).
- The site's cPanel backup. If the site folder only holds the `backup-….tar.gz`, Claude extracts **only `homedir/public_html/` and `mysql/`** into that same site folder, next to the archive, and keeps the archive. That extracted `backup-…/` folder is the "backup folder" for both this skill and wp-deploy. The `.sql` is optional but it tells Claude which plugins and theme are active and which uploads are unused.

## Run it
1. Open Claude Code in any folder and say, with your real paths:

   > Use the wp-cleanup skill on `<…>/sites/wellmeasured.com.au`. The scripts are in `<…>/Stoke Design Co/scripts`.

   Paths on the shared drive contain spaces, brackets and an apostrophe, so quote them. In a terminal, wrap the whole path in double quotes. The audit uses `homedir/public_html`; any other WordPress install inside it is reported as a dev-site candidate.
2. Claude runs a read-only **audit** and walks you through it, asking you before anything is removed:
   1. Plugins: which to delete
   2. Themes: which to delete (it reads old themes' custom code first and tells you what would be lost)
   3. `wp-content` folders: old backups, caches, logs
   4. Dev sites: staging/test copies inside `public_html` (a separate live site is flagged, not removed)
   5. Uploads clutter: regenerable plugin output, logs, and media nothing in the database uses
   6. `wp-config-sample.php` and other core leftovers
   7. Malware scan
   8. Synergy / cPanel leftovers
   9. Performance issues
   10. Stoke packages
3. You approve each group. Claude moves the approved items into quarantine, installs the Stoke packages, re-runs the audit to confirm, and gives you a short summary.

## What gets installed (always inactive)
| Package | Sites | Notes |
|---|---|---|
| Stoke Internal Tools (latest, currently 3.7.2) | Every site | Older Stoke plugin copies are removed first (you confirm). |
| Hello Stoke 1.2.0 + Hello Stoke Child 1.2.0 | Elementor sites only | An existing `hello-stoke` or child folder is never overwritten. |

Activation is not part of this: it's a separate approval in the migration board (plugin) or done by a person (theme).

## Where things land
`<backup folder>/_wp-cleanup/` has `report.md`, `report.json`, `orphaned-uploads.txt` and `removed/<timestamp>/` (everything Claude removed, with a manifest). To undo, move items back. Keep the folder until the deploy is done: wp-deploy reads it.

## Running it by hand
```bash
npx tsx <scripts>/cli.ts audit   <site> [--sql <dump>] [--verify-core]
npx tsx <scripts>/cli.ts remove  <site> --paths wp-config-sample.php,wp-content/updraft
npx tsx <scripts>/cli.ts install <site>          # downloads the 3 Stoke packages
```
Convert the media library to WebP or AVIF (the **wp-webp** skill; run after cleanup, before deploy):
```bash
npx tsx <scripts>/cli.ts webp <site> --dry-run   # counts only
npx tsx <scripts>/cli.ts webp <site> [--format webp|avif] [--quality 82] [--png-lossy]
```
`--format webp` (default) needs `cwebp` (`brew install webp`) and converts at `--quality` (JPEG lossy, PNG lossless unless `--png-lossy`), replacing the extension (`photo.jpg` -> `photo.webp`).
`--format avif` needs ImageMagick with AVIF support (`brew install imagemagick`; check `magick -list format | grep AVIF`) and always encodes lossy at ImageMagick's default quality (`--quality`/`--png-lossy` do not apply), resizing only if the longest side exceeds 2560px. It keeps the original extension and appends `.avif` (`photo.jpg` -> `photo.jpg.avif`) so the source format stays visible.
Originals are quarantined and the database dump is **rewritten into `_wp-cleanup/webp/`**; deploy that copy, not `mysql/<db>.sql`.

Paths for `remove` are relative to the WordPress root. `--verify-core` compares core files with wordpress.org's checksums. `install` also takes `--plugin-zip`, `--theme-zip`, `--child-zip` (URL or local file) and `--themes always|never`.

## Good to know
- **Working inside Google Drive:** the extracted copy sits next to the archive in the site folder, as agreed. Only `public_html` and the database are extracted, so the cPanel password files and API tokens in the backup stay inside the archive. The quarantine does copy removed files (including any malware found) into the same drive; removals go to the Drive trash, recoverable for a while.
- If the scan finds confirmed malware, Claude stops and checks with you before going on.
- Keep Wordfence — don't remove it during cleanup. A Wordfence `auto_prepend_file` line pointing at the old server path is an Apache/php.ini-era concern; it's inert on SpinupWP's nginx, so Claude notes it but doesn't treat it as a blocker.
- The scan is signature-based only. It doesn't check images or the database.
- Versions live in `PACKAGES` at the top of `lib.ts`. Change them there when a new release ships.

## Other scripts
- **Postmark domains**: see [POSTMARK.md](POSTMARK.md) (also sets up `~/.migrate-2026.env` for the shared tokens).

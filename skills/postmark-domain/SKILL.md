---
name: postmark-domain
description: Set up a migrated site on SpinupWP end to end for email and hosting. Creates the blank site and database, creates and verifies the Postmark sending domain, adds the DNS records in Cloudflare (A to Spinup with the old Synergy IP kept in the record comment, www as a CNAME to @), then turns on HTTPS, page cache and backups. Use for "set up <domain> on Spinup", "verify the Postmark sender domain", or the board steps "SpinupWP site created", "Postmark sender domain verified", "Page cache enabled" and "Backups enabled".
---

# Postmark domain + Spinup setup

Every outward-facing step below needs its own explicit yes: show what you will do (dry run or the exact values), wait, then do it. Never print or echo token values and never ask the user to paste one into chat.

## 0. Ask first: do you have `~/.migrate-2026.env`?
Ask the user. It must hold `POSTMARK_ACCOUNT_TOKEN`, `CLOUDFLARE_API_TOKEN` and `SPINUPWP_API_TOKEN`. If they do not have it, point them to POSTMARK.md (they can get a copy from a teammate or create it) and stop until it exists. Do not `cat` it.

SpinupWP API base is `https://api.spinupwp.app/v1` (the `.com` address is only the docs). The scripts read the tokens from the file themselves, so there is no need to source it.

## 1. Blank site with a database (Spinup)
Use the **spinupwp-new-site** skill (it keeps the credentials CSV and has its own checklist). Names to give it, from the domain's first label (`vicgroundsprayers.org.au` → `vicgroundsprayers`):
- **Site user / site name:** `vicgroundsprayers`. If the name starts with a number (like `1816.com.au`), prefix `sd_` → `sd_1816`.
- **Database name and database user:** always `sd_<sitename>` (`sd_vicgroundsprayers`).

Confirm the names with the user before creating. Check Linux user and MySQL limits (32 characters); ask if the name has characters those do not allow.

## 2. Postmark sender domain
Run the dry run, show it, wait for a yes, then run it (`<scripts>` is the scripts folder):
```
npx tsx <scripts>/postmark.ts <domain> --dry-run
npx tsx <scripts>/postmark.ts <domain>
```
This is the **domain** type ("send from any address on the domain"), not a per-address sender signature. It creates the domain with Return-Path `pm-bounces.<domain>`, adds the DKIM TXT and the Return-Path CNAME (to `pm.mtasv.net`, DNS only) in Cloudflare, and verifies. It is idempotent. If the domain's DNS is not on the Cloudflare token it prints "no matching zone": give the user the records to add by hand, then re-run to verify.

## 3-6. DNS, HTTPS, page cache and backups: `spinup.ts`
One script does Cloudflare and the Spinup settings. Without `--yes` it only reads and prints the plan:
```
npx tsx <scripts>/spinup.ts <domain>            # dry run (DNS-only A record)
```
Show the user the output and go through it with them, then apply:
```
npx tsx <scripts>/spinup.ts <domain> --yes
```
What it does, in order (each line is skipped when already correct, so re-running is safe):
1. **A record for `@`** → the Spinup server IP. The old address is kept in the record comment as `SYNERGY=<old IP>` (rollback: set the record back to that IP). It reads the old IP from the current record, so run it before anything else changes the A record.
2. **`www`** → `CNAME` to `@`. If `www` has some other record type it stops and tells you to remove it by hand.
3. **Spinup:** adds `www` as an additional domain (301 to the primary), enables Let's Encrypt HTTPS (needs DNS already pointing at the server) and turns page cache on.
4. **Backups:** copies the storage provider, bucket and schedule from a sibling site on the **same server** and prints them. `--no-backups` skips it.

Things to ask the user:
- **Proxied or DNS-only?** The default is DNS-only. A proxied record with no HTTPS on the origin returns 525, so run with `--yes` first, check the site, then run again with `--proxied --yes` to turn the proxy on. Only use `--proxied` from the start if the user asks.
- **Is the backup bucket right?** The dry run prints the bucket, region and schedule and the question. Do not run `--yes` until the user has confirmed it. The bucket is per server (for example `titan-prod-6-backup` on titan-prod-6). With no sibling to copy from, the script says so and backups are set up by hand.

The script finishes with the page cache, HTTPS and backup state read back from Spinup and a status check of the apex and `www`.

## Rules
- It never touches SPF or MX, so existing mail keeps working.
- Do not mark board steps done unless the user asks and it is within your scopes.
- Postmark server tokens (used by the Stoke plugin to send) are separate; this skill does not create or print them.

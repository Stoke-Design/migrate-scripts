---
name: postmark-domain
description: Set up a migrated site on SpinupWP end to end for email and hosting. Creates the blank site and database, creates and verifies the Postmark sending domain, adds the DNS records in Cloudflare (A to Spinup with the old Synergy IP kept in the record comment, www as a CNAME to @), then turns on HTTPS, page cache and backups. Use for "set up <domain> on Spinup", "verify the Postmark sender domain", or the board steps "SpinupWP site created", "Postmark sender domain verified", "Page cache enabled" and "Backups enabled".
---

# Postmark domain + Spinup setup

Every outward-facing step below needs its own explicit yes: show what you will do (dry run or the exact values), wait, then do it. Never print or echo token values and never ask the user to paste one into chat.

## 0. Ask first: do you have `~/.migrate-2026.env`?
Ask the user. It must hold `POSTMARK_ACCOUNT_TOKEN`, `CLOUDFLARE_API_TOKEN` and `SPINUPWP_API_TOKEN`. If they do not have it, point them to POSTMARK.md (they can get a copy from a teammate or create it) and stop until it exists. Load it with `set -a; . ~/.migrate-2026.env; set +a`; do not `cat` it.

SpinupWP API: base `https://api.spinupwp.app/v1` (the `.com` address is only the docs), header `Authorization: Bearer $SPINUPWP_API_TOKEN`. Changes return an `event_id`: poll `GET /events/{id}` until `deployed`.

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

## 3. Website DNS in Cloudflare
1. Read the current `A` record for `@` and keep its address: that is the **old IP** (Synergy).
2. Update that A record to the Spinup server IP (`ipAddress` from the board's `get_site`, or the site's server), and set its **comment** (Record Attributes) to `SYNERGY=<old IP>`. This is the rollback note.
3. `www` must be a `CNAME` to `@` (the apex name). Leave it if it already is; create it if not.
4. Ask whether the A record should stay proxied or go DNS-only. A proxied record with no HTTPS on the origin returns 525. DNS-only first is safer; flip to proxied once HTTPS works.

```
PATCH /zones/<zone>/dns_records/<id>   {"content":"<spinup ip>","proxied":<bool>,"comment":"SYNERGY=<old ip>"}
```
Rollback: set the A record back to the old IP. Confirm the exact change with the user before sending it. This is the cutover.

## 4. HTTPS and www on Spinup
`POST /sites/{id}/domains` with `domain=www.<domain>`, `redirect[enabled]=true`, `redirect[type]=301`, then `POST /sites/{id}/https` with `type=webroot` (Let's Encrypt, needs DNS already pointing at the server). Poll the event, then check that the apex returns 200 and `www` returns a 301 to the apex.

## 5. Page cache on
`POST /sites/{id}/page-cache` (defaults). Check with `GET /sites/{id}` → `page_cache.enabled`.

## 6. Backups on (confirm the bucket first)
Backups need a storage provider, bucket and the site's database. Copy them from a sibling site on the **same server** that already has backups (`GET /sites`, match `server_id`, read `backups.storage_provider` and `backups.schedule`). **Before changing anything, show the user the bucket, region and schedule you will use and ask if the bucket is correct.** The bucket is per server (for example `titan-prod-6-backup` on titan-prod-6), so a copy from the wrong server would be wrong. Only after a yes:
```
PUT /sites/{id}/backup-settings   {"storage_provider_id":<id>,"storage_provider_bucket":"<bucket>","storage_provider_region":"<region>","database":<site db id>}
PUT /sites/{id}/backup-schedule   {"daily_schedule":{...},"weekly_schedule":{...},"monthly_schedule":{...}}
```
The site's database id is in `GET /sites/{id}` → `database.id`. Read it all back and report.

## Rules
- It never touches SPF or MX, so existing mail keeps working.
- Do not mark board steps done unless the user asks and it is within your scopes.
- Postmark server tokens (used by the Stoke plugin to send) are separate; this skill does not create or print them.

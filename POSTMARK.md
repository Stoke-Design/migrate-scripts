# Postmark domains: how to run it

Creates a Postmark **domain** for a site, adds the DKIM and Return-Path records in Cloudflare, and verifies it. Once verified, any address on the domain can send, so there are no per-address sender signatures to confirm. Claude drives it through the **postmark-domain** skill (`skills/postmark-domain/SKILL.md`), which also covers the Spinup site, the Cloudflare A record, HTTPS, page cache and backups; `postmark.ts` does the Postmark and DNS-verification part.

## You need
- Node 20+ (already on a Stoke Mac).
- A `~/.migrate-2026.env` file with the three tokens (below).
- The domain's DNS on a Cloudflare zone your token can edit. Otherwise the script prints the records for you to add by hand.

## Set up `~/.migrate-2026.env`
Create the file in your home folder:

```bash
cat > ~/.migrate-2026.env <<'ENV'
POSTMARK_ACCOUNT_TOKEN=
CLOUDFLARE_API_TOKEN=
SPINUPWP_API_TOKEN=
ENV
chmod 600 ~/.migrate-2026.env
```

Then fill in the values:

- **`POSTMARK_ACCOUNT_TOKEN`**: Postmark → your account → API tokens → *Account API tokens*. This is the account token, not a server token. It can manage domains across every server.
- **`CLOUDFLARE_API_TOKEN`**: Cloudflare → My Profile → API Tokens → Create Token. Permissions `Zone → DNS → Edit` and `Zone → Zone → Read`, limited to the zones you need. Set an expiry (TTL) so it stops working by itself.
- **`SPINUPWP_API_TOKEN`**: SpinupWP → Account → API Tokens. Used by the skill for HTTPS, the `www` domain, page cache and backups (API base `https://api.spinupwp.app/v1`). `postmark.ts` itself only needs the first two.

The file can be shared with teammates over a private channel (1Password or similar), never by email, chat or git. Keep it in `~/`, outside any repo. The script reads it by itself, so you do not need to `source` it. Variables already set in your shell win over the file. Rotate the tokens when the migration finishes.

## Run it
In Claude Code:

> Use the postmark-domain skill for `<domain>`. The scripts are in `<…>/scripts`.

Or by hand, always dry-run first:

```bash
npx tsx <scripts>/postmark.ts <domain> --dry-run   # reads only, shows what would be created
npx tsx <scripts>/postmark.ts <domain>             # creates, adds DNS, verifies
```

It is safe to re-run: existing domains and correct records are left alone.

## What it creates
| Where | Record |
|---|---|
| Postmark | Domain `<domain>` with Return-Path `pm-bounces.<domain>` |
| Cloudflare | `TXT <timestamp>pm._domainkey.<domain>` (DKIM) |
| Cloudflare | `CNAME pm-bounces.<domain>` → `pm.mtasv.net` (DNS only, not proxied) |

It does not touch SPF or MX, so existing mail keeps working.

## Good to know
- Verification retries for about four minutes. If it is still pending, run it again later.
- The Postmark server token that the Stoke plugin uses to send is separate and not handled here.

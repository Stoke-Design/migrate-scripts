---
name: postmark-domain
description: Set up a Postmark sending domain for a migrated site. Creates the domain in Postmark (send from any address on it), adds the DKIM and Return-Path DNS records in Cloudflare, and verifies. Use when asked to "verify the Postmark sender domain", "create the Postmark domain for <domain>", or for the board step "Postmark sender domain verified".
---

# Postmark domain

Creates and verifies a Postmark **domain** (not a per-address sender signature), so any `@<domain>` address can send. Uses the Postmark **account** API, so it is not limited to one server like the Postmark MCP.

## Before you start
- `~/.migrate-2026.env` must exist with `POSTMARK_ACCOUNT_TOKEN` and `CLOUDFLARE_API_TOKEN` (see POSTMARK.md). If it is missing, tell the user how to create it. Never ask them to paste a token into chat, and never print or echo token values.
- The scripts folder holds `postmark.ts`. Node 20+ is enough: `npx tsx <scripts>/postmark.ts`.

## Steps
1. Run the **dry run** and show the user the output:
   `npx tsx <scripts>/postmark.ts <domain> --dry-run`
   It only reads. Check for `!` lines (existing records that differ) and "no matching zone" (DNS is not on this Cloudflare token).
2. Wait for an explicit yes. Creating the domain and the DNS records is outward-facing.
3. Run it for real: `npx tsx <scripts>/postmark.ts <domain>`. It creates the domain with Return-Path `pm-bounces.<domain>`, adds the DKIM TXT and the Return-Path CNAME (to `pm.mtasv.net`, DNS only), then retries verification for about four minutes.
4. Report the result. If still pending, DNS needs longer: re-run it later, it is safe to repeat.

## Rules
- Domains whose DNS is not on the Cloudflare token: the script prints "no matching zone". Give the user the records to add at the DNS host, then re-run to verify.
- It never touches SPF or MX, so existing mail keeps working. Mention if SPF should include Postmark (`include:spf.mtasv.net`) only if the user wants it.
- Do not mark the board step done yourself unless the user asks and it is within your scopes.
- Postmark server tokens (used by the Stoke plugin to send) are separate; this skill does not create or print them.

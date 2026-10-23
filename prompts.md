# Migration prompts

Run in order, each in Claude Code. Needs: the SpinupWP MCP, the Cloudflare API MCP, and your SSH key authorised on the target server. Scripts and skills live in `~/Documents/migration-scripts` (`wp-cleanup`, `wp-deploy`).

## 1. Start: clean up the backup (wp-cleanup)

Put the cPanel backup (`backup-*.tar.gz`) in the site's folder first.

```
Use the wp-cleanup skill on <domain> using scripts at /Users/<you>/Documents/migration-scripts.
The backup is <path to backup-*.tar.gz>. Extract only homedir/public_html and mysql into a new
local working folder (not the Google Drive), then run the audit and walk me through the cleanup.
Ask me before removing anything.
```

Finished when the re-audit is clean. The work folder (e.g. `~/Documents/wp-cleanup-work/<domain>`) is the input to step 2.

## 2. Deploy: upload, import, DNS (wp-deploy)

```
Use the wp-deploy skill for <domain>.
Backup folder: <path to the cleaned work folder from step 1>
SSH: <user>@<server IP>
Check the destination first and tell me which case it is: an empty site, a fresh WordPress
install, no SpinupWP site yet (create it with the SpinupWP MCP), or an existing real site (stop
and ask). Ask me for DB details only if SpinupWP did not already create the database. Do not
change DNS or Cloudflare settings until I approve each step. Finish with the handover for Hanibal.
```

If the SpinupWP site does not exist yet, say so: "No SpinupWP site exists yet for <domain> on <server name/IP>; create it."

Things only you can do in the SpinupWP dashboard: create the database and user (empty-site case), add `www` as an additional domain (redirect to primary), and enable HTTPS once DNS points at the server.

## 3. Hand over

Paste the handover block the skill prints at the end into Hanibal. It updates the Stoke Migrate card and saves the SSH access block to the site's notes. It contains no passwords.

## 3b. Postmark sender domain (postmark-domain)

Needs `~/.migrate-2026.env` (see POSTMARK.md). Dry run first, then one yes.

```
Use the postmark-domain skill for <domain> using scripts at /Users/<you>/Documents/migration-scripts.
Run the dry run first and show me the output. Wait for my yes before creating anything.
```

## 4. Later changes with WP-CLI

Template:

```
On <domain> (ssh <user>@<ip>, WP at /sites/<domain>/files), use WP-CLI to <what you want>.
Scope: <what it may touch, e.g. "only pages", "only the options table">.
First take a wp db export backup, dry-run where possible and show me the result, then wait for my
yes before making the change. Don't activate or deactivate plugins or themes. Don't print
passwords. Report what changed and how to undo it.
```

Examples:

```
On <domain> (ssh <user>@<ip>), use WP-CLI to list all active plugins with versions, the active
theme, the 20 largest autoloaded options, and the count of post revisions and expired
transients. Read-only, change nothing.
```

```
On <domain> (ssh <user>@<ip>), use WP-CLI to change the Administration Email Address to
<email>.
```

```
On <domain> (ssh <user>@<ip>), use WP-CLI to set the Stoke Internal Tools Postmark server token
(option stoke_smtp_token) to <token>. Don't print the token; show only the last 4 characters.
```

```
On <domain> (ssh <user>@<ip>), use WP-CLI to replace <old text> with <new text> in post content
and Elementor data. Back up the DB first, dry-run and show me the match count per table, then
wait for my yes before running it for real.
```

```
On <domain> (ssh <user>@<ip>), use WP-CLI to delete post revisions older than 30 days, expired
transients and spam comments. Show me the counts first, back up the DB, then wait for my yes.
```

## Rules to remember

- One explicit yes per outward-facing step (upload, import, URL rewrite, DNS, SSL mode).
- Passwords and tokens are never printed or written to files; the DB password goes only into `wp-config.php`.
- Rotate any password or token that was pasted into chat.
- Rollback for DNS: set the A record back to the old host IP.

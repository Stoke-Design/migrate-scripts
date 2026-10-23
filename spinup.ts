/**
 * Point a migrated site at SpinupWP and harden it: Cloudflare A record + www CNAME, www domain, HTTPS, page cache, backups.
 *
 *   npx tsx spinup.ts <domain> [--yes] [--proxied] [--no-backups]
 *
 * Without `--yes` it only reads and prints what it would change (a dry run). Re-running is safe: anything already
 * correct is skipped. Tokens come from the environment or ~/.migrate-2026.env: CLOUDFLARE_API_TOKEN, SPINUPWP_API_TOKEN
 * (and SPINUPWP_API_BASE, default https://api.spinupwp.app/v1).
 *
 * - A record for @ -> the Spinup server IP. The old address is kept in the record comment as `SYNERGY=<old ip>`.
 *   DNS-only unless `--proxied` (a proxied record with no HTTPS on the origin gives a 525: run once without, then with).
 * - www -> CNAME to @.
 * - Spinup: www as a 301 additional domain, Let's Encrypt HTTPS, page cache on.
 * - Backups: copied from a sibling site on the same server. Read the printed bucket before running with `--yes`.
 */
import { call, cf, findZone, loadEnvFile, requireEnv } from './common'

type Backups = {
  files: boolean
  database: boolean
  storage_provider: { id: number | null; region: string | null; bucket: string | null }
  schedule: Record<'daily' | 'weekly' | 'monthly', Record<string, unknown>>
}
type Site = {
  id: number
  domain: string
  server_id: number
  https: { enabled: boolean }
  additional_domains: { domain: string }[]
  page_cache: { enabled: boolean }
  backups: Backups
  database?: { id: number } | null
}
type DnsRecord = { id: string; type: string; name: string; content: string; proxied: boolean; comment: string | null }

const sp = <T>(method: string, p: string, body?: unknown, form = false) =>
  call<T>(method, (process.env.SPINUPWP_API_BASE || 'https://api.spinupwp.app/v1') + p, { Accept: 'application/json', Authorization: `Bearer ${process.env.SPINUPWP_API_TOKEN}` }, body, form)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function allSites() {
  const out: Site[] = []
  for (let page = 1; page <= 20; page++) {
    const { data } = await sp<{ data: Site[] }>('GET', `/sites?page=${page}&limit=100`)
    out.push(...data)
    if (data.length < 100) break
  }
  return out
}

/** Spinup changes are asynchronous: wait for the event to finish. */
async function waitEvent(res: { event_id?: number }, what: string) {
  if (!res.event_id) return
  for (let i = 0; i < 30; i++) {
    const { data } = await sp<{ data: { status: string } }>('GET', `/events/${res.event_id}`)
    if (data.status === 'deployed' || data.status === 'finished') return console.log(`    ${what}: done`)
    if (data.status === 'failed' || data.status === 'error') throw new Error(`${what} failed (event ${res.event_id})`)
    await sleep(10_000)
  }
  console.log(`    ${what}: still running, check SpinupWP event ${res.event_id}`)
}

/** Most common storage provider among sibling sites on the same server that already back up. */
function siblingBackups(site: Site, sites: Site[]) {
  const siblings = sites.filter((s) => s.server_id === site.server_id && s.id !== site.id && s.backups.storage_provider.id && (s.backups.files || s.backups.database))
  const key = (s: Site) => JSON.stringify(s.backups.storage_provider)
  const counts = new Map<string, number>()
  for (const s of siblings) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1)
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return siblings.find((s) => key(s) === best)
}

/** Schedule from a Spinup Site object in the shape backup-schedule expects. */
function schedulePayload(s: Backups['schedule']) {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !(k === 'time_of_day' && v === null)))
  return { daily_schedule: clean(s.daily), weekly_schedule: clean(s.weekly), monthly_schedule: clean(s.monthly) }
}

async function main() {
  loadEnvFile()
  const [domainArg, ...rest] = process.argv.slice(2)
  if (!domainArg) throw new Error('Usage: npx tsx spinup.ts <domain> [--yes] [--proxied] [--no-backups]')
  requireEnv('CLOUDFLARE_API_TOKEN', 'SPINUPWP_API_TOKEN')
  const name = domainArg.toLowerCase()
  const yes = rest.includes('--yes')
  const proxied = rest.includes('--proxied')
  console.log(`Domain: ${name}${yes ? '' : '  (dry run: add --yes to apply)'}`)

  const sites = await allSites()
  const found = sites.find((s) => s.domain.toLowerCase() === name)
  if (!found) throw new Error(`No SpinupWP site for ${name}: create it first (spinupwp-new-site)`)
  const site = (await sp<{ data: Site }>('GET', `/sites/${found.id}`)).data
  const { data: server } = await sp<{ data: { name: string; ip_address: string } }>('GET', `/servers/${site.server_id}`)
  console.log(`\nSpinup site ${site.id} on ${server.name} (${server.ip_address})`)

  console.log('\nCloudflare')
  const zone = await findZone(name)
  if (!zone) throw new Error('No matching Cloudflare zone on this token: set DNS by hand')
  const records = (n: string) => cf<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(n)}`)
  const apex = (await records(name)).find((r) => r.type === 'A')
  if (!apex) throw new Error(`No A record for ${name} to update`)
  const oldIp = apex.content !== server.ip_address ? apex.content : apex.comment?.match(/SYNERGY=(\S+)/)?.[1]
  const comment = oldIp ? `SYNERGY=${oldIp}` : apex.comment
  if (apex.content === server.ip_address && apex.proxied === proxied && apex.comment === comment) console.log(`  = A ${name} already ${server.ip_address} (${proxied ? 'proxied' : 'DNS-only'}, ${comment ?? 'no comment'})`)
  else {
    console.log(`  ~ A ${name}: ${apex.content} -> ${server.ip_address}, ${proxied ? 'proxied' : 'DNS-only'}, comment "${comment}" (rollback: set it back to ${oldIp ?? 'the old IP'})`)
    if (yes) await cf('PATCH', `/zones/${zone.id}/dns_records/${apex.id}`, { content: server.ip_address, proxied, comment })
  }

  const www = await records(`www.${name}`)
  const cname = www.find((r) => r.type === 'CNAME')
  if (cname?.content === name && cname.proxied === proxied) console.log(`  = CNAME www already -> ${name}`)
  else if (cname) {
    console.log(`  ~ CNAME www: ${cname.content} -> ${name}, ${proxied ? 'proxied' : 'DNS-only'}`)
    if (yes) await cf('PATCH', `/zones/${zone.id}/dns_records/${cname.id}`, { content: name, proxied })
  } else if (www.length) console.log(`  ! www has a ${www[0]!.type} record (${www[0]!.content}): remove it by hand, then re-run`)
  else {
    console.log(`  + CNAME www -> ${name}, ${proxied ? 'proxied' : 'DNS-only'}`)
    if (yes) await cf('POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name: `www.${name}`, content: name, proxied, ttl: 1 })
  }

  console.log('\nSpinupWP')
  if (site.additional_domains.some((d) => d.domain === `www.${name}`)) console.log('  = www domain already added')
  else {
    console.log('  + add www.' + name + ' (301 to the primary domain)')
    if (yes) await sp('POST', `/sites/${site.id}/domains`, { domain: `www.${name}`, 'redirect[enabled]': 'true', 'redirect[type]': '301' }, true)
  }
  if (site.https.enabled) console.log('  = HTTPS already on')
  else {
    console.log("  + enable HTTPS (Let's Encrypt; DNS must already point at this server)")
    if (yes) await waitEvent(await sp('POST', `/sites/${site.id}/https`, { type: 'webroot' }, true), 'HTTPS')
  }
  if (site.page_cache.enabled) console.log('  = page cache already on')
  else {
    console.log('  + enable page cache')
    if (yes) await waitEvent(await sp('POST', `/sites/${site.id}/page-cache`), 'page cache')
  }

  if (rest.includes('--no-backups')) console.log('  - backups skipped (--no-backups)')
  else if (site.backups.files || site.backups.database) console.log(`  = backups already on (${site.backups.storage_provider.bucket})`)
  else {
    const ref = siblingBackups(site, sites)
    if (!ref) console.log(`  ! no site on ${server.name} has backups to copy: set them up by hand`)
    else {
      const sproc = ref.backups.storage_provider
      console.log(`  + backups: bucket ${sproc.bucket} (${sproc.region}), copied from ${ref.domain}. Is this the right bucket for ${server.name}?`)
      console.log(`    schedule ${JSON.stringify(schedulePayload(ref.backups.schedule))}`)
      if (yes) {
        await sp('PUT', `/sites/${site.id}/backup-settings`, { storage_provider_id: sproc.id, storage_provider_bucket: sproc.bucket, storage_provider_region: sproc.region, ...(site.database ? { database: site.database.id } : {}) })
        await sp('PUT', `/sites/${site.id}/backup-schedule`, schedulePayload(ref.backups.schedule))
      }
    }
  }

  if (!yes) return
  console.log('\nChecking')
  const after = (await sp<{ data: Site }>('GET', `/sites/${site.id}`)).data
  console.log(`  https=${after.https.enabled} page cache=${after.page_cache.enabled} backups files=${after.backups.files} db=${after.backups.database} (${after.backups.storage_provider.bucket})`)
  for (const u of [`https://${name}/`, `https://www.${name}/`]) {
    const res = await fetch(u, { redirect: 'manual' }).catch((e: Error) => ({ status: e.message, headers: new Headers() }))
    console.log(`  ${u} -> ${res.status} ${res.headers.get('location') ?? ''}`)
  }
  if (!proxied) console.log('\nDNS is DNS-only. Once HTTPS works, re-run with --proxied --yes to turn the proxy on.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

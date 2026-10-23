/**
 * Create and verify a Postmark sending domain, adding its DNS records in Cloudflare.
 *
 *   npx tsx postmark.ts <domain> [--dry-run]
 *
 * Tokens come from the environment or ~/.migrate-2026.env: POSTMARK_ACCOUNT_TOKEN, CLOUDFLARE_API_TOKEN.
 * The Postmark token is the *account* token (not a server token), so one run covers any server on the account.
 * `--dry-run` only reads: it shows what would be created and touches nothing. Re-running is safe.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PM = 'https://api.postmarkapp.com'
const CF = 'https://api.cloudflare.com/client/v4'
const ENV_FILE = path.join(os.homedir(), '.migrate-2026.env')

type PmDomain = {
  ID: number
  Name: string
  DKIMVerified: boolean
  DKIMHost?: string
  DKIMTextValue?: string
  DKIMPendingHost?: string
  DKIMPendingTextValue?: string
  ReturnPathDomain?: string
  ReturnPathDomainVerified: boolean
  ReturnPathDomainCNAMEValue?: string
}
type CfRecord = { content: string }

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
}

async function call<T>(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`)
  return JSON.parse(text) as T
}

const pm = <T>(method: string, p: string, body?: unknown) =>
  call<T>(method, PM + p, { Accept: 'application/json', 'X-Postmark-Account-Token': process.env.POSTMARK_ACCOUNT_TOKEN! }, body)
const cf = <T>(method: string, p: string, body?: unknown) =>
  call<{ result: T }>(method, CF + p, { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, body).then((r) => r.result)

async function findPostmarkDomain(name: string) {
  const { Domains } = await pm<{ Domains: { ID: number; Name: string }[] }>('GET', '/domains?count=500&offset=0')
  const hit = Domains.find((d) => d.Name.toLowerCase() === name)
  return hit ? pm<PmDomain>('GET', `/domains/${hit.ID}`) : undefined
}

/** Walk up the labels until a Cloudflare zone matches. */
async function findZone(name: string) {
  const parts = name.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const zones = await cf<{ id: string; name: string }[]>('GET', `/zones?name=${parts.slice(i).join('.')}`)
    if (zones[0]) return zones[0]
  }
}

async function ensureRecord(zoneId: string, type: string, name: string, content: string, dry: boolean) {
  const found = await cf<CfRecord[]>('GET', `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`)
  if (found.some((r) => r.content.replace(/^"|"$/g, '') === content)) return console.log(`  = ${type} ${name} already correct`)
  for (const r of found) console.log(`  ! existing ${type} ${name} -> ${r.content.slice(0, 60)}`)
  console.log(`  + ${type} ${name} -> ${content.slice(0, 70)}${content.length > 70 ? '...' : ''}`)
  if (!dry) await cf('POST', `/zones/${zoneId}/dns_records`, { type, name, content, ttl: 1, proxied: false })
}

/** DKIM and Return-Path records from a Postmark domain. */
function recordsFor(d: PmDomain): [string, string, string][] {
  const out: [string, string, string][] = []
  const host = d.DKIMPendingHost || d.DKIMHost
  const value = d.DKIMPendingTextValue || d.DKIMTextValue
  if (host && value) out.push(['TXT', host, value])
  if (d.ReturnPathDomain && d.ReturnPathDomainCNAMEValue) out.push(['CNAME', d.ReturnPathDomain, d.ReturnPathDomainCNAMEValue])
  return out
}

async function main() {
  loadEnvFile()
  const [domainArg, ...rest] = process.argv.slice(2)
  if (!domainArg) throw new Error('Usage: npx tsx postmark.ts <domain> [--dry-run]')
  for (const v of ['POSTMARK_ACCOUNT_TOKEN', 'CLOUDFLARE_API_TOKEN']) {
    if (!process.env[v]) throw new Error(`${v} is not set (put it in ${ENV_FILE})`)
  }
  const name = domainArg.toLowerCase()
  const dry = rest.includes('--dry-run')
  const returnPath = `pm-bounces.${name}`
  console.log(`Domain: ${name}${dry ? '  (dry run)' : ''}`)

  console.log('\nPostmark')
  let d = await findPostmarkDomain(name)
  if (d) console.log(`  domain exists (ID ${d.ID}) DKIM verified=${d.DKIMVerified} return-path verified=${d.ReturnPathDomainVerified}`)
  else if (dry) console.log(`  would create domain ${name} with Return-Path ${returnPath}`)
  else {
    d = await pm<PmDomain>('POST', '/domains', { Name: name, ReturnPathDomain: returnPath })
    console.log(`  created domain (ID ${d.ID})`)
  }

  console.log('\nCloudflare')
  const zone = await findZone(name)
  if (!zone) console.log('  no matching zone on this token: add the records at the DNS host by hand')
  else {
    console.log(`  zone ${zone.name} (${zone.id})`)
    if (d) for (const [type, host, content] of recordsFor(d)) await ensureRecord(zone.id, type, host, content, dry)
    else console.log(`  would add DKIM TXT (<timestamp>pm._domainkey.${name}) and CNAME ${returnPath} -> pm.mtasv.net, DNS only`)
  }

  if (dry || !d || !zone) return
  console.log('\nVerifying')
  for (let attempt = 1; attempt <= 8; attempt++) {
    await pm('PUT', `/domains/${d.ID}/verifyDkim`)
    await pm('PUT', `/domains/${d.ID}/verifyReturnPath`)
    d = await pm<PmDomain>('GET', `/domains/${d.ID}`)
    console.log(`  try ${attempt}: DKIM=${d.DKIMVerified} ReturnPath=${d.ReturnPathDomainVerified}`)
    if (d.DKIMVerified && d.ReturnPathDomainVerified) return console.log('  done')
    await new Promise((r) => setTimeout(r, 30_000))
  }
  console.log('  still pending: DNS may need longer, re-run later')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

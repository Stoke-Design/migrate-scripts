/** Shared by postmark.ts and spinup.ts: env file loading and thin API helpers. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ENV_FILE = path.join(os.homedir(), '.migrate-2026.env')
const CF = 'https://api.cloudflare.com/client/v4'

/** Fill process.env from ~/.migrate-2026.env, parsed like the shell would: quotes and trailing `# comments` are dropped. Variables already set in the shell win. */
export function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m || process.env[m[1]!]) continue
    const raw = m[2]!.trim()
    const quoted = raw.match(/^(['"])(.*?)\1/)
    process.env[m[1]!] = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '').trim()
  }
}

export function requireEnv(...names: string[]) {
  for (const v of names) if (!process.env[v]) throw new Error(`${v} is not set (put it in ${ENV_FILE})`)
}

/** JSON request by default; pass `form` for the form-encoded bodies the SpinupWP docs describe. */
export async function call<T>(method: string, url: string, headers: Record<string, string>, body?: unknown, form = false): Promise<T> {
  const h = { ...headers, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }
  const payload = body ? (form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body)) : undefined
  const res = await fetch(url, { method, headers: h, body: payload })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`)
  return (text ? JSON.parse(text) : {}) as T
}

export const cf = <T>(method: string, p: string, body?: unknown) =>
  call<{ result: T }>(method, CF + p, { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, body).then((r) => r.result)

/** Walk up the labels until a Cloudflare zone matches. */
export async function findZone(name: string) {
  const parts = name.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const zones = await cf<{ id: string; name: string }[]>('GET', `/zones?name=${parts.slice(i).join('.')}`)
    if (zones[0]) return zones[0]
  }
}

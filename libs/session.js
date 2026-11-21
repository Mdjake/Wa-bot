/**
 * lib/session.js — restore the WhatsApp login from an environment variable.
 *
 * Hosts like Render wipe the disk on every deploy, so `session/` cannot live in
 * the repo or on disk. Put the whole folder in one env var instead:
 *
 *   SESSION_ID = <base64 string>
 *
 * Accepted payloads (base64 of any of these):
 *   1. JSON manifest  { "files": { "creds.json": "<base64>", ... } }
 *      — what `node scripts/session-to-env.js` produces
 *   2. a tar.gz of the session folder — what most "session ID" generators give you
 *   3. a bare creds.json
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ENV_KEYS = ['SESSION_ID', 'SESSION', 'SESSION_BASE64', 'WA_SESSION']

/** Which env var holds the session, if any. */
export function sessionEnv() {
  for (const key of ENV_KEYS) {
    if (process.env[key] && process.env[key].trim()) return { key, value: process.env[key] }
  }
  return null
}

/** Join inside the session dir only — an env var must never write outside it. */
function safeJoin(dir, name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '')
  const root = path.resolve(dir)
  const full = path.resolve(root, clean)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside the session folder: ${name}`)
  }
  return full
}

/** Minimal tar reader (ustar) — no dependencies, no system `tar` needed. */
function untar(buf) {
  const out = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (prefix) name = `${prefix}/${name}`
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    const dataStart = off + 512
    const data = buf.subarray(dataStart, dataStart + size)
    off = dataStart + Math.ceil(size / 512) * 512
    if (type === '0' || type === '\0' || type === ' ' || type === '7') out.push({ name, data })
  }
  return out
}

/**
 * `tar -czf - session` stores names as `session/creds.json`; `tar -C session .`
 * stores `./creds.json`. Both must land at the root of the session folder, so a
 * single shared top-level folder is stripped.
 */
function stripCommonRoot(entries) {
  const names = entries.map((e) => String(e.name).replace(/^\.\//, ''))
  const firsts = new Set(names.map((n) => n.split('/')[0]))
  if (firsts.size === 1 && names.some((n) => n.includes('/'))) {
    const root = [...firsts][0]
    return entries.map((e, i) => ({
      name: names[i].slice(root.length + 1) || names[i],
      data: e.data,
    }))
  }
  return entries.map((e, i) => ({ name: names[i], data: e.data }))
}

/** Decode the env string into [{ name, data }] entries. */
export function decodeSessionPayload(raw) {
  const text = String(raw).trim().replace(/^['"]|['"]$/g, '').replace(/^data:.*?base64,/, '').replace(/\s+/g, '')
  if (!text) throw new Error('session env var is empty')

  const buf = Buffer.from(text, 'base64')
  if (!buf.length) throw new Error('session env var is not valid base64')

  // gzip → tar.gz
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const entries = untar(zlib.gunzipSync(buf))
    if (!entries.length) throw new Error('tar.gz payload had no files')
    return { kind: 'tar.gz', entries }
  }
  // plain tar
  if (buf.subarray(257, 262).toString('latin1') === 'ustar') {
    const entries = untar(buf)
    if (!entries.length) throw new Error('tar payload had no files')
    return { kind: 'tar', entries }
  }
  // JSON
  const asText = buf.toString('utf8').trim()
  if (asText.startsWith('{')) {
    const json = JSON.parse(asText)
    if (json.files && typeof json.files === 'object') {
      return {
        kind: 'json',
        entries: Object.entries(json.files).map(([name, b64]) => ({ name, data: Buffer.from(String(b64), 'base64') })),
      }
    }
    // a bare creds.json
    return { kind: 'creds.json', entries: [{ name: 'creds.json', data: buf }] }
  }
  throw new Error('unrecognised payload — expected a JSON manifest, tar.gz or creds.json, base64 encoded')
}

/**
 * Write the session to disk if it is not there yet.
 * Returns { restored, files, kind, source } or { restored: false, reason }.
 */
export function loadSessionFromEnv(dir) {
  const env = sessionEnv()
  if (!env) return { restored: false, reason: 'no session env var set' }

  if (fs.existsSync(path.join(dir, 'creds.json'))) {
    return { restored: false, reason: 'session already on disk — leaving it alone' }
  }

  const decoded = decodeSessionPayload(env.value)
  const { kind } = decoded
  const entries = stripCommonRoot(decoded.entries)

  // Validate every path first, so a bad entry cannot leave a half-written session.
  const plan = entries
    .filter((e) => e.name && !e.name.endsWith('/'))
    .map((e) => ({ full: safeJoin(dir, e.name), data: e.data }))
  if (!plan.some((p) => p.full === path.join(path.resolve(dir), 'creds.json'))) {
    throw new Error('session payload did not contain creds.json')
  }

  let files = 0
  for (const { full, data } of plan) {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, data)
    files++
  }

  return { restored: true, files, kind, source: env.key }
}

#!/usr/bin/env node
/**
 * Turn your paired ./session folder into one string for SESSION_ID.
 *
 *   node scripts/session-to-env.js            # prints the string to stdout
 *   node scripts/session-to-env.js myfolder   # or another folder
 *   node scripts/session-to-env.js > session.txt
 *
 * Only the base64 string goes to stdout, so redirecting it gives a clean file.
 * Everything else goes to stderr.
 */

import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] || 'session'

if (!fs.existsSync(dir)) {
  console.error(`\nNo "${dir}" folder here.`)
  console.error('Run this from your bot folder, after you have paired once (node index.js).\n')
  process.exit(1)
}

const files = {}
const walk = (d) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name)
    if (entry.isDirectory()) walk(full)
    else files[path.relative(dir, full).replace(/\\/g, '/')] = fs.readFileSync(full).toString('base64')
  }
}
walk(dir)

const names = Object.keys(files)
if (!names.includes('creds.json')) {
  console.error(`\n"${dir}" has no creds.json — that is not a Baileys session folder.\n`)
  process.exit(1)
}

const payload = Buffer.from(JSON.stringify({ files }), 'utf8').toString('base64')

console.error(`\n${names.length} files (${(payload.length / 1024).toFixed(1)} KB of base64): ${names.join(', ')}`)
console.error('\nPaste the string below into Render → your service → Environment → SESSION_ID.')
console.error('Anyone holding this string can use your WhatsApp account. Treat it like a password.\n')
process.stdout.write(payload + '\n')

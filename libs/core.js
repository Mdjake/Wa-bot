/**
 * lib/core.js — everything shared by the bot and every command file.
 *
 * Config, storage, helpers, the command registry and the live socket.
 * Commands import from here; nothing here imports index.js, so there are no cycles.
 */

import * as Baileys from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ─────────────────────────── CONFIG ─────────────────────────── */

export const VERSION = '2.3.0'
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  botName: 'My Bot',
  ownerName: 'Owner',
  // Your own number(s) with country code, no + or spaces.
  ownerNumbers: ['919999999999'],
  prefixes: ['.'],
  sessionDir: 'session',
  dataDir: 'data',
  // public = everyone, private = owner only (auto features still on), self = owner only, nothing else
  mode: 'public',
  cooldownMs: 1500,
  spam: { max: 12, windowMs: 10000, blockMs: 15000 },
  features: { antidelete: true, autoread: false, typing: true },
  groupDefaults: { welcome: false, goodbye: false, antilink: 'off', antivv: false },
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object') deepMerge(target[k], v)
    else target[k] = v
  }
  return target
}

function loadConfig() {
  const cfg = structuredClone(DEFAULTS)
  const file = path.join(ROOT, 'config.json')
  if (fs.existsSync(file)) {
    try {
      deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (e) {
      console.error('config.json is not valid JSON — ignoring it:', e.message)
    }
  }
  if (process.env.OWNER_NUMBERS) {
    cfg.ownerNumbers = process.env.OWNER_NUMBERS.split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean)
  }
  if (process.env.BOT_NAME) cfg.botName = process.env.BOT_NAME
  if (process.env.BOT_MODE) cfg.mode = process.env.BOT_MODE
  if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR   // e.g. a Render disk
  if (process.env.SESSION_DIR) cfg.sessionDir = process.env.SESSION_DIR
  cfg.ownerNumbers = cfg.ownerNumbers.map((n) => String(n).replace(/\D/g, '')).filter(Boolean)
  cfg.prefixes = (Array.isArray(cfg.prefixes) ? cfg.prefixes : [cfg.prefixes]).filter(Boolean)
  if (!cfg.prefixes.length) cfg.prefixes = ['.']
  return cfg
}

export const CONFIG = loadConfig()
export const PREFIX = CONFIG.prefixes[0]
export const silentLogger = pino({ level: 'silent' })
export const startedAt = Date.now()

/* ─────────────────────────── STORAGE ─────────────────────────── */

// absolute DATA_DIR (a mounted disk) wins over the project-relative default
fs.mkdirSync(path.resolve(ROOT, CONFIG.dataDir), { recursive: true })

function createStore(name, initial) {
  const file = path.resolve(ROOT, CONFIG.dataDir, `${name}.json`)
  let data = structuredClone(initial)
  try {
    if (fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    console.error(`[store] ${name}.json unreadable, starting fresh:`, e.message)
  }
  let timer = null
  const write = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2))
    } catch (e) {
      console.error(`[store] could not write ${name}.json:`, e.message)
    }
  }
  return {
    get data() {
      return data
    },
    save() {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        write()
      }, 400)
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      write()
    },
  }
}

export const db = {
  settings: createStore('settings', { mode: CONFIG.mode, features: CONFIG.features, groups: {}, sudo: [], banned: [], prefixes: null }),
  stats: createStore('stats', { commands: {}, messages: 0, since: Date.now() }),
  notes: createStore('notes', {}),
  todos: createStore('todos', {}),
  afk: createStore('afk', {}),
  reminders: createStore('reminders', { items: [] }),
  levels: createStore('levels', {}),
  activity: createStore('activity', {}),
  expenses: createStore('expenses', {}),
  bookmarks: createStore('bookmarks', {}),
  badwords: createStore('badwords', {}),
  rules: createStore('rules', {}),
  warns: createStore('warns', {}),
}

export const settings = db.settings.data
if (Array.isArray(settings.prefixes) && settings.prefixes.length) CONFIG.prefixes = settings.prefixes

/** Per-group settings, created on first use. */
export const groupCfg = (jid) => {
  settings.groups[jid] = { ...CONFIG.groupDefaults, ...(settings.groups[jid] || {}) }
  return settings.groups[jid]
}

/* ─────────────────────────── UTILS ─────────────────────────── */

export const numOf = (jid = '') => String(jid).split('@')[0].split(':')[0]
export const numOfSafe = (v) => Math.round(Number(v) * 100) / 100
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const rand = (arr) => arr[Math.floor(Math.random() * arr.length)]
export const clean = (t = '') => String(t).replace(/\s+/g, ' ').trim()
export const clip = (t = '', n = 900) => (t.length > n ? `${t.slice(0, n)}…` : t)
export const codeBlock = (t) => '```\n' + t + '\n```'
export const mention = (jid) => `@${numOf(jid)}`

export function parseDuration(input) {
  const s = String(input || '').toLowerCase().trim()
  const m = s.match(/^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/)
  if (!m || !s) return 0
  const [, d, h, mi, se] = m
  return ((+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+se || 0)) * 1000
}

export function humanDuration(ms) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, sec && `${sec}s`].filter(Boolean).join(' ') || '0s'
}

export function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

/** Safe arithmetic — no eval. Supports + - * / % ^ ( ) and a few Math functions. */
export function calc(input) {
  const s = String(input).replace(/\s+/g, '').toLowerCase()
  if (!s) throw new Error('nothing to calculate')
  if (s.length > 200) throw new Error('expression too long')
  let i = 0
  const peek = () => s[i]
  const fns = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    log: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round,
    floor: Math.floor, ceil: Math.ceil, exp: Math.exp,
  }

  function number() {
    const start = i
    while (i < s.length && /[0-9.]/.test(s[i])) i++
    if (start === i) throw new Error(`expected a number at position ${i + 1}`)
    const n = Number(s.slice(start, i))
    if (!Number.isFinite(n)) throw new Error('bad number')
    return n
  }

  function primary() {
    const c = peek()
    if (c === '(') {
      i++
      const v = expr()
      if (peek() !== ')') throw new Error('missing )')
      i++
      return v
    }
    if (c === '-') { i++; return -primary() }
    if (c === '+') { i++; return primary() }
    if (c && /[a-z]/.test(c)) {
      const start = i
      while (i < s.length && /[a-z]/.test(s[i])) i++
      const name = s.slice(start, i)
      if (name === 'pi') return Math.PI
      if (name === 'e') return Math.E
      if (!fns[name]) throw new Error(`unknown function "${name}"`)
      if (peek() !== '(') throw new Error(`expected ( after ${name}`)
      i++
      const v = expr()
      if (peek() !== ')') throw new Error('missing )')
      i++
      return fns[name](v)
    }
    return number()
  }

  function power() {
    const base = primary()
    if (peek() === '^') { i++; return Math.pow(base, power()) }
    return base
  }

  function term() {
    let v = power()
    while (peek() && '*/%'.includes(peek())) {
      const op = s[i++]
      const r = power()
      v = op === '*' ? v * r : op === '/' ? v / r : v % r
    }
    return v
  }

  function expr() {
    let v = term()
    while (peek() === '+' || peek() === '-') {
      const op = s[i++]
      const r = term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  const out = expr()
  if (i !== s.length) throw new Error(`unexpected "${s.slice(i)}"`)
  if (!Number.isFinite(out)) throw new Error('result is not a finite number')
  return out
}

export async function httpGet(url, ms = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'wa-bot' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('the request timed out')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/* ── text encoders used by the tools commands ── */

export const FANCY_MAP = (() => {
  const up = '𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭'
  const lo = '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇'
  const map = {}
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { map[c] = [...up][i] })
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { map[c] = [...lo][i] })
  return map
})()
export const toFancy = (s) => [...s].map((c) => FANCY_MAP[c] || c).join('')

export const MORSE = {
  a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---',
  k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-',
  u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---',
  3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
}
export const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]))
export const toMorse = (s) =>
  s.toLowerCase().split('').map((c) => (c === ' ' ? '/' : MORSE[c] || '')).filter(Boolean).join(' ')
export const fromMorse = (s) =>
  s.trim().split(/\s+/).map((t) => (t === '/' ? ' ' : MORSE_REV[t] || '?')).join('')

/* ── XP levels ── */

export const levelFor = (xp) => Math.floor(Math.sqrt(Math.max(xp, 0) / 50)) + 1
export const xpForLevel = (lvl) => 50 * lvl * lvl

/* ─────────────────────────── MESSAGE PARSING ─────────────────────────── */

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']

/** Peel wrapper messages so the real content is visible. */
export function unwrap(message) {
  let msg = message
  let guard = 0
  while (msg && guard++ < 6) {
    const key = WRAPPERS.find((k) => msg[k]?.message)
    if (!key) break
    msg = msg[key].message
  }
  return msg || null
}

export function getText(m) {
  const msg = unwrap(m.message)
  if (!msg) return ''
  const type = Baileys.getContentType(msg)
  if (!type) return ''
  if (type === 'conversation') return msg.conversation || ''
  if (type === 'extendedTextMessage') return msg.extendedTextMessage?.text || ''
  if (type === 'buttonsResponseMessage') return msg.buttonsResponseMessage?.selectedButtonId || ''
  if (type === 'listResponseMessage') return msg.listResponseMessage?.singleSelectReply?.selectedRowId || ''
  if (type === 'templateButtonReplyMessage') return msg.templateButtonReplyMessage?.selectedId || ''
  return msg[type]?.caption || ''
}

export function getQuoted(m, s) {
  const msg = unwrap(m.message)
  if (!msg) return null
  const type = Baileys.getContentType(msg)
  const ctx = msg[type]?.contextInfo
  if (!ctx?.quotedMessage) return null
  return {
    key: {
      remoteJid: m.key.remoteJid,
      fromMe: ctx.participant ? numOf(ctx.participant) === numOf(s?.user?.id) : false,
      id: ctx.stanzaId,
      participant: ctx.participant,
    },
    message: ctx.quotedMessage,
    pushName: ctx.pushName,
  }
}

/** Every phone number a message key could refer to (handles @lid participants). */
export function candidateNumbers(m) {
  const k = m.key || {}
  const out = new Set()
  for (const j of [k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt]) {
    if (j && !j.endsWith('@g.us') && !j.endsWith('@broadcast')) out.add(numOf(j))
  }
  return out
}

export const isOwner = (m) => {
  const nums = candidateNumbers(m)
  return CONFIG.ownerNumbers.some((n) => nums.has(n))
}

/** Trusted users added with .sudo — same powers as the owner. */
export const isSudo = (m) => {
  const nums = candidateNumbers(m)
  return (settings.sudo || []).some((n) => nums.has(n))
}

/* ─────────────────────────── LIVE SOCKET ─────────────────────────── */

/**
 * Live binding: index.js calls setSock() on every (re)connect, and every module
 * that imports `sock` sees the current socket — including after a reconnect.
 */
export let sock = null
export function setSock(s) {
  sock = s
}

export const msgCache = new Map() // id -> { key, message }
export function cacheMessage(m) {
  if (!m?.key?.id || !m.message) return
  msgCache.set(m.key.id, { key: m.key, message: m.message })
  if (msgCache.size > 400) msgCache.delete(msgCache.keys().next().value)
}

/* ── small helpers commands lean on ── */

/** Content type of an (already unwrapped) message object. */
export const contentType = (msg) => Baileys.getContentType(msg || {})

/** Everyone mentioned in a message. */
export function mentionedJids(m) {
  const msg = unwrap(m?.message)
  if (!msg) return []
  return msg[Baileys.getContentType(msg)]?.contextInfo?.mentionedJid || []
}

/** Shared on/off switch for per-group booleans (.welcome, .goodbye, ...). */
export async function toggleFlag(ctx, key, label) {
  const v = (ctx.args[0] || '').toLowerCase()
  if (!['on', 'off'].includes(v)) {
    return ctx.reply(`Usage: ${PREFIX}${key} on|off\nCurrent: ${groupCfg(ctx.jid)[key] ? 'on' : 'off'}`)
  }
  groupCfg(ctx.jid)[key] = v === 'on'
  db.settings.save()
  await ctx.reply(`✅ ${label}: *${v}*`)
}

/* ─────────────────────────── REMINDERS ─────────────────────────── */

export function armReminder(item) {
  const left = item.at - Date.now()
  if (left <= 0) return fireReminder(item)
  setTimeout(() => fireReminder(item), Math.min(left, 2 ** 31 - 1))
}

export async function fireReminder(item) {
  try {
    await sock.sendMessage(item.jid, { text: `⏰ *Reminder* for @${numOf(item.by)}\n\n${item.text}`, mentions: [item.by] })
  } catch (e) {
    console.error('[remind] send failed:', e?.message || e)
  }
  db.reminders.data.items = db.reminders.data.items.filter((r) => r.id !== item.id)
  db.reminders.save()
}

/** Re-arm saved reminders after a restart or reconnect. */
export function armReminders() {
  for (const item of db.reminders.data.items) armReminder(item)
}

/* ─────────────────────────── GROUP HELPERS ─────────────────────────── */

export const isGroupJid = (jid = '') => jid.endsWith('@g.us')

export async function groupMeta(jid) {
  try {
    return await sock.groupMetadata(jid)
  } catch (e) {
    console.error('[group] metadata failed:', e?.message || e)
    return null
  }
}

export const isAdminOf = (meta, jid) => {
  const p = meta?.participants?.find((x) => numOf(x.id) === numOf(jid))
  return !!p && (p.admin === 'admin' || p.admin === 'superadmin')
}

export const isBotAdminOf = (meta) => isAdminOf(meta, sock.user?.id)

/** Resolve an @mention / phone number / reply target to a participant jid. */
export function participantJid(m, jid) {
  const msg = unwrap(m.message)
  const ctx = msg?.[Baileys.getContentType(msg)]?.contextInfo
  const mentioned = ctx?.mentionedJid?.[0]
  if (mentioned) return mentioned
  const quoted = getQuoted(m, sock)
  if (quoted?.key?.participant) return quoted.key.participant
  const digits = String(jid || '').replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}

/* ─────────────────────────── MEDIA ─────────────────────────── */

export async function downloadMedia(messageLike, kind = 'buffer') {
  return Baileys.downloadMediaMessage(messageLike, kind, {}, {
    logger: silentLogger,
    reuploadRequest: sock?.updateMediaMessage,
  })
}

export async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    throw new Error('sharp is not installed — run: npm i sharp')
  }
}

export async function toWebp(buf, type) {
  if (type.includes('stickerMessage')) return buf
  if (type.includes('imageMessage')) {
    const sharp = await loadSharp()
    return sharp(buf)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 82 })
      .toBuffer()
  }
  return await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=12',
      '-t', '6', '-loop', '0', '-an', '-vsync', '0',
      '-f', 'webp', 'pipe:1',
    ])
    const chunks = []
    ff.stdout.on('data', (c) => chunks.push(c))
    ff.on('error', () => reject(new Error('ffmpeg not found — install ffmpeg for video stickers')))
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))))
    ff.stdin.end(buf)
  })
}

/* ─────────────────────────── AUTO-FEATURES ─────────────────────────── */

const LINK_RE = /(chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.me\/\d+|https?:\/\/\S+)/i

export async function checkAntilink(ctx) {
  const { m, jid, isGroup, text } = ctx
  if (!isGroup || !text) return false
  const cfg = groupCfg(jid)
  if (cfg.antilink === 'off' || !cfg.antilink) return false
  if (!LINK_RE.test(text)) return false
  const meta = await groupMeta(jid)
  if (!meta) return false
  if (isAdminOf(meta, ctx.sender)) return false
  if (!isBotAdminOf(meta)) return false
  if (cfg.antilink === 'delete') {
    try {
      await sock.sendMessage(jid, { delete: m.key })
    } catch (e) {
      console.error('[antilink] could not delete (need admin):', e?.message || e)
      return false
    }
  }
  await sock
    .sendMessage(jid, { text: `⚠️ @${numOf(ctx.sender)} links are not allowed here.`, mentions: [ctx.sender] }, { quoted: m })
    .catch(() => {})
  return true
}

export async function checkBadwords(ctx) {
  const { m, jid, isGroup, text, sender } = ctx
  if (!isGroup || !text) return false
  const cfg = db.badwords.data[jid]
  if (!cfg?.on || !cfg.words?.length) return false
  const lower = text.toLowerCase()
  if (!cfg.words.some((w) => lower.includes(w))) return false
  const meta = await groupMeta(jid)
  if (!meta || isAdminOf(meta, sender)) return false
  if (isBotAdminOf(meta)) {
    try {
      await sock.sendMessage(jid, { delete: m.key })
    } catch (e) {
      console.error('[badword] could not delete:', e?.message || e)
    }
  }
  await sock
    .sendMessage(jid, { text: `⚠️ @${numOf(sender)} that word is not allowed here.`, mentions: [sender] }, { quoted: m })
    .catch(() => {})
  return true
}

/* ─────────────────────────── REGISTRY ─────────────────────────── */

export const commands = new Map()
export const gameState = new Map() // jid -> { kind, answer, extra }

export function register(def) {
  if (!def?.name || typeof def.run !== 'function') throw new Error('bad command definition')
  def.aliases = def.aliases || []
  def.category = def.category || 'general'
  def.cooldown = def.cooldown ?? CONFIG.cooldownMs
  commands.set(def.name, def)
  for (const a of def.aliases) commands.set(a, def)
}

export const allCommands = () => [...new Set(commands.values())].sort((a, b) => a.name.localeCompare(b.name))

export const flushAll = () => {
  for (const s of Object.values(db)) s.flush()
}

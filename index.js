/**
 * WhatsApp bot — core only.
 *
 *   index.js          this file: socket, events, message pipeline, command runner
 *   lib/core.js       config, storage, helpers, command registry, live socket
 *   lib/loader.js     loads every file under commands/
 *   commands/<cat>/   one file per command — add, edit, delete freely
 *   config.json       your settings
 *
 * Adding a command never means editing this file: drop a file in commands/.
 */

import * as Baileys from '@whiskeysockets/baileys'
import pino from 'pino'
import readline from 'node:readline'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROOT, CONFIG, VERSION, settings, db, groupCfg, sock, setSock,
  commands, allCommands, silentLogger, startedAt, flushAll,
  numOf, sleep, humanDuration, isOwner, isSudo,
  unwrap, getText, getQuoted, cacheMessage,
  isGroupJid, groupMeta, isAdminOf, isBotAdminOf,
  downloadMedia, checkAntilink, checkBadwords, armReminders,
  // re-exported for tests and tooling
  calc, parseDuration, toWebp, gameState, levelFor, toMorse, fromMorse, toFancy,
} from './lib/core.js'
import { loadCommands, reloadCommands, commandFiles, COMMANDS_DIR } from './lib/loader.js'
import { loadSessionFromEnv } from './lib/session.js'

/* ─────────────────────────── STATE ─────────────────────────── */

let starting = false
let reconnectAttempts = 0
let pairedNumber = null
const cooldowns = new Map() // "user:cmd" -> timestamp
const spamTracker = new Map() // user -> [timestamps]
const blockedUntil = new Map() // user -> timestamp

/* ─────────────────────────── SOCKET ─────────────────────────── */

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()) }))
}

async function makeSocket() {
  const makeWASocket = Baileys.makeWASocket || Baileys.default
  const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = Baileys

  const { state, saveCreds } = await useMultiFileAuthState(path.resolve(ROOT, CONFIG.sessionDir))
  const { version } = await fetchLatestBaileysVersion()

  const s = makeWASocket({
    version,
    auth: state,
    logger: silentLogger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => (await import('./lib/core.js')).msgCache.get(key.id)?.message,
  })

  s.ev.on('creds.update', saveCreds)

  // Pairing: only when there is no registered session yet.
  if (!s.authState.creds.registered) {
    if (!pairedNumber) {
      const raw = await ask('Number with country code (no +, e.g. 919876543210): ')
      pairedNumber = raw.replace(/\D/g, '')
      if (!pairedNumber) {
        console.log('No number given — exiting.')
        process.exit(1)
      }
    }
    await sleep(3000)
    const code = await s.requestPairingCode(pairedNumber)
    console.log(`\nPAIRING CODE: ${code}\nWhatsApp > Linked devices > Link with phone number\n`)
  }

  return s
}

async function start() {
  if (starting) return
  starting = true
  let s
  try {
    s = await makeSocket()
    setSock(s)
    starting = false
  } catch (e) {
    starting = false
    console.error('[start] failed:', e?.message || e)
    scheduleReconnect()
    return
  }

  s.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      reconnectAttempts = 0
      console.log(`✅ Connected as ${numOf(s.user?.id)} — ${CONFIG.botName} v${VERSION} is live.`)
      console.log(`   ${allCommands().length} commands from ${commandFiles().length} files. Prefix: ${CONFIG.prefixes.join(' ')}`)
      armReminders()
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const reason = Object.keys(Baileys.DisconnectReason).find((k) => Baileys.DisconnectReason[k] === code) || code
      if (code === Baileys.DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete the "session" folder and run again to re-pair.')
        process.exit(0)
      }
      console.log(`[conn] closed (${reason}) — reconnecting…`)
      scheduleReconnect()
    }
  })

  s.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        await handleMessage(s, m)
      } catch (e) {
        console.error('[msg] handler error:', e?.stack || e?.message || e)
      }
    }
  })

  s.ev.on('group-participants.update', onParticipantsUpdate)
  s.ev.on('messages.update', onMessagesUpdate)
  s.ev.on('call', async (calls) => {
    for (const c of calls) {
      if (c.status === 'offer') {
        try { await s.rejectCall(c.id, c.from) } catch {}
      }
    }
  })
}

function scheduleReconnect() {
  reconnectAttempts = Math.min(reconnectAttempts + 1, 6)
  const wait = Math.min(2000 * reconnectAttempts, 15000)
  console.log(`[conn] retry #${reconnectAttempts} in ${wait / 1000}s`)
  setTimeout(() => { if (!starting) start() }, wait)
}

/* ─────────────────────────── AUTO-FEATURES ─────────────────────────── */

async function onParticipantsUpdate({ id, participants, action }) {
  const cfg = groupCfg(id)
  const meta = await groupMeta(id)
  const name = meta?.subject || 'this group'

  for (const p of participants) {
    const tag = `@${numOf(p.id)}`
    const base = { mentions: [p.id] }
    try {
      if (action === 'add' && cfg.welcome) {
        await sock.sendMessage(id, { text: `👋 Welcome ${tag} to *${name}*!\nRead the group rules and say hi.`, ...base })
      }
      if (action === 'remove' && cfg.goodbye) {
        await sock.sendMessage(id, { text: `👋 ${tag} left *${name}*. Goodbye!`, ...base })
      }
      if (action === 'promote') await sock.sendMessage(id, { text: `⭐ ${tag} is now an admin.`, ...base })
      if (action === 'demote') await sock.sendMessage(id, { text: `⬇️ ${tag} is no longer an admin.`, ...base })
    } catch (e) {
      console.error('[welcome] send failed:', e?.message || e)
    }
  }
}

async function onMessagesUpdate(updates) {
  if (!settings.features?.antidelete) return
  const { msgCache } = await import('./lib/core.js')
  for (const u of updates) {
    if (!u?.key?.id) continue
    if (u.update?.message !== null) continue
    if (u.update?.status != null) continue // read/delivered receipt, not a delete
    const cached = msgCache.get(u.key.id)
    if (!cached) continue
    const jid = u.key.remoteJid
    const who = u.key.participant || jid
    try {
      const body = getText({ message: cached.message }) || ''
      const type = unwrap(cached.message) ? Baileys.getContentType(unwrap(cached.message)) || 'message' : 'message'
      const head = `🗑️ *Deleted message* from @${numOf(who)}`
      if (body) {
        await sock.sendMessage(jid, { text: `${head}\n\n${body.length > 700 ? body.slice(0, 700) + '…' : body}`, mentions: [who] })
      } else {
        try {
          const buf = await downloadMedia(cached, 'buffer')
          const mediaType = type.replace('Message', '')
          if (buf && ['image', 'video', 'audio'].includes(mediaType)) {
            await sock.sendMessage(jid, { [mediaType]: buf, caption: head, mentions: [who] })
          } else {
            await sock.sendMessage(jid, { text: `${head}\n\n(${type})`, mentions: [who] })
          }
        } catch {
          await sock.sendMessage(jid, { text: `${head}\n\n(${type})`, mentions: [who] })
        }
      }
    } catch (e) {
      console.error('[antidelete] failed:', e?.message || e)
    }
  }
}

/* ─────────────────────────── COMMAND RUNNER ─────────────────────────── */

function makeCtx(s, m, jid, text, cmd, args) {
  const isGroup = isGroupJid(jid)
  const sender = isGroup ? (m.key.participant || m.participant || jid) : (m.key.remoteJidAlt || jid)
  const quoted = getQuoted(m, s)
  let metaCache = null
  return {
    sock: s, m, jid, text, command: cmd, args, argStr: args.join(' '),
    isGroup, sender, senderNumber: numOf(sender), pushName: m.pushName,
    quoted, isOwner: isOwner(m), isSudo: isSudo(m),
    send: (content, opts = {}) => s.sendMessage(jid, content, { quoted: m, ...opts }),
    reply: (t, opts = {}) => s.sendMessage(jid, { text: String(t), ...opts }, { quoted: m }),
    react: async (emoji) => {
      try { await s.sendMessage(jid, { react: { text: emoji, key: m.key } }) } catch {}
    },
    meta: async () => (metaCache ||= await groupMeta(jid)),
  }
}

async function runCommand(ctx) {
  const def = commands.get(ctx.command)
  if (!def) return false

  // owner and sudo users share owner-level access
  const owner = ctx.isOwner || ctx.isSudo || ctx.m.key.fromMe
  if (def.realOwner && !ctx.isOwner && !ctx.m.key.fromMe) {
    await ctx.reply('👑 Only the real owner can run this.')
    return true
  }
  if (settings.mode === 'self' && !owner) return true
  if (settings.mode === 'private' && !owner) {
    await ctx.reply('🔒 This bot is in private mode — only the owner can use commands.')
    return true
  }
  if (def.owner && !owner) {
    await ctx.reply('👑 This command is for the owner only.')
    return true
  }
  if (def.group && !ctx.isGroup) {
    await ctx.reply('👥 This command only works in a group.')
    return true
  }

  if (def.admin || def.botAdmin) {
    const meta = await ctx.meta()
    if (!meta) return true
    if (def.admin && !owner && !isAdminOf(meta, ctx.sender)) {
      await ctx.reply('🛡️ You need to be a group admin for this.')
      return true
    }
    if (def.botAdmin && !isBotAdminOf(meta)) {
      await ctx.reply('🤖 I need to be a group admin for this.')
      return true
    }
  }

  const key = `${ctx.senderNumber}:${def.name}`
  const last = cooldowns.get(key) || 0
  if (last + def.cooldown - Date.now() > 0 && !owner) {
    await ctx.react('⏳')
    return true
  }
  cooldowns.set(key, Date.now())

  db.stats.data.commands[def.name] = (db.stats.data.commands[def.name] || 0) + 1
  db.stats.save()

  try {
    if (settings.features?.typing && !ctx.isGroup) presence(ctx.jid)
    await def.run(ctx)
  } catch (e) {
    console.error(`[cmd:${def.name}]`, e?.stack || e)
    try { await ctx.reply(`❌ *${def.name}* failed: ${e.message}`) } catch {}
  }
  return true
}

function presence(jid) {
  try {
    sock.presenceSubscribe(jid)
    sock.sendPresenceUpdate('composing', jid)
      .then(() => sleep(1200))
      .then(() => sock.sendPresenceUpdate('paused', jid))
      .catch(() => {})
  } catch {}
}

/** Full pipeline for one incoming message. Exported so it can be tested without WhatsApp. */
async function handleMessage(s, m) {
  if (!m?.message || !m.key?.remoteJid) return
  if (s) setSock(s)
  const jid = m.key.remoteJid

  // ignore history/offline replays so old commands never run
  const ts = Number(m.messageTimestamp || 0)
  if (ts && Date.now() / 1000 - ts > 300) return
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return

  cacheMessage(m)
  db.stats.data.messages += 1
  db.stats.save()

  if (settings.features?.autoread && !m.key.fromMe) {
    try { await s.readMessages([m.key]) } catch {}
  }

  if (settings.mode === 'self' && !isOwner(m) && !m.key.fromMe) return

  const un = numOf(m.key.participant || jid)
  const now = Date.now()
  const isGroup = isGroupJid(jid)
  const sender = isGroup ? (m.key.participant || m.participant || jid) : (m.key.remoteJidAlt || jid)

  // banned users get no response at all
  if ((settings.banned || []).includes(un) && !isOwner(m)) return

  // XP + per-group activity tracking
  const lv = (db.levels.data[un] ||= { xp: 0, name: '' })
  lv.xp += 5
  if (m.pushName) lv.name = m.pushName
  db.levels.save()
  if (isGroup) {
    const act = (db.activity.data[jid] ||= {})
    act[un] = (act[un] || 0) + 1
    db.activity.save()
  }

  const text = getText(m)

  // AFK: someone came back, or someone tagged an AFK user
  const afkDb = db.afk.data
  if (afkDb[un]) {
    const since = humanDuration(now - afkDb[un].at)
    delete afkDb[un]
    db.afk.save()
    await s.sendMessage(jid, { text: `👋 Welcome back @${un}! You were away for ${since}.`, mentions: [`${un}@s.whatsapp.net`] }, { quoted: m }).catch(() => {})
  }
  const msgObj = unwrap(m.message) || {}
  const mentioned = msgObj[Baileys.getContentType(msgObj) || '']?.contextInfo?.mentionedJid || []
  for (const j of mentioned) {
    const rec = afkDb[numOf(j)]
    if (rec) {
      await s.sendMessage(jid, { text: `💤 @${numOf(j)} is AFK: ${rec.reason}\nSince ${new Date(rec.at).toLocaleString()}`, mentions: [j] }, { quoted: m }).catch(() => {})
    }
  }

  // antivv — reveal view-once media (it carries no text, so before the text check)
  const voWrap = m.message?.viewOnceMessage || m.message?.viewOnceMessageV2 || m.message?.viewOnceMessageV2Extension
  if (isGroup && voWrap?.message && groupCfg(jid).antivv) {
    const inner = unwrap(m.message)
    const vt = Baileys.getContentType(inner || {}) || ''
    if (/imageMessage|videoMessage/.test(vt)) {
      try {
        const buf = await downloadMedia({ key: m.key, message: inner }, 'buffer')
        await s.sendMessage(jid, {
          [vt.replace('Message', '')]: buf,
          caption: `👁️ View-once from @${numOf(sender)}`,
          mentions: [sender],
        }, { quoted: m })
      } catch (e) {
        console.error('[antivv] could not open:', e?.message || e)
      }
    }
  }

  if (!text) return

  // antilink and bad words run on ordinary chat messages too, before the prefix check
  if (await checkAntilink({ m, jid, isGroup, text, sender })) return
  if (await checkBadwords({ m, jid, isGroup, text, sender })) return

  if (!CONFIG.prefixes.some((p) => text.startsWith(p))) return

  const usedPrefix = CONFIG.prefixes.find((p) => text.startsWith(p))
  const body = text.slice(usedPrefix.length).trim()
  if (!body) return

  // spam guard — only counts actual commands
  if (blockedUntil.get(un) > now) return
  const hits = (spamTracker.get(un) || []).filter((t) => now - t < CONFIG.spam.windowMs)
  hits.push(now)
  spamTracker.set(un, hits)
  if (hits.length > CONFIG.spam.max) {
    blockedUntil.set(un, now + CONFIG.spam.blockMs)
    spamTracker.delete(un)
    if (settings.mode === 'public') {
      console.log(`[spam] ${un} blocked for ${CONFIG.spam.blockMs / 1000}s`)
      return
    }
  }

  const [rawCmd, ...args] = body.split(/\s+/)
  const cmd = rawCmd.toLowerCase()
  const ctx = makeCtx(s, m, jid, text, cmd, args)

  // .help <command> detail view
  const target = args[0]?.toLowerCase()
  if (['help', 'h'].includes(cmd) && target && commands.has(target)) {
    const def = commands.get(target)
    return ctx.reply(`*${usedPrefix}${def.name}*\n${def.desc}\n\n📖 Usage: ${def.usage || `${usedPrefix}${def.name}`}\n🏷️ Category: ${def.category}${def.aliases?.length ? `\n🔁 Aliases: ${def.aliases.map((a) => usedPrefix + a).join(', ')}` : ''}${def.owner ? '\n👑 Owner only' : ''}${def.admin ? '\n🛡️ Group admin only' : ''}`)
  }

  await runCommand(ctx)
}

/* ─────────────────────────── BOOT ─────────────────────────── */

process.on('SIGINT', () => {
  console.log('\n[exit] saving data…')
  flushAll()
  process.exit(0)
})
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e))
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e))

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// Load every command file before anything else can use the registry.
const loadedFiles = await loadCommands()

/**
 * Hosts that give you a PORT (Render, Railway, Fly, Koyeb) need something to
 * answer HTTP, otherwise the deploy is marked unhealthy and killed.
 */
function startHealthServer() {
  const port = Number(process.env.PORT)
  if (!port) return
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      bot: CONFIG.botName,
      version: VERSION,
      commands: allCommands().length,
      connected: !!sock?.user,
      uptime: humanDuration(Date.now() - startedAt),
    }))
  }).listen(port, () => console.log(`[web] health server listening on :${port}`))
}

if (isMain) {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(`${CONFIG.botName} v${VERSION}`)
    process.exit(0)
  }
  console.log(`🤖 ${CONFIG.botName} v${VERSION}`)
  console.log(`   ${allCommands().length} commands loaded from ${loadedFiles} files in commands/`)

  // Restore the login from SESSION_ID before the socket is created.
  try {
    const sess = loadSessionFromEnv(path.resolve(ROOT, CONFIG.sessionDir))
    if (sess.restored) console.log(`[session] restored ${sess.files} files from ${sess.source} (${sess.kind})`)
    else if (sess.reason !== 'no session env var set') console.log(`[session] ${sess.reason}`)
  } catch (e) {
    console.error(`[session] could not restore from env: ${e.message}`)
  }

  if (!loadedFiles) console.error(`   ⚠️  nothing loaded — check the path: ${COMMANDS_DIR}`)
  if (CONFIG.ownerNumbers.includes('919999999999')) {
    console.log('⚠️  Set your own number in config.json → ownerNumbers, or owner commands will not work.')
  }
  startHealthServer()
  start()
}

export {
  start, handleMessage, runCommand, makeCtx,
  loadCommands, reloadCommands, commandFiles,
  commands, allCommands, cooldowns, spamTracker, blockedUntil,
  CONFIG, db, settings, gameState, loadSessionFromEnv,
  calc, parseDuration, humanDuration, toWebp, levelFor, toMorse, fromMorse, toFancy,
}

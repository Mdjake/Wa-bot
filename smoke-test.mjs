/**
 * Offline smoke test: drives handleMessage() with a mock socket.
 * No WhatsApp connection needed. Run: node test/smoke.mjs
 */
process.env.OWNER_NUMBERS = '919000000001'
process.env.TZ = 'Asia/Kolkata'

import sharp from 'sharp'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// start from a clean slate so repeated runs behave the same
fs.rmSync(new URL('./data/', import.meta.url), { recursive: true, force: true })

const OWNER = '919000000001'
const STRANGER = '919000000002'
const BOT = '919000000000'
const GROUP = '120363000000000000@g.us'

let pass = 0
let fail = 0
const failures = []

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`) }
}

class MockSock {
  constructor() {
    this.calls = []
    this.user = { id: `${BOT}:1@s.whatsapp.net`, name: 'TestBot' }
    this.authState = { creds: { registered: true } }
    this.meta = {
      id: GROUP,
      subject: 'Test Group',
      desc: 'testing',
      creation: 1700000000,
      announce: false,
      participants: [
        { id: `${BOT}@s.whatsapp.net`, admin: 'admin' },
        { id: `${OWNER}@s.whatsapp.net`, admin: 'superadmin' },
        { id: `${STRANGER}@s.whatsapp.net`, admin: null },
      ],
    }
  }
  async sendMessage(jid, content, opts) { this.calls.push({ jid, content, opts }); return { key: { id: 'out' + this.calls.length } } }
  async groupMetadata() { return this.meta }
  async readMessages() { this.read = true }
  presenceSubscribe() {}
  async sendPresenceUpdate() {}
  async profilePictureUrl() { return 'https://example.com/p.jpg' }
  async groupParticipantsUpdate(jid, ids, action) { this.calls.push({ jid, action, ids }) }
  async groupUpdateSubject() {}
  async groupUpdateDescription() {}
  async groupInviteCode() { return 'INVITECODE1' }
  async groupRevokeInvite() { return 'NEWCODE2' }
  async groupSettingUpdate() {}
  async updateBlockStatus() {}
  async groupFetchAllParticipating() { return { [GROUP]: {} } }
  async groupLeave() {}
  async updateProfileName() {}
  async updateProfileStatus() {}
  async updateProfilePicture() {}
  async groupAcceptInvite() {}
  last() { return this.calls[this.calls.length - 1] }
  texts() { return this.calls.filter((c) => c.content?.text).map((c) => c.content.text) }
  reset() { this.calls = [] }
}

const sock = new MockSock()
const mod = await import('./index.js')
const { handleMessage, calc, parseDuration, humanDuration, toWebp, commands, allCommands, cooldowns, spamTracker, blockedUntil, gameState, levelFor, toMorse, fromMorse, toFancy, settings } = mod

let seq = 0
const msg = (text, { from = STRANGER, group = false, mentions = [], quoted = null, fromMe = false } = {}) => {
  const id = 'MSG' + ++seq
  const jid = group ? GROUP : `${from}@s.whatsapp.net`
  const inner = mentions.length || quoted
    ? { extendedTextMessage: { text, contextInfo: mentions.length ? { mentionedJid: mentions } : {} } }
    : { conversation: text }
  if (quoted) {
    const target = inner.extendedTextMessage || inner
    target.contextInfo = { ...(target.contextInfo || {}), quotedMessage: quoted.message, participant: quoted.from, stanzaId: quoted.id }
  }
  return { key: { remoteJid: jid, fromMe, id, participant: group ? `${from}@s.whatsapp.net` : undefined }, message: inner, pushName: 'Tester' }
}

const run = async (text, opts) => { sock.reset(); cooldowns.clear(); spamTracker.clear(); blockedUntil.clear(); await handleMessage(sock, msg(text, opts)); return sock }

console.log('\n— pure helpers —')
check('calc 2*(3+4)^2 = 98', calc('2*(3+4)^2') === 98)
check('calc sqrt(16)+pi', Math.abs(calc('sqrt(16)+pi') - (4 + Math.PI)) < 1e-9)
check('calc 2^3^2 is right-assoc (512)', calc('2^3^2') === 512)
check('calc 10%3 = 1', calc('10%3') === 1)
let threw = false
try { calc('1+*2') } catch { threw = true }
check('calc rejects bad input', threw)
check('parseDuration 1h30m = 5400000', parseDuration('1h30m') === 5400000)
check('parseDuration 90s = 90000', parseDuration('90s') === 90000)
check('parseDuration junk = 0', parseDuration('abc') === 0)
check('humanDuration 5400000 = 1h 30m', humanDuration(5400000) === '1h 30m')
check('command count >= 55', allCommands().length >= 55, String(allCommands().length))

console.log('\n— general —')
await run('.ping')
check('.ping replies Pong', sock.texts().some((t) => t.includes('Pong')), JSON.stringify(sock.texts()))
check('.ping reacts 🏓', sock.calls.some((c) => c.content?.react?.text === '🏓'))
await run('.menu')
check('.menu lists commands', sock.last().content.text.includes('.ping') && sock.last().content.text.includes('.tagall'))
await run('.menu group')
check('.menu group filters', sock.last().content.text.includes('tagall') && !sock.last().content.text.includes('.8ball'))
await run('.help calc')
check('.help calc shows usage', sock.last().content.text.includes('Usage'))
await run('.time')
check('.time replies a date', /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}/.test(sock.last().content.text))
await run('.id')
check('.id shows chat jid', sock.last().content.text.includes(`${STRANGER}@s.whatsapp.net`))
await run('.echo hello world')
check('.echo repeats', sock.last().content.text === 'hello world')
await run('.source')
check('.source shows command count', sock.last().content.text.includes('Commands:'))
await run('hello without prefix')
check('no prefix → no reply', sock.calls.length === 0)

console.log('\n— tools —')
await run('.calc 2*(3+4)^2')
check('.calc replies 98', sock.last().content.text.includes('98'))
await run('.calc 1/0')
check('.calc handles /0', sock.last().content.text.includes('❌'))
await run('.base64 enc hello')
check('.base64 enc', sock.last().content.text.includes('aGVsbG8='))
await run('.base64 dec aGVsbG8=')
check('.base64 dec', sock.last().content.text.includes('hello'))
await run('.hash sha256 abc')
check('.hash sha256', sock.last().content.text.includes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'))
await run('.upper hi there')
check('.upper', sock.last().content.text === 'HI THERE')
await run('.cap hi there')
check('.cap', sock.last().content.text === 'Hi There')
await run('.reverse abc')
check('.reverse', sock.last().content.text === 'cba')
await run('.count one two')
check('.count', sock.last().content.text.includes('Words: 2'))
await run('.password 24')
check('.password length 24', /[A-Za-z0-9!@#$%^&*\-_]{24}/.test(sock.last().content.text), sock.last().content.text)
await run('.uuid')
check('.uuid format', /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/.test(sock.last().content.text))
await run('.qr hello')
check('.qr sends an image', !!sock.last().content.image && Buffer.isBuffer(sock.last().content.image))

const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#ff0000' } }).png().toBuffer()
const webp = await toWebp(png, 'imageMessage')
check('toWebp produces webp', webp.subarray(0, 4).toString() === 'RIFF' && webp.subarray(8, 12).toString() === 'WEBP')
const meta = await sharp(webp).metadata()
check('sticker is 512x512', meta.width === 512 && meta.height === 512, `${meta.width}x${meta.height}`)

console.log('\n— fun —')
await run('.8ball will it work?')
check('.8ball replies', sock.last().content.text.startsWith('🎱'))
await run('.coin')
check('.coin', /Heads|Tails/.test(sock.last().content.text))
await run('.dice 20')
check('.dice 20', /d20/.test(sock.last().content.text))
await run('.choose tea | coffee')
check('.choose picks one', /tea|coffee/.test(sock.last().content.text))
await run('.rate pizza')
check('.rate', sock.last().content.text.includes('/10'))
await run('.ship', { mentions: [`${OWNER}@s.whatsapp.net`, `${STRANGER}@s.whatsapp.net`] })
check('.ship mentions both', sock.last().content.mentions?.length === 2)

console.log('\n— utility —')
await run('.note add wifi Pass123')
check('.note add', sock.last().content.text.includes('saved'))
await run('.note get wifi')
check('.note get', sock.last().content.text.includes('Pass123'))
await run('.note list')
check('.note list', sock.last().content.text.includes('wifi'))
await run('.todo add buy milk')
check('.todo add', sock.last().content.text.includes('buy milk'))
await run('.todo done 1')
check('.todo done', sock.last().content.text.includes('✔️'))
await run('.remind 1s stretch')
check('.remind set', sock.last().content.text.includes('Reminder set'))
await new Promise((r) => setTimeout(r, 1400))
check('.remind fired', sock.texts().some((t) => t.includes('⏰ *Reminder*')), JSON.stringify(sock.texts()))
await run('.afk lunch')
check('.afk set', sock.last().content.text.includes('AFK'))
sock.reset(); spamTracker.clear(); blockedUntil.clear()
await handleMessage(sock, msg('where are you', { from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`], group: true }))
check('AFK mention autoreply', sock.texts().some((t) => t.includes('is AFK')), JSON.stringify(sock.texts()))
sock.reset(); spamTracker.clear(); blockedUntil.clear()
await handleMessage(sock, msg('back now'))
check('AFK welcome back', sock.texts().some((t) => t.includes('Welcome back')), JSON.stringify(sock.texts()))

console.log('\n— permissions —')
await run('.mode private', { from: OWNER })
check('.mode private works for owner', sock.texts().some((t) => t.includes('private')))
await run('.ping', { from: STRANGER })
check('private mode blocks stranger', sock.texts().some((t) => t.includes('private mode')))
await run('.mode public', { from: OWNER })
check('.mode public restored', sock.texts().some((t) => t.includes('public')))
await run('.mode self', { from: OWNER })
await run('.ping', { from: STRANGER })
check('self mode ignores stranger silently', sock.calls.length === 0)
await run('.mode public', { from: OWNER })
check('owner can leave self mode', sock.texts().some((t) => t.includes('public')))

await run('.broadcast hi')
check('non-owner blocked from owner cmd', sock.texts().some((t) => t.includes('owner only')))
await run('.broadcast hi all', { from: OWNER })
check('owner broadcast runs', sock.texts().some((t) => t.includes('Sent to')))
await run('.eval 1+1', { from: OWNER })
check('.eval returns 2', sock.last().content.text.includes('2'))
await run('.eval throw new Error("boom")', { from: OWNER })
check('.eval surfaces errors', sock.last().content.text.includes('boom'))

console.log('\n— group —')
await run('.tagall hello all', { group: true, from: STRANGER })
check('non-admin blocked from tagall', sock.texts().some((t) => t.includes('group admin')))
await run('.tagall hello all', { group: true, from: OWNER })
check('admin tagall mentions 3', sock.last().content.mentions?.length === 3, String(sock.last().content.mentions?.length))
await run('.hidetag psst', { group: true, from: OWNER })
check('hidetag text hidden tags', sock.last().content.text === 'psst' && sock.last().content.mentions.length === 3)
await run('.kick', { group: true, from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.kick calls remove', sock.calls.some((c) => c.action === 'remove'))
await run('.promote', { group: true, from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.promote calls promote', sock.calls.some((c) => c.action === 'promote'))
await run('.add 919000000003', { group: true, from: OWNER })
check('.add by number', sock.calls.some((c) => c.action === 'add' && c.ids[0] === '919000000003@s.whatsapp.net'))
await run('.link', { group: true, from: OWNER })
check('.link builds invite url', sock.last().content.text.includes('chat.whatsapp.com/INVITECODE1'))
await run('.ginfo', { group: true })
check('.ginfo shows members', sock.last().content.text.includes('Members: 3'))
await run('.welcome on', { group: true, from: OWNER })
check('.welcome on', sock.last().content.text.includes('on'))
await run('.antilink delete', { group: true, from: OWNER })
check('.antilink delete', sock.last().content.text.includes('delete'))
await run('.antilink', { group: true, from: OWNER })
check('.antilink reports current', sock.last().content.text.includes('Current:'))
await run('.poll Best? | tea | coffee', { group: true })
check('.poll sends poll', sock.last().content.poll?.values?.length === 2)
await run('.tagall', { from: STRANGER })
check('group-only cmd blocked in DM', sock.texts().some((t) => t.includes('only works in a group')))
await run('.ping', { group: true })
check('commands work in groups', sock.texts().some((t) => t.includes('Pong')))

console.log('\n— antilink enforcement —')
sock.reset(); spamTracker.clear(); blockedUntil.clear()
await handleMessage(sock, msg('join https://chat.whatsapp.com/ABC123', { group: true, from: STRANGER }))
check('antilink deletes stranger link', sock.calls.some((c) => c.content?.delete))
check('antilink warns', sock.texts().some((t) => t.includes('links are not allowed')))
sock.reset(); spamTracker.clear(); blockedUntil.clear()
await handleMessage(sock, msg('join https://chat.whatsapp.com/ABC123', { group: true, from: OWNER }))
check('antilink spares admin', !sock.calls.some((c) => c.content?.delete))

console.log('\n— cooldown & misc —')
sock.reset(); spamTracker.clear(); blockedUntil.clear(); cooldowns.clear()
await handleMessage(sock, msg('.ping'))
await handleMessage(sock, msg('.ping'))
check('cooldown: only one Pong', sock.texts().filter((t) => t.includes('Pong')).length === 1, JSON.stringify(sock.texts()))
sock.reset()
await handleMessage(sock, { key: { remoteJid: 'status@broadcast', id: 'S1' }, message: { conversation: '.ping' } })
check('status@broadcast ignored', sock.calls.length === 0)
sock.reset()
await handleMessage(sock, msg('.nosuchcommand'))
check('unknown command silent', sock.calls.length === 0)
sock.reset()
await handleMessage(sock, msg('.menu', { fromMe: true }))
check('fromMe message handled', sock.texts().length === 1)


console.log('\n— ported: group —')
await run('.admins', { group: true })
check('.admins lists admins', sock.last().content.mentions?.length === 2, JSON.stringify(sock.last().content.mentions))
await run('.members', { group: true })
check('.members shows count', sock.last().content.text.includes('3 members'))
await run('.rules', { group: true })
check('.rules empty state', sock.last().content.text.includes('No rules set'))
await run('.rules set Be nice, no spam', { group: true, from: OWNER })
check('.rules set by admin', sock.last().content.text.includes('saved'))
await run('.rules', { group: true })
check('.rules shows text', sock.last().content.text.includes('Be nice'))
await run('.rules set nope', { group: true, from: STRANGER })
check('.rules blocked for non-admin', sock.last().content.text.includes('Only admins'))
await run('.warn', { group: true, from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.warn 1/3', sock.last().content.text.includes('1/3'))
await run('.warnings', { group: true, from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.warnings lists', sock.last().content.text.includes('1/3 warnings'))
await run('.unwarn', { group: true, from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.unwarn drops to 0', sock.last().content.text.includes('0/3'))
sock.reset()
for (let i = 0; i < 3; i++) {
  await run('.warn trouble', { group: true, from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
}
check('.warn 3x kicks', sock.calls.some((c) => c.action === 'remove'), JSON.stringify(sock.calls.map((c) => c.action)))
check('.warn 3x announces', sock.texts().some((t) => t.includes('3 warnings')))
await run('.warnreset', { group: true, from: OWNER })
check('.warnreset clears', sock.last().content.text.includes('cleared'))
await run('.vcf', { group: true })
check('.vcf sends a document', Buffer.isBuffer(sock.last().content.document) && sock.last().content.mimeType === undefined || sock.last().content.mimetype === 'text/vcard')
check('.vcf has 3 cards', (sock.last().content.document.toString().match(/BEGIN:VCARD/g) || []).length === 3)
await run('.groupstats', { group: true })
check('.groupstats shows activity', sock.last().content.text.includes('Group activity'))
await run('.antivv on', { group: true, from: OWNER })
check('.antivv on', sock.last().content.text.includes('on'))
await run('.badword add zzzword', { group: true, from: OWNER })
check('.badword add', sock.last().content.text.includes('Added'))
await run('.badword on', { group: true, from: OWNER })
check('.badword on', sock.last().content.text.includes('on'))
await run('.badword list', { group: true, from: OWNER })
check('.badword list', sock.last().content.text.includes('zzzword'))
sock.reset(); spamTracker.clear(); blockedUntil.clear()
await handleMessage(sock, msg('this has zzzword in it', { group: true, from: STRANGER }))
check('.badword deletes message', sock.calls.some((c) => c.content?.delete))
check('.badword warns sender', sock.texts().some((t) => t.includes('not allowed')))

console.log('\n— ported: levels, bookmarks, expenses —')
await run('.level')
check('.level shows level', sock.last().content.text.includes('Level'))
check('.level has XP', /\d+ XP/.test(sock.last().content.text))
await run('.leaderboard')
check('.leaderboard ranks', sock.last().content.text.includes('Leaderboard'))
await run('.bookmark', { quoted: { message: { conversation: 'remember this' }, from: `${STRANGER}@s.whatsapp.net`, id: 'Q1' } })
check('.bookmark saves', sock.last().content.text.includes('Saved'))
await run('.bookmarks')
check('.bookmarks lists', sock.last().content.text.includes('remember this'))
await run('.delbookmark 1')
check('.delbookmark removes', sock.last().content.text.includes('Deleted'))
await run('.expense add 500 pizza', { group: true })
check('.expense add', sock.last().content.text.includes('500'))
await run('.expense add 300 drinks', { group: true })
check('.expense totals', sock.last().content.text.includes('800'))
await run('.expense split 4', { group: true })
check('.expense split 4 = 200', sock.last().content.text.includes('200'))
await run('.expense list', { group: true })
check('.expense list', sock.last().content.text.includes('pizza'))
await run('.expense clear', { group: true })
check('.expense clear', sock.last().content.text.includes('cleared'))
await run('.pomodoro 1')
check('.pomodoro starts', sock.last().content.text.includes('Focus for'))

console.log('\n— ported: tools —')
await run('.morse enc sos')
check('.morse enc', sock.last().content.text.includes('... --- ...'))
await run('.morse dec ... --- ...')
check('.morse dec', sock.last().content.text.includes('sos'))
await run('.binary enc hi')
check('.binary enc', sock.last().content.text.includes('01101000 01101001'))
await run('.binary dec 01101000 01101001')
check('.binary dec', sock.last().content.text.includes('hi'))
await run('.hex enc hi')
check('.hex enc', sock.last().content.text.includes('6869'))
await run('.hex dec 6869')
check('.hex dec', sock.last().content.text.includes('hi'))
await run('.rot13 hello')
check('.rot13', sock.last().content.text === 'uryyb')
await run('.fancy hi')
check('.fancy changes glyphs', sock.last().content.text !== 'hi' && !/[a-z]/.test(sock.last().content.text))
await run('.color #ff0000')
check('.color rgb', sock.last().content.text.includes('255, 0, 0'))
await run('.color notacolor')
check('.color rejects junk', sock.last().content.text.includes('Usage'))
await run('.sysinfo')
check('.sysinfo reports OS', sock.last().content.text.includes('OS:') && sock.last().content.text.includes('Node:'))
await run('.json {"a":1,"b":[1,2]}')
check('.json pretty prints', sock.last().content.text.includes('"a": 1'))
await run('.json {broken')
check('.json rejects bad input', sock.last().content.text.includes('Invalid JSON'))
await run('.wiki Baileys')
check('.wiki replies (network may fail here)', sock.calls.length === 1, JSON.stringify(sock.texts()))
await run('.weather Mumbai')
check('.weather replies (network may fail here)', sock.calls.length === 1, JSON.stringify(sock.texts()))
await run('.define serendipity')
check('.define replies (network may fail here)', sock.calls.length === 1, JSON.stringify(sock.texts()))
await run('.shorten example.com')
check('.shorten needs a url', sock.last().content.text.includes('Usage'))

console.log('\n— ported: games & fun —')
await run('.rps rock')
check('.rps plays', /You: \*rock\*/.test(sock.last().content.text))
await run('.rps banana')
check('.rps rejects junk', sock.last().content.text.includes('Usage'))
await run('.trivia')
const triviaAnswer = gameState.get(`${STRANGER}@s.whatsapp.net`).answer
check('.trivia starts', sock.last().content.text.includes('Trivia'))
await run(`.answer ${triviaAnswer}`)
check('.answer accepts correct', sock.last().content.text.includes('Correct'))
await run('.answer nothing')
check('.answer with no game', sock.last().content.text.includes('no active question'))
await run('.numguess')
const target = gameState.get(`${STRANGER}@s.whatsapp.net`).answer
check('.numguess starts', sock.last().content.text.includes('1 to 100'))
const probe = Number(target) === 50 ? 51 : 50
await run(`.guess ${probe}`)
check('.guess hints higher/lower', /Higher than|Lower than|got it/.test(sock.last().content.text))
await run(`.guess ${target}`)
check('.guess correct wins', sock.last().content.text.includes('got it'))
await run('.wordscramble')
const word = gameState.get(`${STRANGER}@s.whatsapp.net`).answer
check('.wordscramble shows word', sock.last().content.text.includes('Unscramble'))
await run(`.wordscramble ${word}`)
check('.wordscramble correct', sock.last().content.text.includes('unscrambled'))
await run('.riddle')
check('.riddle starts', sock.last().content.text.includes('Riddle'))
await run('.truth')
check('.truth replies', sock.last().content.text.includes('Truth'))
await run('.dare')
check('.dare replies', sock.last().content.text.includes('Dare'))
await run('.pickup')
check('.pickup replies', sock.last().content.text.length > 10)
await run('.roast', { mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.roast mentions target', sock.last().content.mentions?.length === 1)
await run('.compliment')
check('.compliment replies', sock.calls.length === 1)
await run('.advice')
check('.advice replies', sock.calls.length === 1)
await run('.proverb')
check('.proverb replies', sock.calls.length === 1)

console.log('\n— ported: owner tools —')
await run('.alive')
check('.alive card', sock.last().content.text.includes('is alive'))
await run('.settings')
check('.settings is owner-only', sock.last().content.text.includes('owner only'))
await run('.settings', { from: OWNER })
check('.settings shows config', sock.last().content.text.includes('Mode:'))
await run('.sudo add', { from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.sudo add', sock.last().content.text.includes('owner-level'))
await run('.settings', { from: STRANGER })
check('sudo user gets owner access', sock.last().content.text.includes('Mode:'))
await run('.sudo add', { from: STRANGER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('sudo cannot grant sudo', sock.last().content.text.includes('real owner'))
await run('.sudo del', { from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.sudo del', sock.last().content.text.includes('Removed'))
await run('.ban', { from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.ban adds', sock.last().content.text.includes('no longer use'))
await run('.ping')
check('banned user gets nothing', sock.calls.length === 0, JSON.stringify(sock.texts()))
await run('.banlist', { from: OWNER })
check('.banlist shows', sock.last().content.text.includes(STRANGER))
await run('.unban', { from: OWNER, mentions: [`${STRANGER}@s.whatsapp.net`] })
check('.unban removes', sock.last().content.text.includes('unbanned'))
await run('.ping')
check('unbanned user works again', sock.texts().some((t) => t.includes('Pong')))
await run('.setprefix !', { from: OWNER })
check('.setprefix changes', sock.last().content.text.includes('Prefix changed'))
sock.reset()
await handleMessage(sock, msg('!ping'))
check('new prefix works', sock.texts().some((t) => t.includes('Pong')), JSON.stringify(sock.texts()))
await run('!setprefix .', { from: OWNER })
check('.setprefix restores', sock.last().content.text.includes('Prefix changed'))
await run('.ping')
check('old prefix works again', sock.texts().some((t) => t.includes('Pong')))


console.log('\n— plugin loader —')
const tmpCmd = new URL('./commands/fun/zz-temp-test.js', import.meta.url)
fs.writeFileSync(tmpCmd, "export default { name: 'zztest', category: 'fun', desc: 'temp file', run: (ctx) => ctx.reply('zz ok') }\n")
await run('.reload', { from: OWNER })
check('.reload reports loaded files', sock.last().content.text.includes('Reloaded'), JSON.stringify(sock.texts()))
check('new file picked up without touching index.js', !!commands.get('zztest'))
await run('.zztest')
check('new command runs', sock.last().content.text === 'zz ok')
fs.rmSync(tmpCmd)
await run('.reload', { from: OWNER })
check('deleted file is dropped', !commands.get('zztest'))
check('registry back to 123 commands', allCommands().length === 123, String(allCommands().length))


console.log('\n— session from env —')
const { loadSessionFromEnv } = await import('./lib/session.js')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'))
const srcDir = path.join(tmpRoot, 'session')
fs.mkdirSync(path.join(srcDir, 'keys'), { recursive: true })
fs.writeFileSync(path.join(srcDir, 'creds.json'), '{"me":{"id":"123"}}')
fs.writeFileSync(path.join(srcDir, 'keys', 'a.json'), 'keydata')

const manifest = Buffer.from(JSON.stringify({
  files: {
    'creds.json': fs.readFileSync(path.join(srcDir, 'creds.json')).toString('base64'),
    'keys/a.json': fs.readFileSync(path.join(srcDir, 'keys', 'a.json')).toString('base64'),
  },
})).toString('base64')

const restore = (payload, dir) => { process.env.SESSION_ID = payload; return loadSessionFromEnv(dir) }

const r1 = restore(manifest, path.join(tmpRoot, 'a'))
check('json manifest restores', r1.restored && r1.files === 2 && r1.kind === 'json')
check('creds.json byte-identical', fs.readFileSync(path.join(tmpRoot, 'a', 'creds.json'), 'utf8') === '{"me":{"id":"123"}}')
check('nested key file restored', fs.existsSync(path.join(tmpRoot, 'a', 'keys', 'a.json')))

// tar.gz — the format most "session ID" generators give you
const tarHeader = (name, size) => {
  const h = Buffer.alloc(512)
  h.write(name, 0)
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write('0', 156)
  h.write('ustar\0', 257); h.write('00', 263)
  return h
}
const tarParts = []
const tarAdd = (name, data) => {
  tarParts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
}
tarAdd('creds.json', Buffer.from('{"me":{"id":"123"}}'))
tarAdd('keys/a.json', Buffer.from('keydata'))
tarParts.push(Buffer.alloc(1024))
const targz = zlib.gzipSync(Buffer.concat(tarParts)).toString('base64')
const r2 = restore(targz, path.join(tmpRoot, 'b'))
check('tar.gz payload restores', r2.restored && r2.kind === 'tar.gz' && r2.files === 2)
check('tar.gz nested file restored', fs.existsSync(path.join(tmpRoot, 'b', 'keys', 'a.json')))

// `tar -czf - session` prefixes every entry with the folder name
const prefixed = []
const tarAddP = (name, data) => {
  prefixed.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
}
tarAddP('session/creds.json', Buffer.from('{"me":{"id":"123"}}'))
tarAddP('session/keys/a.json', Buffer.from('keydata'))
prefixed.push(Buffer.alloc(1024))
const r2b = restore(zlib.gzipSync(Buffer.concat(prefixed)).toString('base64'), path.join(tmpRoot, 'b2'))
check('tar with a session/ prefix is stripped', r2b.restored && fs.existsSync(path.join(tmpRoot, 'b2', 'creds.json')))
check('no doubled session/ folder', !fs.existsSync(path.join(tmpRoot, 'b2', 'session')))

const r3 = restore(Buffer.from('{"me":{"id":"9"}}').toString('base64'), path.join(tmpRoot, 'c'))
check('bare creds.json restores', r3.restored && r3.kind === 'creds.json')

let refused = false
try {
  restore(Buffer.from(JSON.stringify({ files: { 'creds.json': 'e30=', '../evil.txt': 'e30=' } })).toString('base64'), path.join(tmpRoot, 'd'))
} catch { refused = true }
check('refuses paths outside the session folder', refused)
check('writes nothing when a path is rejected', !fs.existsSync(path.join(tmpRoot, 'd', 'creds.json')))

fs.mkdirSync(path.join(tmpRoot, 'e'), { recursive: true })
fs.writeFileSync(path.join(tmpRoot, 'e', 'creds.json'), 'MINE')
restore(manifest, path.join(tmpRoot, 'e'))
check('existing on-disk session left alone', fs.readFileSync(path.join(tmpRoot, 'e', 'creds.json'), 'utf8') === 'MINE')

let badPayload = false
try { restore(Buffer.from('nope').toString('base64'), path.join(tmpRoot, 'f')) } catch { badPayload = true }
check('garbage payload rejected', badPayload)
delete process.env.SESSION_ID
check('no env var is a no-op', loadSessionFromEnv(path.join(tmpRoot, 'g')).restored === false)
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log('\n— registry sanity —')
const missing = allCommands().filter((c) => !c.desc || !c.category || typeof c.run !== 'function')
check('every command has desc/category/run', missing.length === 0, missing.map((c) => c.name).join(','))
check('aliases resolve', commands.get('h') === commands.get('help') && commands.get('s') === commands.get('sticker'))

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}: ${pass} passed, ${fail} failed`)
if (fail) console.log('failed:', failures.join(', '))
process.exit(fail ? 1 : 0)

# Saif Bot — WhatsApp bot

A Baileys bot built as **plugins**: 123 commands in 123 files under `commands/`.
Group management, media tools, games, XP levels, expense tracking, and auto-features
(welcome, antilink, bad words, antivv, antidelete, AFK replies, reminders).

Built for Baileys v6 **and** v7 — it uses whichever socket export your installed version has.

---

## 1. Setup (keeps your existing session)

Do **not** delete the `session` folder — the bot reads the same `session/`
directory and stays logged in.

```bash
npm install          # baileys, pino, sharp, qrcode
# edit config.json  → ownerNumbers
node index.js
```

Then send `.menu` to the bot on WhatsApp.

If `session/` is missing or you log out, the bot asks for a number and prints a
**pairing code** — WhatsApp → Linked devices → Link with phone number.

## 2. Push to GitHub

`.gitignore` already excludes `session/`, `data/` and `node_modules/` — **never commit
`session/`**, it is your WhatsApp login.

```bash
cd ~/mybot
git init
git add .
git commit -m "WhatsApp bot: plugin commands, session from env"
git branch -M main
git remote add origin https://github.com/<your-username>/wa-bot.git
git push -u origin main
```

Create the empty repo on GitHub first (no README, no .gitignore). If `git push` asks for a
password, paste a Personal Access Token (GitHub → Settings → Developer settings → Tokens),
not your account password.

Check before you push: `git status --short` should show no `session/` and no `node_modules/`.

## 3. Deploy on Render

Render wipes the disk on every deploy, so the login cannot live in a folder. Put it in an
environment variable instead.

### Step 1 — make the session string (on your own machine)

Pair once locally, then:

```bash
node scripts/session-to-env.js                 # prints one long base64 string
node scripts/session-to-env.js > session.txt   # or save it to a file
```

It reads `session/` (creds.json plus the key files), so run it **after** a successful pairing.
Only the string goes to stdout — file names and warnings go to stderr, so a redirect gives you
a clean file.

### Step 2 — create the service

Dashboard → **New → Web Service** → connect your repo.

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Instance type | Free — see the caveats below |
| Health check path | `/` |

Or use **New → Blueprint** with the included `render.yaml` and fill the secret values in.

### Step 3 — environment variables

| Key | Value |
|---|---|
| `SESSION_ID` | the string from step 1 |
| `OWNER_NUMBERS` | your number, e.g. `919876543210` |
| `NODE_VERSION` | `20` |
| `BOT_NAME` | optional |
| `DATA_DIR` | optional, e.g. `/var/data` when you attach a disk |

A good deploy log looks like this:

```
🤖 Saif Bot v2.2.0
   123 commands loaded from 123 files in commands/
[session] restored 3 files from SESSION_ID (json)
[web] health server listening on :10000
✅ Connected as 919876543210 — Saif Bot v2.2.0 is live.
```

### Why the code needs a port

The free plan only offers Web Services, and a service that never answers HTTP is killed.
`index.js` starts a tiny server when `PORT` is set and returns
`{"ok":true,"bot":"…","commands":123,"connected":true,"uptime":"…"}` — point the health
check at `/`.

### What the session string may contain

`lib/session.js` accepts any of these, base64 encoded, and writes the files into `session/`
before the socket is created:

1. the JSON manifest that `scripts/session-to-env.js` produces,
2. a `tar.gz` of a session folder — what most "session ID" generators hand you,
3. a bare `creds.json`.

It refuses any path that would land outside the session folder, and it never overwrites a
session that is already on disk — so your local `node index.js` still works normally.

### Free-plan caveats — read these

- **It sleeps.** A free web service spins down after about 15 minutes without inbound HTTP,
  and a WhatsApp socket is not inbound HTTP. While asleep the bot is offline. Either ping
  the URL every 10 minutes from a free monitor (cron-job.org, UptimeRobot) or take the paid
  instance, which stays up.
- **The disk is ephemeral.** `data/` (levels, warns, notes, expenses, reminders) resets on
  every deploy and spin-down. Attach a Render Disk and set `DATA_DIR` if that data matters.
- **One instance only.** Never run two copies on the same `SESSION_ID` — WhatsApp drops one
  with `connectionReplaced`.
- **Logged out?** Regenerate the string locally and update `SESSION_ID`. On a host with no
  terminal that is the only way to re-pair.

## 4. How the code is organised

```
index.js                core only: socket, events, message pipeline, command runner
lib/core.js             config, storage, helpers, command registry, live socket
lib/loader.js           finds and loads every command file
lib/session.js          restores the login from the SESSION_ID env var
scripts/
  session-to-env.js     turns ./session into one base64 string
commands/
  general/    11 files      ping, menu, stats, alive, ...
  group/      30 files      tagall, warn, rules, vcf, antilink, ...
  media/       5 files      sticker, toimg, vv, pp, del
  tools/      23 files      calc, morse, weather, wiki, sysinfo, ...
  fun/        23 files      8ball, trivia, rps, roast, ...
  utility/    11 files      remind, note, todo, level, expense, ...
  owner/      20 files      mode, eval, sudo, ban, reload, ...
  TEMPLATE.md         copy-paste template + what ctx gives you
config.json             your settings — the only file you normally edit
smoke-test.mjs          184 offline checks, no WhatsApp needed
.gitignore              keeps session/, data/ and node_modules/ out of git
render.yaml             optional Render blueprint
data/                   created automatically (stats, levels, notes, warns, ...)
session/                your paired login — never commit or share this
```

**You never edit `index.js` to add a command.** Drop a file in `commands/`:

```js
import { PREFIX } from '../../lib/core.js'

export default {
  name: 'hello',
  aliases: ['hi'],
  category: 'general',
  desc: 'Say hello',
  usage: `${PREFIX}hello <name>`,
  run: async (ctx) => ctx.reply(`Hello ${ctx.argStr || 'there'}!`),
}
```

Then send `.reload` in WhatsApp — no restart. `.menu` and `.help hello` pick it up
automatically, and permissions come from the flags (`owner`, `admin`, `botAdmin`, `group`).

## 5. config.json

| Key | Meaning |
|---|---|
| `botName` | Name shown in menus |
| `ownerName` | Shown by `.owner` |
| `ownerNumbers` | **Your** number(s) with country code, no `+` |
| `prefixes` | Command prefixes, e.g. `[".", "!"]` |
| `sessionDir` | Where the login lives (default `session`) |
| `mode` | `public` = everyone · `private` = owner commands only · `self` = owner only |
| `cooldownMs` | Default per-command cooldown |
| `features` | `antidelete`, `autoread`, `typing` |
| `groupDefaults` | New groups start with welcome/goodbye/antivv off, antilink off |

Env overrides: `OWNER_NUMBERS`, `BOT_NAME`, `BOT_MODE`. Change the prefix at
runtime with `.setprefix !` — remembered in `data/settings.json`.

## 6. Commands

Prefix is `. ` (change it in `config.json`). `.menu <category>` filters, `.help <command>` shows usage.

### General (11)

| Command | What it does |
|---|---|
| `.alive` | Bot status card |
| `.date` | Today's date |
| `.echo <text>` | Repeat your text |
| `.id` | Show chat and user IDs |
| `.menu [category]` | List commands (optionally for one category) |
| `.owner` | Contact the bot owner |
| `.ping` | Check bot latency |
| `.source` | About this bot |
| `.stats` | Message and command counters |
| `.time` | Current date and time |
| `.uptime` | How long the bot has been running |

### Group (30)

| Command | What it does |
|---|---|
| `.add @user or 919876543210` | Add a number to the group _(group admin, groups only)_ |
| `.admins` | List the group admins _(groups only)_ |
| `.antilink off\|warn\|delete` | Block links: off \| warn \| delete _(group admin, groups only)_ |
| `.antivv on\|off` | Auto-reveal view-once media in this group _(group admin, groups only)_ |
| `.badword add <word> \| del <word> \| list \| on \| off` | Auto-delete messages with words you add _(group admin, groups only)_ |
| `.close` | Only admins can send messages _(group admin, groups only)_ |
| `.demote @user` | Remove admin rights from a member _(group admin, groups only)_ |
| `.gdesc <text>` | Set the group description _(group admin, groups only)_ |
| `.ginfo` | Group details _(groups only)_ |
| `.gname <new name>` | Rename the group _(group admin, groups only)_ |
| `.goodbye on\|off` | Goodbye messages on/off _(group admin, groups only)_ |
| `.groupstats` | Most active members in this group _(groups only)_ |
| `.hidetag <message>` | Notify everyone without showing tags _(group admin, groups only)_ |
| `.kick @user` | Remove a member from the group _(group admin, groups only)_ |
| `.link` | Get the group invite link _(group admin, groups only)_ |
| `.members` | Count and list group members _(groups only)_ |
| `.mute` | Only admins can edit group info _(group admin, groups only)_ |
| `.open` | Everyone can send messages _(group admin, groups only)_ |
| `.poll Question \| option1 \| option2` | Create a poll _(groups only)_ |
| `.promote @user` | Make a member an admin _(group admin, groups only)_ |
| `.revoke` | Reset the invite link _(group admin, groups only)_ |
| `.rules \| .rules set <text> \| .rules del` | Show, set or delete the group rules _(groups only)_ |
| `.tagall [message]` | Tag every member _(group admin, groups only)_ |
| `.unmute` | Everyone can edit group info _(group admin, groups only)_ |
| `.unwarn @user` | Remove one warning _(group admin, groups only)_ |
| `.vcf` | Export group members as a .vcf contact file _(groups only)_ |
| `.warn @user [reason]` | Warn a member (3 warnings = kick) _(group admin, groups only)_ |
| `.warnings @user` | Show warnings for a member _(groups only)_ |
| `.warnreset` | Clear every warning in this group _(group admin, groups only)_ |
| `.welcome on\|off` | Welcome messages on/off _(group admin, groups only)_ |

### Media (5)

| Command | What it does |
|---|---|
| `.del` | Delete the message you replied to (bot must be admin in groups) |
| `.pp` | Get a user or group profile picture |
| `.sticker` | Reply to an image/video with .sticker |
| `.toimg` | Turn a sticker into a PNG image |
| `.vv` | Reveal a view-once photo/video you replied to |

### Tools (23)

| Command | What it does |
|---|---|
| `.base64 enc\|dec <text>` | Encode or decode base64 |
| `.binary enc <text> \| dec <bits>` | Text to binary or back |
| `.calc 2*(3+4)^2` | Do arithmetic safely |
| `.cap <text>` | Capitalise Each Word |
| `.color #ff8800` | Info about a hex colour |
| `.count <text>` | Count characters, words and lines |
| `.define serendipity` | English dictionary definition |
| `.fancy <text>` | Fancy unicode text |
| `.hash sha256 <text>` | Hash a text (md5, sha256, sha512) |
| `.hex enc <text> \| dec <hex>` | Text to hex or back |
| `.json {"a":1}` | Pretty-print JSON |
| `.lower <text>` | lowercase the text |
| `.morse enc <text> \| dec <code>` | Encode or decode Morse code |
| `.password [length]` | Generate a strong password |
| `.qr <text>` | Turn text into a QR code |
| `.reverse <text>` | Reverse the text |
| `.rot13 <text>` | ROT13 cipher |
| `.shorten https://example.com/long/path` | Shorten a URL |
| `.sysinfo` | Server and process stats |
| `.upper <text>` | UPPERCASE the text |
| `.uuid` | Generate a random UUID |
| `.weather Mumbai` | Current weather for a city |
| `.wiki Baileys` | Wikipedia summary of a topic |

### Fun (23)

| Command | What it does |
|---|---|
| `.8ball <question>` | Ask the magic 8-ball |
| `.advice` | A random piece of advice |
| `.answer <text>` | Answer the active trivia/riddle |
| `.choose pizza \| burger \| biryani` | Pick one of your options |
| `.coin` | Flip a coin |
| `.compliment [@user]` | Compliment someone |
| `.dare` | Random dare |
| `.dice [sides]` | Roll a die |
| `.fact` | A random fact |
| `.guess 42` | Guess the number in .numguess |
| `.joke` | A random joke |
| `.numguess` | Start a number guessing game (1-100) |
| `.pickup` | A random (clean) pickup line |
| `.proverb` | A random proverb |
| `.quote` | A random quote |
| `.rate <thing>` | Rate something out of 10 |
| `.riddle` | A riddle — answer with .answer |
| `.roast [@user]` | A friendly roast |
| `.rps rock\|paper\|scissors` | Rock, paper, scissors |
| `.ship @a @b` | Ship two people |
| `.trivia` | A trivia question — answer with .answer |
| `.truth` | Random truth question |
| `.wordscramble [guess]` | Unscramble a word |

### Utility (11)

| Command | What it does |
|---|---|
| `.afk <reason>` | Set an away message |
| `.bookmark (reply to a message)` | Save the message you replied to |
| `.bookmarks` | List your bookmarks |
| `.delbookmark <n> \| all` | Delete a bookmark by number, or all of them |
| `.expense add 500 pizza \| list \| split 4 \| clear` | Group expense tracker _(groups only)_ |
| `.leaderboard` | Top 10 users by XP |
| `.level [@user]` | Your XP and level |
| `.note add <name> <text> \| get <name> \| list \| del <name>` | Save or read notes |
| `.pomodoro [minutes]` | Start a focus timer |
| `.remind 10m drink water` | Set a reminder |
| `.todo add <text> \| list \| done <n> \| del <n>` | A simple to-do list |

### Owner (20)

| Command | What it does |
|---|---|
| `.antidelete on\|off` | Resend deleted messages on/off _(owner)_ |
| `.autoread on\|off` | Auto blue-tick every message _(owner)_ |
| `.ban @user` | Stop a user from using the bot _(owner)_ |
| `.banlist` | Users banned from the bot _(owner)_ |
| `.block @user` | Block a user _(owner)_ |
| `.broadcast <text>` | Send a message to every group _(owner)_ |
| `.eval <code>` | Run JS in the bot (dangerous) _(owner)_ |
| `.join https://chat.whatsapp.com/XXXX` | Join a group from its link _(owner)_ |
| `.leave` | Make the bot leave this group _(owner, groups only)_ |
| `.mode public\|private\|self` | public \| private \| self _(owner)_ |
| `.reload` | Reload all command files after editing them _(owner)_ |
| `.restart` | Restart the process (needs pm2/nodemon) _(owner)_ |
| `.setbio <text>` | Change the bot about text _(owner)_ |
| `.setname <name>` | Change the bot display name _(owner)_ |
| `.setpp` | Set the bot profile picture (reply to an image) _(owner)_ |
| `.setprefix !` | Change the command prefix at runtime _(owner)_ |
| `.settings` | Show the current bot settings _(owner)_ |
| `.sudo add @user \| del @user \| list` | Give a trusted user owner-level access _(owner)_ |
| `.unban @user` | Let a banned user back in _(owner)_ |
| `.unblock @user` | Unblock a user _(owner)_ |

## 7. Auto-features

| Feature | How to use |
|---|---|
| **Antidelete** | On by default. Deleted messages are re-posted with the sender's name. `.antidelete on\|off` |
| **Antilink** | `.antilink delete` (or `warn`) — removes links from non-admins; bot must be admin |
| **Bad words** | `.badword add <word>` then `.badword on` — the list starts **empty**, you choose the words |
| **Antivv** | `.antivv on` — view-once photos and videos are revealed in that group |
| **Welcome / goodbye** | `.welcome on`, `.goodbye on` |
| **Warnings** | `.warn @user` — 3 warnings and the bot kicks them |
| **XP levels** | Every message gives 5 XP. `.level`, `.leaderboard` |
| **Activity** | `.groupstats` — most active members since install |
| **AFK** | `.afk lunch` — tags get "is AFK", your next message gets "welcome back" |
| **Reminders** | `.remind 1h30m stretch` — survives a restart |
| **Calls** | Incoming voice/video calls are rejected automatically |
| **Reconnect** | Drops reconnect with backoff; `loggedOut` stops and asks you to re-pair |
| **Spam guard** | More than 12 commands in 10 s → 15 s timeout |
| **Ban list** | `.ban @user` — that number gets no replies at all |
| **Hot reload** | `.reload` re-imports every command file from disk |

## 8. Owner and trusted users

`.mode`, `.eval`, `.broadcast`, `.settings`, `.ban`, `.sudo`, `.reload` are limited to
`ownerNumbers`. `.sudo add @user` gives a trusted person the same powers — they cannot
grant sudo themselves, and `.sudo del @user` removes them.

## 9. Optional extras

- **Video stickers** need `ffmpeg` on PATH (`sudo apt install ffmpeg`). Images only need `sharp`.
- **Network commands** (`.weather`, `.wiki`, `.define`, `.shorten`) use free public APIs, no key, but need internet on the host.
- **Run forever**: `npm i -g pm2 && pm2 start index.js --name wa-bot && pm2 save`.
- **Broken file?** The loader logs it and keeps going — one bad command never stops the bot.

## 10. Test without WhatsApp

```bash
npm test        # 184 checks against a mock socket
```

Covers the session-from-env restore (JSON, tar.gz, bare creds, path-traversal refusal),
permissions (owner/sudo/admin/ban), group tools, warnings, bad words, antilink,
levels, expenses, bookmarks, encoders, games, prefix switching, cooldowns, stickers,
and the loader itself (a file is added, reloaded, run, then removed).

## 11. Credits

The feature set was expanded after studying **Silva MD** — [SilvaTechB/silva-md-bot](https://github.com/SilvaTechB/silva-md-bot)
(MIT, © 2026 Silva Tech Nexus). Their project ships 230 plugin files and 922 command names
across 57 npm dependencies; the ideas were re-implemented here against this bot's own
registry. Their MIT notice is kept in `LICENSE-SILVA-MD.txt`.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| "Logged out. Delete the session folder" | Login revoked — delete `session/`, run again, pair fresh |
| A command is missing after you added it | Check the file `export default { name, run }` and the terminal for `[loader]` errors, then `.reload` |
| Owner commands say "owner only" | `ownerNumbers` in `config.json` does not include your number |
| `.sticker` fails on video | Install `ffmpeg` |
| `.antilink` / `.warn` does not kick or delete | Make the bot a group admin |
| `.weather` / `.wiki` fail | No internet on the host, or the free API is rate-limited |
| Bot replies to nothing | Check the prefix (maybe `.setprefix`), and that mode is `public` |

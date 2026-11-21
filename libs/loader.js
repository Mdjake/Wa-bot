/**
 * lib/loader.js — finds every command file under commands/ and registers it.
 *
 * Add a command: drop a file in commands/<category>/<name>.js that
 * `export default { name, run, ... }`. No edits to index.js needed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, commands, register } from './core.js'

export const COMMANDS_DIR = path.join(ROOT, 'commands')

/** Every .js file under commands/, recursively, sorted by path. */
export function commandFiles(dir = COMMANDS_DIR) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...commandFiles(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out.sort()
}

/**
 * Import every command file and register it.
 * bust = true re-imports from disk (used by .reload after you edit a file).
 */
export async function loadCommands({ bust = false } = {}) {
  const files = commandFiles()
  if (!files.length) {
    console.error(`[loader] no command files found in ${COMMANDS_DIR}`)
    return 0
  }
  let loaded = 0
  for (const file of files) {
    const rel = path.relative(ROOT, file)
    const spec = pathToFileURL(file).href + (bust ? `?v=${Date.now()}${Math.random()}` : '')
    try {
      const mod = await import(spec)
      const def = mod.default
      if (!def?.name || typeof def.run !== 'function') {
        console.error(`[loader] ${rel} must "export default { name, run }"`)
        continue
      }
      register(def)
      loaded++
    } catch (e) {
      // one broken file must not take the whole bot down
      console.error(`[loader] ${rel} failed: ${e.message}`)
    }
  }
  return loaded
}

/** Clear the registry and re-import everything from disk. */
export async function reloadCommands() {
  commands.clear()
  return loadCommands({ bust: true })
}

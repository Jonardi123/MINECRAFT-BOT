const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const VERSION = '1.21.1'
const PORT = 25566
const PLAYER_NAME = process.argv[2] || process.env.PVP_PLAYER || 'jonn1'
const BOT_NAME = 'TeammateBot'
const FEATHER_FALLING_BOOTS = 'minecraft:netherite_boots[minecraft:enchantments={levels:{"minecraft:feather_falling":4,"minecraft:protection":4}}]'
const SERVER_DIR = path.join(ROOT, 'temp-server', VERSION)
const LOG_DIR = path.join(ROOT, 'training-logs')
const STATUS_PATH = path.join(ROOT, 'temp-server', 'pvp-server.status.json')
const CONFIG_PATH = path.join(ROOT, 'config.pvp-temp.json')
const MEMORY_PATH = path.join(ROOT, 'temp-server', 'memory.pvp-temp.json')

let server = null
let bot = null
let botKitApplied = false
let playerKitApplied = false

main().catch(err => {
  writeStatus({ state: 'error', error: err.stack || err.message })
  console.error(`[pvp-server] ${err.stack || err.message}`)
  cleanup(1)
})

async function main () {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  writeStatus({ state: 'starting', version: VERSION, port: PORT, player: PLAYER_NAME, bot: BOT_NAME })

  const setup = spawnSync(process.execPath, ['scripts/setup-temp-server.js'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (setup.status !== 0) throw new Error('temp server setup failed')

  server = spawn(resolveJava(), ['-Xmx1536M', '-Xms768M', '-jar', 'server.jar', 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const serverLog = tee(server, 'pvp-server', handleServerText)
  server.on('exit', code => {
    writeStatus({ state: 'server-exited', serverExitCode: code })
    cleanup(code || 0)
  })

  await waitFor(serverLog, /Done \([^)]+\)! For help, type "help"/, 120000, 'server ready')
  configurePvpServer()
  applyPvpKit(BOT_NAME)
  applyPvpKit(PLAYER_NAME)

  bot = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: cleanEnv({
      ...process.env,
      MC_AI_BOT_CONFIG: CONFIG_PATH,
      MC_AI_BOT_MEMORY: MEMORY_PATH
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const botLog = tee(bot, 'pvp-bot')
  bot.on('exit', code => writeStatus({ state: 'bot-exited', botExitCode: code }))

  await waitFor(botLog, /\[bot\] Spawned as TeammateBot/, 90000, 'bot spawn')
  botKitApplied = false
  setTimeout(() => applyPvpKit(BOT_NAME), 1200)
  setTimeout(() => command(`tp ${BOT_NAME} 0 5 0`), 1700)

  writeStatus({
    state: 'running',
    address: `127.0.0.1:${PORT}`,
    version: VERSION,
    player: PLAYER_NAME,
    bot: BOT_NAME,
    serverPid: server.pid,
    botPid: bot.pid
  })

  process.stdin.resume()
  setInterval(() => writeStatus({ heartbeat: new Date().toISOString() }), 30000)
}

function configurePvpServer () {
  for (const line of [
    'gamerule keepInventory true',
    'gamerule doDaylightCycle false',
    'gamerule doWeatherCycle false',
    'difficulty normal',
    'time set day',
    'weather clear',
    'defaultgamemode survival',
    `op ${PLAYER_NAME}`,
    `op ${BOT_NAME}`,
    'op CodexTester',
    'op itzrealme',
    'kill @e[type=minecraft:item]',
    'fill -24 4 -24 24 4 24 minecraft:grass_block',
    'fill -24 5 -24 24 12 24 minecraft:air',
    'fill -24 13 -24 24 20 24 minecraft:air',
    'fill -24 21 -24 24 22 24 minecraft:air',
    `tp ${PLAYER_NAME} 2 5 2`,
    `tp ${BOT_NAME} 0 5 0`
  ]) command(line)
}

function applyPvpKit (name) {
  if (!name) return
  const commands = [
    `gamemode survival ${name}`,
    `effect give ${name} minecraft:instant_health 1 10 true`,
    `effect give ${name} minecraft:saturation 1 10 true`,
    `clear ${name}`,
    `item replace entity ${name} armor.head with minecraft:netherite_helmet`,
    `item replace entity ${name} armor.chest with minecraft:netherite_chestplate`,
    `item replace entity ${name} armor.legs with minecraft:netherite_leggings`,
    `item replace entity ${name} armor.feet with ${FEATHER_FALLING_BOOTS}`,
    `give ${name} ${FEATHER_FALLING_BOOTS} 1`,
    `give ${name} minecraft:mace 1`,
    `give ${name} minecraft:elytra 1`,
    `give ${name} minecraft:firework_rocket 96`,
    `give ${name} minecraft:netherite_sword 1`,
    `give ${name} minecraft:netherite_axe 1`,
    `give ${name} minecraft:shield 1`,
    `give ${name} minecraft:totem_of_undying 24`,
    `give ${name} minecraft:golden_apple 16`,
    `give ${name} minecraft:enchanted_golden_apple 3`,
    `give ${name} minecraft:cooked_beef 32`,
    `give ${name} minecraft:ender_pearl 32`,
    `give ${name} minecraft:bow 1`,
    `give ${name} minecraft:arrow 64`,
    `give ${name} minecraft:end_crystal 32`,
    `give ${name} minecraft:obsidian 64`,
    `give ${name} minecraft:water_bucket 3`,
    `give ${name} minecraft:cobblestone 64`,
    `tell ${name} PvP rekit applied: mace, elytra, rockets, Feather Falling, totems, pearls, water, gaps, crystals.`
  ]
  for (const line of commands) command(line)
  if (name.toLowerCase() === BOT_NAME.toLowerCase()) botKitApplied = true
  if (name.toLowerCase() === PLAYER_NAME.toLowerCase()) playerKitApplied = true
  writeStatus({ kitAppliedTo: name, kitAppliedAt: new Date().toISOString() })
}

function handleServerText (text) {
  const joined = joinedPlayerName(text)
  if (joined && joined.toLowerCase() === PLAYER_NAME.toLowerCase()) {
    setTimeout(() => {
      applyPvpKit(joined)
      command(`tp ${joined} 2 5 2`)
    }, 1200)
  }
  if (joined && joined.toLowerCase() === BOT_NAME.toLowerCase()) {
    setTimeout(() => {
      applyPvpKit(joined)
      command(`tp ${joined} 0 5 0`)
    }, 1200)
  }
  if (!botKitApplied && text.includes(`Made ${BOT_NAME} a server operator`)) setTimeout(() => applyPvpKit(BOT_NAME), 1000)
  if (!playerKitApplied && text.includes(`Made ${PLAYER_NAME} a server operator`)) setTimeout(() => applyPvpKit(PLAYER_NAME), 1000)
}

function joinedPlayerName (text) {
  const match = text.match(/\]: ([A-Za-z0-9_]{1,16}) joined the game/)
  return match?.[1] || null
}

function command (line) {
  if (!server || server.killed || !server.stdin.writable) return
  server.stdin.write(`${line}\n`)
}

function tee (child, name, onText = null) {
  const logPath = path.join(LOG_DIR, `${name}.log`)
  const stream = fs.createWriteStream(logPath, { flags: 'w' })
  const chunks = []
  const onData = data => {
    const text = data.toString()
    chunks.push(text)
    stream.write(text)
    process.stdout.write(`[${name}] ${text}`)
    if (onText) onText(text)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('exit', code => {
    stream.write(`\n[exit ${code}]\n`)
    stream.end()
  })
  return {
    chunks,
    text: () => chunks.join('')
  }
}

function waitFor (log, pattern, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (pattern.test(log.text())) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(`${label} timed out`))
      }
    }, 250)
  })
}

function resolveJava () {
  const appData = process.env.APPDATA || ''
  const candidates = [
    path.join(appData, '.minecraft', 'runtime', 'java-runtime-delta', 'windows', 'java-runtime-delta', 'bin', 'java.exe'),
    path.join(appData, '.minecraft', 'runtime', 'java-runtime-epsilon', 'windows', 'java-runtime-epsilon', 'bin', 'java.exe'),
    path.join(appData, '.tlauncher', 'starter', 'jre_default', 'jre-21.0.11-windows-x64', 'bin', 'java.exe')
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || 'java'
}

function cleanEnv (env) {
  const out = { ...env }
  delete out.NODE_OPTIONS
  return out
}

function writeStatus (patch) {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true })
  const previous = readStatus()
  fs.writeFileSync(STATUS_PATH, `${JSON.stringify({ ...previous, ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

function readStatus () {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function cleanup (code = 0) {
  if (bot && !bot.killed) bot.kill()
  if (server && !server.killed && server.stdin?.writable) {
    command('stop')
    setTimeout(() => {
      if (server && !server.killed) server.kill()
      process.exit(code)
    }, 3000)
    return
  }
  process.exit(code)
}

process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))

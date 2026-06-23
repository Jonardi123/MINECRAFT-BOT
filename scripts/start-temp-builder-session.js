const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const mineflayer = require('mineflayer')

const ROOT = path.resolve(__dirname, '..')
const VERSION = '1.21.1'
const SERVER_DIR = path.join(ROOT, 'temp-server', VERSION)
const LOG_DIR = path.join(ROOT, 'training-logs')
const CONFIG_PATH = path.join(ROOT, 'config.temp-server.json')
const MEMORY_PATH = path.join(ROOT, 'temp-server', 'memory.temp.json')
const STATUS_PATH = path.join(ROOT, 'temp-server', 'builder-session.status.json')
const PLAYER_NAME = process.argv[2] || 'jonn1'
const BOT_NAME = 'TeammateBot'
const COMMANDER_NAME = 'CodexTester'
const PORT = 25566

const BASE_ENV = {
  ...process.env,
  MC_AI_BOT_CONFIG: CONFIG_PATH,
  MC_AI_BOT_MEMORY: MEMORY_PATH,
  MC_AI_BOT_REPORT: path.join(ROOT, 'temp-server', 'NEBULA_TRAINING_REPORT.temp.md')
}

let server
let bot
let commander
let creativeTimer
let buildCommandSent = false
let playerTeleported = false

main().catch(err => {
  writeStatus({ state: 'error', error: err.stack || err.message })
  console.error(`[builder-session] ${err.stack || err.message}`)
  cleanup(1)
})

async function main () {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  writeStatus({ state: 'starting', player: PLAYER_NAME, port: PORT, version: VERSION, pid: process.pid })

  const setup = spawnSync(process.execPath, ['scripts/setup-temp-server.js'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (setup.status !== 0) throw new Error('temp server setup failed')
  resetTempMemory()

  server = spawn(resolveJava(), ['-Xmx1024M', '-Xms512M', '-jar', 'server.jar', 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const serverLog = tee(server, 'builder-session-server', handleServerText)
  writeStatus({ state: 'server-starting', serverPid: server.pid })

  server.on('exit', code => {
    writeStatus({ state: 'server-exited', serverExitCode: code })
    cleanup(code || 0)
  })

  await waitFor(serverLog, /Done \([^)]+\)! For help, type "help"/, 90000, 'server ready')
  configureServer()
  writeStatus({ state: 'server-ready', address: `127.0.0.1:${PORT}`, player: PLAYER_NAME, serverPid: server.pid })

  bot = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: cleanEnv(BASE_ENV),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const botLog = tee(bot, 'builder-session-bot')
  writeStatus({ state: 'bot-starting', address: `127.0.0.1:${PORT}`, botPid: bot.pid, serverPid: server.pid })

  bot.on('exit', code => {
    writeStatus({ state: 'bot-exited', botExitCode: code })
  })

  await waitFor(botLog, /\[bot\] Spawned as TeammateBot/, 90000, 'bot spawn')
  prepBotForBuilding()
  startCreativeKeeper()
  await startCommander()
  await sendBuildCommand()

  writeStatus({
    state: 'running',
    address: `127.0.0.1:${PORT}`,
    version: VERSION,
    player: PLAYER_NAME,
    bot: BOT_NAME,
    buildCommandSent,
    serverPid: server.pid,
    botPid: bot.pid
  })

  process.stdin.resume()
  setInterval(() => writeStatus({ heartbeat: new Date().toISOString() }), 30000)
}

function configureServer () {
  for (const line of [
    'gamerule keepInventory true',
    'gamerule doDaylightCycle false',
    'difficulty peaceful',
    'time set day',
    'weather clear',
    'defaultgamemode creative',
    `op ${PLAYER_NAME}`,
    `op ${BOT_NAME}`,
    `op ${COMMANDER_NAME}`,
    'gamemode creative @a',
    'kill @e[type=minecraft:item]',
    'kill @e[type=minecraft:slime]'
  ]) command(line)
}

function prepBotForBuilding () {
  for (const line of [
    `tp ${BOT_NAME} 0 5 0`,
    `gamemode creative ${BOT_NAME}`,
    `effect give ${BOT_NAME} minecraft:instant_health 1 10 true`,
    'fill -30 4 -30 30 4 30 grass_block',
    'fill -30 5 -30 30 16 30 air',
    `clear ${BOT_NAME}`,
    `give ${BOT_NAME} spruce_log 80`,
    `give ${BOT_NAME} spruce_planks 420`,
    `give ${BOT_NAME} spruce_stairs 32`,
    `give ${BOT_NAME} spruce_slab 64`,
    `give ${BOT_NAME} spruce_fence 64`,
    `give ${BOT_NAME} spruce_trapdoor 24`,
    `give ${BOT_NAME} stone_bricks 128`,
    `give ${BOT_NAME} cobblestone 96`,
    `give ${BOT_NAME} dirt 32`,
    `give ${BOT_NAME} blue_stained_glass 4`,
    `give ${BOT_NAME} glass 32`,
    `give ${BOT_NAME} glass_pane 32`,
    `give ${BOT_NAME} spruce_door 2`,
    `give ${BOT_NAME} chest 2`,
    `give ${BOT_NAME} crafting_table 1`,
    `give ${BOT_NAME} furnace 2`,
    `give ${BOT_NAME} lantern 8`,
    `give ${BOT_NAME} torch 32`,
    `give ${BOT_NAME} cooked_beef 16`
  ]) command(line)
}

function startCreativeKeeper () {
  creativeTimer = setInterval(() => {
    command('gamemode creative @a')
    command(`gamemode creative ${BOT_NAME}`)
    command(`gamemode creative ${PLAYER_NAME}`)
  }, 5000)
}

async function startCommander () {
  commander = mineflayer.createBot({
    host: '127.0.0.1',
    port: PORT,
    version: VERSION,
    username: COMMANDER_NAME,
    auth: 'offline',
    hideErrors: true,
    logErrors: false
  })

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('commander join timed out')), 30000)
    commander.once('spawn', () => {
      clearTimeout(timeout)
      command(`gamemode creative ${COMMANDER_NAME}`)
      resolve()
    })
    commander.once('error', reject)
  })
}

async function sendBuildCommand () {
  if (buildCommandSent) return
  await delay(2500)
  commander.chat('!buildBase fancy spruce')
  buildCommandSent = true
  writeStatus({ buildCommandSent: true, buildCommandAt: new Date().toISOString() })
}

function handleServerText (text) {
  if (!playerTeleported && text.includes(`${PLAYER_NAME} joined the game`)) {
    playerTeleported = true
    setTimeout(() => {
      command(`gamemode creative ${PLAYER_NAME}`)
      command(`tp ${PLAYER_NAME} 2 5 2`)
      command(`tell ${PLAYER_NAME} Builder session ready. TeammateBot is building the fancy base.`)
      writeStatus({ playerJoined: true, playerTeleported: true })
    }, 1000)
  }

  if (text.includes('<TeammateBot>') && text.includes('base placed')) {
    writeStatus({ buildComplete: true, buildCompleteAt: new Date().toISOString() })
  }
}

function command (line) {
  if (!server || server.killed || !server.stdin.writable) return
  server.stdin.write(`${line}\n`)
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
    text: () => chunks.join('')
  }
}

function waitFor (log, pattern, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (pattern.test(log.text())) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}`))
      }
    }, 500)
  })
}

function resetTempMemory () {
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true })
  fs.writeFileSync(MEMORY_PATH, JSON.stringify({
    home: { x: 0, y: 5, z: 0 },
    chests: {},
    players: {},
    notes: [],
    ai: {
      enabled: false,
      paused: true,
      currentGoal: 'builder session: build a fancy base in creative on the local temp server',
      realPlayer: { enabled: false }
    }
  }, null, 2))
}

function writeStatus (patch) {
  const previous = readJson(STATUS_PATH, {})
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true })
  fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2), 'utf8')
}

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function cleanEnv (env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => key && !key.includes('=') && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  )
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanup (code = 0) {
  if (creativeTimer) clearInterval(creativeTimer)
  try { commander?.quit('builder session closing') } catch {}
  if (bot && !bot.killed) bot.kill()
  if (server && !server.killed) {
    command('stop')
    setTimeout(() => {
      if (!server.killed) server.kill()
      process.exit(code)
    }, 3000)
    return
  }
  process.exit(code)
}

process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))

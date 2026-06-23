const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const VERSION = '1.21.1'
const SERVER_DIR = path.join(ROOT, 'temp-server', VERSION)
const LOG_DIR = path.join(ROOT, 'training-logs')
const CONFIG_PATH = path.join(ROOT, 'config.temp-server.json')
const MEMORY_PATH = path.join(ROOT, 'temp-server', 'memory.temp.json')
const REPORT_PATH = path.join(ROOT, 'temp-server', 'NEBULA_TRAINING_REPORT.temp.md')
const REQUESTED_SCENARIOS = new Set(process.argv.slice(2).map(name => name.toLowerCase()).filter(Boolean))
const BASE_ENV = {
  ...process.env,
  MC_AI_BOT_CONFIG: CONFIG_PATH,
  MC_AI_BOT_MEMORY: MEMORY_PATH,
  MC_AI_BOT_REPORT: REPORT_PATH
}
const CHILD_ENV = cleanEnv(BASE_ENV)

main().catch(err => {
  console.error(`[temp-tests] ${err.stack || err.message}`)
  process.exit(1)
})

async function main () {
  fs.mkdirSync(LOG_DIR, { recursive: true })

  const setup = spawnSync(process.execPath, ['scripts/setup-temp-server.js'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (setup.status !== 0) throw new Error('temp server setup failed')
  resetTempMemory()

  const server = spawn(resolveJava(), ['-Xmx1024M', '-Xms512M', '-jar', 'server.jar', 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const serverLog = tee(server, 'temp-server')

  let bot
  const results = []
  try {
    await waitFor(serverLog, /Done \([^)]+\)! For help, type "help"/, 90000, 'server ready')
    command(server, 'gamerule keepInventory true')
    command(server, 'gamerule doDaylightCycle false')
    command(server, 'difficulty normal')
    command(server, 'time set day')
    command(server, 'weather clear')
    command(server, 'kill @e[type=minecraft:slime]')
    command(server, 'kill @e[type=minecraft:item]')
    command(server, 'op TeammateBot')
    command(server, 'op CodexTester')

    bot = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      env: CHILD_ENV,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const botLog = tee(bot, 'temp-bot')
    await waitFor(botLog, /\[bot\] Spawned as TeammateBot/, 90000, 'bot spawn')
    command(server, 'tp TeammateBot 0 5 0')
    command(server, 'effect give TeammateBot minecraft:instant_health 1 10 true')
    await delay(2500)

    if (shouldRun('craftdrill')) results.push(await runScenario('craftdrill', 180000, server, [
      'clear TeammateBot',
      'give TeammateBot oak_log 16',
      'give TeammateBot oak_planks 16',
      'give TeammateBot cobblestone 32',
      'give TeammateBot white_wool 3',
      'give TeammateBot cooked_beef 8',
      'setblock 1 4 0 minecraft:crafting_table',
      'tp TeammateBot 0 5 0'
    ]))

    if (shouldRun('fancybase')) results.push(await runScenario('fancybase', 520000, server, [
      'effect give TeammateBot minecraft:instant_health 1 10 true',
      'tp TeammateBot 0 5 0'
    ]))

    if (shouldRun('duel')) results.push(await runScenario('duel', 100000, server, [
      'effect give TeammateBot minecraft:instant_health 1 10 true',
      'give TeammateBot iron_sword 1',
      'give TeammateBot shield 1',
      'give TeammateBot cooked_beef 8',
      'tp TeammateBot 0 5 0'
    ]))

    if (shouldRun('mobdrill')) results.push(await runScenario('mobdrill', 130000, server, [
      'effect give TeammateBot minecraft:instant_health 1 10 true',
      'give TeammateBot iron_sword 1',
      'give TeammateBot shield 1',
      'give TeammateBot cooked_beef 12',
      'tp TeammateBot 0 5 0'
    ]))

    if (shouldRun('realplayer')) results.push(await runScenario('realplayer', 130000, server, [
      'effect give TeammateBot minecraft:instant_health 1 10 true',
      'give TeammateBot cooked_beef 8',
      'tp TeammateBot 0 5 0'
    ]))

    if (REQUESTED_SCENARIOS.size && !results.length) {
      throw new Error(`no matching temp-server scenarios: ${[...REQUESTED_SCENARIOS].join(', ')}`)
    }

    const report = spawnSync(process.execPath, ['scripts/nebula-training-report.js'], {
      cwd: ROOT,
      env: CHILD_ENV,
      encoding: 'utf8'
    })
    fs.writeFileSync(path.join(LOG_DIR, 'temp-training-report.out.log'), report.stdout || '', 'utf8')
    fs.writeFileSync(path.join(LOG_DIR, 'temp-training-report.err.log'), report.stderr || '', 'utf8')
    results.push({ name: 'training:report', code: report.status })
  } finally {
    if (bot && !bot.killed) bot.kill()
    command(server, 'stop')
    await delay(4000)
    if (!server.killed) server.kill()
  }

  console.log('[temp-tests] results')
  for (const result of results) console.log(`- ${result.name}: ${result.code === 0 ? 'pass' : `failed (${result.code})`}`)
  const failed = results.filter(result => result.code !== 0)
  if (failed.length) process.exit(1)
}

async function runScenario (name, timeoutMs, server, setupCommands = []) {
  console.log(`[temp-tests] scenario ${name}`)
  for (const line of [
    'kill @e[type=minecraft:slime]',
    'kill @e[type=minecraft:item]',
    'kill @e[type=minecraft:zombie]',
    'kill @e[type=minecraft:skeleton]',
    'time set day',
    'weather clear'
  ]) command(server, line)
  for (const line of setupCommands) command(server, line)
  await delay(2500)

  const child = spawn(process.execPath, ['scripts/test-bot.js', name, String(timeoutMs)], {
    cwd: ROOT,
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  tee(child, `test-${name}`)
  const code = await exitCode(child)
  return { name, code }
}

function command (server, line) {
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

function tee (child, name) {
  const logPath = path.join(LOG_DIR, `${name}.log`)
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  const chunks = []
  const onData = data => {
    const text = data.toString()
    chunks.push(text)
    stream.write(text)
    process.stdout.write(`[${name}] ${text}`)
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

function exitCode (child) {
  return new Promise(resolve => {
    child.on('exit', code => resolve(code ?? 1))
  })
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldRun (name) {
  return REQUESTED_SCENARIOS.size === 0 || REQUESTED_SCENARIOS.has(name)
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
      currentGoal: 'compete with itzrealme: survive like a real player, keep food stable, craft tools, gear up, defend from mobs, and keep progressing without waiting for commands',
      realPlayer: {
        enabled: false
      }
    }
  }, null, 2))
}

function cleanEnv (env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => key && !key.includes('=') && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  )
}

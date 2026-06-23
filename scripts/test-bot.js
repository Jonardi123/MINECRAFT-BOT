const mineflayer = require('mineflayer')
const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')
const { loadConfig } = require('../lib/configLoader')
const config = loadConfig()

const scenarioName = (process.argv[2] || 'wood').toLowerCase()
const parsedTimeout = Number(process.argv[3])
const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 120000

const scenarios = {
  wood: [
    ['!status', 5000],
    ['bot make an axe', 30000],
    ['!inventory', 5000],
    ['bot get wood 16', 60000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  combat: [
    ['!mobDefenseStatus', 5000],
    ['bot defend yourself', 5000],
    ['!status', 5000]
  ],
  mining: [
    ['!status', 5000],
    ['!inventory', 5000],
    ['!getStone 12', 50000],
    ['!inventory', 5000],
    ['!goMine stone 4', 45000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  stone: [
    ['!status', 5000],
    ['!getStone 4', 50000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  mineonly: [
    ['!dispatcherOff', 5000],
    ['!status', 5000],
    ['!getStone 4', 60000],
    ['!goMine stone 4', 60000],
    ['!inventory', 5000],
    ['!status', 5000],
    ['!dispatcherOn', 5000]
  ],
  miningtech: [
    ['!status', 5000],
    ['!getStone 8', 40000],
    ['!stripMine 6', 45000],
    ['!status', 5000],
    ['!branchMine 1 4', 50000],
    ['!status', 5000],
    ['!mineArea 2 2 3', 45000],
    ['!inventory', 5000]
  ],
  prospect: [
    ['!status', 5000],
    ['!prospect coal 1 32', 70000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  beacon: [
    ['!beaconStatus', 5000],
    ['!diamondBeacon 1', 65000],
    ['!beaconStatus', 5000],
    ['!status', 5000]
  ],
  beaconlong: [
    ['!beaconStatus', 5000],
    ['!diamondBeacon 5', 180000],
    ['!beaconStatus', 5000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  build: [
    ['!status', 5000],
    ['!buildCamp', 35000],
    ['!inventory', 5000],
    ['!buildShelter', 70000],
    ['!status', 5000]
  ],
  fancybase: [
    ['/gamerule keepInventory true', 1500],
    ['/time set day', 1500],
    ['/weather clear', 1500],
    ['/tp $BOT 0 5 0', 2500],
    ['/fill -30 4 -30 30 4 30 grass_block', 1500],
    ['/fill -30 5 -30 30 16 30 air', 1500],
    ['/clear $BOT', 1500],
    ['/give $BOT spruce_log 80', 1500],
    ['/give $BOT spruce_planks 420', 1500],
    ['/give $BOT spruce_stairs 32', 1500],
    ['/give $BOT spruce_slab 64', 1500],
    ['/give $BOT spruce_fence 64', 1500],
    ['/give $BOT spruce_trapdoor 24', 1500],
    ['/give $BOT stone_bricks 128', 1500],
    ['/give $BOT cobblestone 96', 1500],
    ['/give $BOT dirt 32', 1500],
    ['/give $BOT blue_stained_glass 4', 1500],
    ['/give $BOT glass 32', 1500],
    ['/give $BOT glass_pane 32', 1500],
    ['/give $BOT spruce_door 2', 1500],
    ['/give $BOT chest 2', 1500],
    ['/give $BOT crafting_table 1', 1500],
    ['/give $BOT furnace 2', 1500],
    ['/give $BOT lantern 8', 1500],
    ['/give $BOT torch 32', 1500],
    ['/give $BOT cooked_beef 8', 1500],
    ['!buildBase fancy spruce', 420000],
    ['!botStash', 5000],
    ['!status', 5000]
  ],
  bootstrap: [
    ['!status', 5000],
    ['!bootstrap', 100000],
    ['!botStash', 5000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  ironkit: [
    ['!checkSupplies', 5000],
    ['!autoplay 25', 150000],
    ['!smartMine iron_ore 4', 90000],
    ['!cookFood 4', 45000],
    ['!autoplayStatus', 5000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  cavesafe: [
    ['!risk', 5000],
    ['!torchMine 16', 70000],
    ['!caveExplore 24', 90000],
    ['!findExposed iron_ore', 5000],
    ['!autoplayStatus', 5000],
    ['!status', 5000]
  ],
  marlow: [
    ['!rewardStatus', 5000],
    ['!brainStatus', 5000],
    ['!bootstrap', 100000],
    ['!botStash', 5000],
    ['!autoplay 15', 100000],
    ['!checkSupplies', 5000],
    ['!smartMine iron_ore 4', 90000],
    ['!torchMine 12', 60000],
    ['!caveExplore 16', 70000],
    ['!deposit', 30000],
    ['!autoplayStatus', 5000],
    ['!rewardStatus', 5000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  craftdrill: [
    ['/clear $BOT', 1500],
    ['/give $BOT oak_log 16', 1500],
    ['/give $BOT oak_planks 16', 1500],
    ['/give $BOT cobblestone 32', 1500],
    ['/give $BOT white_wool 3', 1500],
    ['/give $BOT cooked_beef 8', 1500],
    ['/setblock 1 4 0 crafting_table', 1500],
    ['!inventory', 5000],
    ['bot make tools', 45000],
    ['!makeBed', 45000],
    ['!inventory', 5000],
    ['!status', 5000]
  ],
  mobdrill: [
    ['/time set night', 1500],
    ['/weather clear', 1500],
    ['/gamerule keepInventory true', 1500],
    ['/tp $BOT 0 5 0', 2500],
    ['/give $BOT cooked_beef 12', 1500],
    ['/give $BOT iron_sword 1', 1500],
    ['/give $BOT shield 1', 1500],
    ['!mobDefenseOn', 3000],
    ['/summon zombie 3 5 0', 8000],
    ['/summon skeleton -4 5 0', 10000],
    ['!mobDefenseStatus', 5000],
    ['!status', 5000]
  ],
  realplayer: [
    ['/gamerule keepInventory true', 1500],
    ['/time set day', 1500],
    ['/weather clear', 1500],
    ['/tp $BOT 0 5 0', 2500],
    ['!realPlayer', 60000],
    ['!brainStatus', 5000],
    ['!rewardStatus', 5000],
    ['!realPlayerStatus', 5000],
    ['!status', 5000]
  ],
  selfplay: [
    ['!status', 5000],
    ['!autoplay', 10000],
    ['!autoplayStatus', 5000],
    ['!status', 5000]
  ],
  status: [
    ['!status', 5000],
    ['!inventory', 5000],
    ['!dispatcherStatus', 5000]
  ],
  stop: [
    ['!stop', 5000],
    ['!status', 5000]
  ]
}

const commands = scenarios[scenarioName] || [[process.argv.slice(2).join(' '), 8000]]

if (!commands[0][0]) {
  console.error('Usage: npm run test:bot -- wood|combat|mining|miningtech|prospect|ironkit|cavesafe|marlow|craftdrill|mobdrill|fancybase|realplayer|duel|status|stop|"<chat command>"')
  process.exit(1)
}

const tester = mineflayer.createBot({
  host: config.server.host,
  port: config.server.port,
  version: config.server.version === 'auto' ? false : config.server.version,
  username: 'CodexTester',
  auth: 'offline',
  hideErrors: true,
  logErrors: false
})

tester.loadPlugin(pathfinder)

let finished = false
const startedAt = Date.now()

function log (message) {
  const elapsed = String(((Date.now() - startedAt) / 1000).toFixed(1)).padStart(5, ' ')
  console.log(`[tester +${elapsed}s] ${message}`)
}

function finish (code = 0) {
  if (finished) return
  finished = true
  try { tester.quit('Codex test done') } catch {}
  setTimeout(() => process.exit(code), 500)
}

tester.once('spawn', async () => {
  log(`joined as ${tester.username}; scenario=${scenarioName}`)
  const mcData = require('minecraft-data')(tester.version)
  tester.pathfinder.setMovements(new Movements(tester, mcData))
  await sleep(1500)

  if (scenarioName === 'duel') {
    await runDuel()
    log('scenario complete')
    finish(0)
    return
  }

  for (const [command, waitMs] of commands) {
    const commandText = expandCommand(command)
    log(`chat > ${commandText}`)
    tester.chat(commandText)
    await sleep(waitMs)
  }

  log('scenario complete')
  finish(0)
})

async function runDuel () {
  tester.chat(`/tp ${tester.username} 2 5 0`)
  await sleep(1200)
  tester.chat(`/tp ${config.bot.username} 0 5 0`)
  await sleep(1200)
  tester.chat('!pvpOn')
  await sleep(2500)
  tester.chat('!come')
  await sleep(8000)
  tester.chat('!status')
  await sleep(2500)

  const target = await waitForTeammate()
  if (!target) throw new Error(`${config.bot.username} not visible`)
  log(`target visible at ${round(target.position.x)} ${round(target.position.y)} ${round(target.position.z)}`)

  tester.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  for (let i = 0; i < 10; i++) {
    if (!target.isValid) break
    const distance = tester.entity.position.distanceTo(target.position)
    if (distance <= 3.2) {
      await tester.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
      log(`attack ${i + 1}, distance=${distance.toFixed(1)}`)
      tester.attack(target)
    } else {
      log(`closing distance=${distance.toFixed(1)}`)
    }
    await sleep(700)
  }

  tester.pathfinder.stop()
  tester.clearControlStates()
  await sleep(10000)
  tester.chat('!status')
  await sleep(5000)
}

async function waitForTeammate () {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const target = tester.players[config.bot.username]?.entity ||
      tester.nearestEntity(entity => entity.type === 'player' && entity.username === config.bot.username)
    if (target?.isValid) return target
    await sleep(500)
  }
  return null
}

tester.on('chat', (username, message) => {
  log(`<${username}> ${message}`)
})

tester.on('messagestr', message => {
  const text = String(message || '')
  if (text.includes('CodexTester') || text.includes(config.bot.username)) log(text)
})

tester.on('kicked', reason => {
  log(`kicked: ${reason}`)
  finish(2)
})

tester.on('error', err => {
  log(`error: ${err.message}`)
})

tester.on('end', () => {
  if (!finished) {
    log('disconnected')
    finish(1)
  }
})

setTimeout(() => {
  log(`timeout after ${timeoutMs}ms`)
  finish(3)
}, timeoutMs)

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function round (value) {
  return Math.round(Number(value) || 0)
}

function expandCommand (command) {
  return String(command).replace(/\$BOT\b/g, config.bot.username)
}

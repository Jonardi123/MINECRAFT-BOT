const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

const { loadConfig } = require('../configLoader')
const { setupMovement, sleep } = require('../navigation')
const { loadOptionalPlugins } = require('../pluginLoader')
const { fightEntitySmart, equipBestWeapon, equipBestShield, equipBestTotem } = require('../combat')
const { equipBestArmorFromInventory } = require('../equipment')

const config = loadConfig()
const username = process.env.CODEX_BOT_USERNAME || 'CodexBot'
const targetName = process.env.CODEX_TARGET || process.argv[2] || config.bot?.username || 'TeammateBot'
const roundMs = Number(process.env.CODEX_ROUND_MS || 45000)
const reengageMs = Number(process.env.CODEX_REENGAGE_MS || 900)

let running = true
let bot = null

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

createBot()

function createBot () {
  bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    version: config.server.version === 'auto' ? false : config.server.version,
    username,
    auth: config.bot?.auth || 'offline',
    hideErrors: true,
    logErrors: false
  })

  bot.loadPlugin(pathfinder)
  loadOptionalPlugins(bot, config)

  bot.once('spawn', () => {
    setupMovement(bot, config)
    console.log(`[codex-sparring] ${username} spawned; target=${targetName}`)
    gearLoop()
    fightLoop().catch(err => {
      console.error('[codex-sparring]', err.message)
      shutdown()
    })
  })

  bot.on('death', () => {
    console.log('[codex-sparring] died; waiting to respawn')
  })
  bot.on('kicked', reason => console.error('[codex-sparring] kicked:', short(reason)))
  bot.on('error', err => console.error('[codex-sparring] error:', short(err)))
  bot.on('end', reason => {
    console.log(`[codex-sparring] disconnected${reason ? `: ${short(reason)}` : ''}`)
    if (running && config.bot?.reconnect !== false) {
      setTimeout(createBot, config.bot?.reconnectDelayMs || 10000)
    }
  })
}

async function gearLoop () {
  while (running && bot?.entity) {
    await equipBestArmorFromInventory(bot, config).catch(() => {})
    await equipBestWeapon(bot).catch(() => {})
    if (bot.health <= (config.pvp?.totemHealth || 7)) {
      await equipBestTotem(bot).catch(() => {})
    } else {
      await equipBestShield(bot).catch(() => {})
    }
    await sleep(1800)
  }
}

async function fightLoop () {
  const speaker = {
    say: message => console.log(`[codex-sparring] ${message}`),
    autopilot: message => console.log(`[codex-sparring] ${message}`)
  }

  while (running && bot?.entity) {
    const target = findTarget()
    if (!target) {
      await sleep(1000)
      continue
    }

    console.log(`[codex-sparring] engaging ${entityName(target)}`)
    const result = await fightEntitySmart(bot, {}, config, speaker, target, {
      get cancelled () {
        return !running || !bot?.entity
      }
    }, {
      maxFightMs: roundMs,
      maxChaseDistance: Math.max(config.pvp?.maxChaseDistance || 16, 22),
      attackRange: config.pvp?.attackRange || 3.2,
      tickMs: config.pvp?.tickMs || 160,
      allowHungryDefense: true,
      forceEngage: true,
      playerFight: true,
      targetSelector: current => findTarget() || current,
      nearbyPlayers: () => [findTarget()].filter(Boolean),
      opponentSwingAgeMs: () => null
    }).catch(err => ({ reason: err.message || 'error' }))

    console.log(`[codex-sparring] round ended: ${result?.reason || 'unknown'}`)
    await sleep(reengageMs)
  }
}

function findTarget () {
  const lower = targetName.toLowerCase()
  const direct = bot.players?.[targetName]?.entity
  if (direct?.isValid) return direct
  const player = Object.entries(bot.players || {})
    .find(([name, player]) => name.toLowerCase() === lower && player.entity?.isValid)
  if (player) return player[1].entity
  return bot.nearestEntity(entity => {
    if (entity.type !== 'player') return false
    if (entity.username === username) return false
    return (entity.username || entity.name || '').toLowerCase() === lower
  })
}

function entityName (entity) {
  return entity?.username || entity?.name || 'target'
}

function shutdown () {
  running = false
  try { bot?.quit?.('sparring done') } catch {}
}

function short (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 180)
}

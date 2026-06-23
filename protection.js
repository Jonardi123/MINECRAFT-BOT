const { sleep } = require('./navigation')
const { fightEntitySmart, findBestHostileThreat, eatIfSafe } = require('./combat')
const { addReward } = require('./rewardSystem')

function createProtector (bot, speaker, config, memory) {
  let enabled = false
  let loop = null

  async function protectLoop () {
    let lastChatAt = 0
    while (enabled) {
      const threat = findThreat(bot, config)
      if (bot.health <= protectLowHealth(config)) {
        if (Date.now() - lastChatAt > 8000) {
          speaker.say('Health low, backing off protect mode for a moment.')
          lastChatAt = Date.now()
        }
        const ate = await eatIfSafe(bot, threat).catch(() => false)
        if (!ate && threat) await retreatFromThreat(bot, threat)
        await sleep(config.behavior.protectTickMs || 350)
        continue
      }
      if (threat && isDangerousToPlayer(bot, threat, config)) {
        if (Date.now() - lastChatAt > 5000) {
          speaker.say('Protecting.')
          lastChatAt = Date.now()
        }
        await fightEntitySmart(bot, memory, config, speaker, threat, { get cancelled () { return !enabled } }, {
          maxChaseDistance: config.behavior.protectMaxChaseDistance,
          attackRange: 3.2,
          tickMs: config.behavior.protectTickMs || 350
        }).catch(err => console.error('[protect fight]', err.message))
        addReward(memory, 'protected_player', 10, { target: threat.name })
      }
      await sleep(config.behavior.protectTickMs || 350)
    }
  }

  return {
    get enabled () {
      return enabled
    },
    start () {
      if (enabled) return
      enabled = true
      loop = protectLoop().catch(err => console.error('[protect]', err))
    },
    stop () {
      enabled = false
      loop = null
    }
  }
}

function findThreat (bot, config) {
  return findBestHostileThreat(bot, config, true)
}

function isDangerousToPlayer (bot, threat, config) {
  const range = config.behavior?.protectRange || 8
  if (!threat?.position || threat.position.distanceTo(bot.entity.position) > range + 6) return false
  return Object.entries(bot.players || {}).some(([username, player]) => {
    if (!player.entity || !new Set(config.allowedPlayers || []).has(username)) return false
    return player.entity.position.distanceTo(threat.position) <= range
  })
}

function protectLowHealth (config) {
  return Math.max(config.behavior?.lowHealth || 0, config.pvp?.retreatHealth || 0, 8)
}

async function retreatFromThreat (bot, threat) {
  if (!threat?.position || !bot.entity) return
  const dx = bot.entity.position.x - threat.position.x
  const dz = bot.entity.position.z - threat.position.z
  const yaw = Math.atan2(-dx, -dz)
  await bot.look(yaw, 0, true).catch(() => {})
  bot.pathfinder?.stop()
  bot.setControlState('back', true)
  bot.setControlState('sprint', true)
  await sleep(600)
  bot.setControlState('back', false)
  bot.setControlState('sprint', false)
}

module.exports = { createProtector }

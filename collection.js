const { goNear, sleep } = require('./navigation')

async function collectNearbyItems (bot, config, signal, options = {}) {
  const radius = options.radius || config.behavior.itemCollectRadius || 8
  const attempts = options.attempts || config.behavior.itemCollectAttempts || 8
  const waitMs = options.waitMs || 250
  let collected = 0

  for (let i = 0; i < attempts && !signal.cancelled; i++) {
    const item = bot.nearestEntity(entity => {
      return entity.name === 'item' && entity.position.distanceTo(bot.entity.position) <= radius
    })
    if (!item) {
      await sleep(waitMs)
      continue
    }

    await goNear(bot, item.position, 1, signal, config.behavior.itemCollectPathTimeoutMs || 2500).catch(() => {})
    await sleep(waitMs)
    collected++
  }

  return collected
}

module.exports = { collectNearbyItems }

const { goNear, assertNotCancelled, sleep } = require('./navigation')
const { depositInventory } = require('./chest')
const { collectNearbyItems } = require('./collection')
const { equipBestWeapon, eatIfSafe } = require('./combat')
const { hostileNearby } = require('./safety')

const TARGETS = {
  pigs: ['pig'],
  cows: ['cow'],
  sheep: ['sheep'],
  chickens: ['chicken'],
  zombies: ['zombie', 'zombie_villager', 'drowned', 'husk'],
  skeletons: ['skeleton', 'stray'],
  spiders: ['spider', 'cave_spider'],
  creepers: ['creeper']
}

const HOSTILE_TARGETS = new Set(['zombies', 'skeletons', 'spiders', 'creepers'])

async function farmTarget (bot, memory, config, speaker, target, amount, signal) {
  const names = TARGETS[target.toLowerCase()]
  if (!names) throw new Error('Supported targets: pigs, cows, sheep, chickens, zombies, skeletons, spiders, creepers.')

  let killed = 0
  speaker.say(`Farming ${target}.`)

  while (killed < amount && !signal.cancelled) {
    if (bot.health <= farmingLowHealth(config)) {
      const ate = await eatIfSafe(bot, null).catch(() => false)
      if (ate) continue
      speaker.say('Low health, stopping farm.')
      break
    }
    if (!HOSTILE_TARGETS.has(target.toLowerCase()) && hostileNearby(bot, config.behavior?.miningMobPauseRange || 6, config, memory)) {
      speaker.say('Hostile mob nearby, stopping farm.')
      break
    }

    const entity = nearestAllowedMob(bot, names, config)
    if (!entity) break

    const reached = await goNear(bot, entity.position, target === 'creepers' ? 4 : 2, signal, config.behavior?.pathTimeoutMs || 6000)
      .then(() => true)
      .catch(err => {
        speaker.say(`Could not reach ${target}: ${shortError(err)}.`)
        return false
      })
    if (!reached) break
    assertNotCancelled(signal)
    if (!entity.isValid) continue

    if (target === 'creepers' && entity.position.distanceTo(bot.entity.position) < 3) {
      speaker.say('Creeper is too close. Backing off.')
      break
    }

    await equipBestWeapon(bot).catch(() => {})
    const defeated = await attackUntilDead(bot, entity, signal, HOSTILE_TARGETS.has(target), config)
    if (!defeated) {
      speaker.say(`Could not safely finish ${target}.`)
      break
    }
    killed++
    await collectNearbyDrops(bot, config, signal)
  }

  await depositInventory(bot, memory, config, 'farm', signal).catch(err => {
    speaker.say(`Farm drops not deposited: ${shortError(err)}.`)
  })
  speaker.say(`Farmed ${killed}/${amount}.`)
}

function nearestAllowedMob (bot, names, config) {
  return bot.nearestEntity(entity => {
    if (!entity || !entity.isValid) return false
    if (!names.includes(entity.name)) return false
    if (entity.username) return false
    if (entity.metadata?.some?.(entry => String(entry).includes('CustomName'))) return false
    return entity.position.distanceTo(bot.entity.position) <= config.behavior.mobSearchRadius
  })
}

async function attackUntilDead (bot, entity, signal, cautious, config) {
  const endAt = Date.now() + (config.behavior?.farmAttackTimeoutMs || 12000)
  while (!signal.cancelled && entity.isValid && entity.health !== 0 && Date.now() < endAt) {
    if (cautious && bot.health <= farmingLowHealth(config) + 2) return false
    await equipBestWeapon(bot).catch(() => {})
    await bot.lookAt(entity.position.offset(0, entity.height || 1, 0), true).catch(() => {})
    bot.attack(entity)
    await sleep(700)
  }
  return !entity.isValid || entity.health === 0
}

async function collectNearbyDrops (bot, config, signal) {
  await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8, waitMs: 400 })
}

module.exports = { farmTarget, TARGETS }

function farmingLowHealth (config) {
  return Math.max(config.behavior?.lowHealth || 0, 8)
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)
}

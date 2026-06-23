const { fightEntitySmart, findBestHostileThreat, HOSTILE_PRIORITY, equipBestWeapon, equipBestShield } = require('./combat')
const { addReward } = require('./rewardSystem')
const { classifyEntityThreat, findAdaptiveThreat, recordObservedThreats, shouldEvadeThreat } = require('./modThreat')
const { goNear } = require('./navigation')

function createMobDefenseController (bot, speaker, config, tasks, memory, resumeAutoplay) {
  const settings = config.mobDefense || {}
  let enabled = settings.enabledByDefault !== false
  let active = false
  let target = null
  let lastHealth = bot.health || 20
  let wasAutoplay = false
  let suppressResume = false
  let lastTriggerAt = 0
  let fightStartedAt = 0
  const scanTimer = setInterval(() => {
    if (!enabled || !bot.entity) return
    recordObservedThreats(bot, memory, config)
    if (active) {
      if (shouldAbortStaleFight()) stopFight(true)
      return
    }
    const threat = findPreemptiveThreat(bot, config)
    if (threat) startFight(threat, 'nearby_threat')
  }, settings.scanMs || 350)

  bot.on('health', () => {
    const oldHealth = lastHealth
    lastHealth = bot.health || lastHealth
    if (!enabled || active || !bot.entity) return
    if (bot.health >= oldHealth || bot.health <= 0) return
    triggerDefense('health_drop')
  })

  bot.on('entityHurt', entity => {
    if (!enabled || active || !bot.entity) return
    if (!entity || entity.id !== bot.entity.id) return
    triggerDefense('entity_hurt')
  })

  bot.on('death', () => {
    if (!active) return
    stopFight(false)
  })

  bot.once('end', () => {
    clearInterval(scanTimer)
  })

  function triggerDefense (reason) {
    const now = Date.now()
    if (now - lastTriggerAt < (settings.triggerCooldownMs || 800)) return
    lastTriggerAt = now

    const threat = findLikelyMobThreat(bot, config)
    if (!threat) return
    startFight(threat, reason)
  }

  function startFight (mobEntity, reason = 'threat') {
    if (!enabled || active || !mobEntity?.isValid) return
    const adaptive = classifyEntityThreat(bot, mobEntity, config, memory)
    if (shouldEvadeThreat(bot, adaptive, config)) {
      active = true
      target = mobEntity
      fightStartedAt = Date.now()
      wasAutoplay = tasks.currentTask === 'autoplay'
      suppressResume = false
      if (tasks.currentTask) tasks.stop()
      if (settings.chatOnFight === true) speaker.autopilot?.(`Avoiding ${mobEntity.name || mobEntity.type}; it looks ranged or modded.`, true)
      const signal = { get cancelled () { return !enabled || !active } }
      evadeThreat(signal).then(() => {
        addReward(memory, 'fleeing', 2, { target: target?.name, reason: adaptive?.recommendation || reason })
        stopFight(true)
      }).catch(err => {
        console.error('[mob-defense evade]', err.message)
        stopFight(true)
      })
      return
    }
    active = true
    target = mobEntity
    fightStartedAt = Date.now()
    wasAutoplay = tasks.currentTask === 'autoplay'
    suppressResume = false

    if (tasks.currentTask) tasks.stop()
    if (settings.chatOnFight === true) speaker.autopilot?.(`Defending from ${mobEntity.name}.`, true)

    const signal = { get cancelled () { return !enabled || !active } }
    prepareMobDefenseGear(signal).then(() => {
      return fightEntitySmart(bot, memory, config, speaker, target, signal, {
      maxChaseDistance: settings.maxChaseDistance || config.behavior?.protectMaxChaseDistance || 12,
      attackRange: settings.attackRange || config.pvp?.attackRange || 3.2,
      tickMs: settings.tickMs || config.behavior?.protectTickMs || 300,
      allowHungryDefense: settings.allowHungryDefense !== false
      })
    }).then(() => {
      addReward(memory, 'fighting', 4, { target: target?.name, reason })
      stopFight(true)
    }).catch(err => {
      console.error('[mob-defense]', err.message)
      stopFight(true)
    })
  }

  async function prepareMobDefenseGear (signal) {
    await craftShieldIfPossible(bot, signal).catch(() => false)
    await equipBestShield(bot).catch(() => {})
    let weapon = await equipBestWeapon(bot).catch(() => null)
    if (!weapon || !/_(sword|axe)$/.test(weapon.name)) {
      await craftStarterWeapon(bot, signal).catch(() => {})
      weapon = await equipBestWeapon(bot).catch(() => null)
    }
    return weapon
  }

  function stopFight (mayResume) {
    const shouldResume = mayResume && wasAutoplay && !suppressResume && settings.resumeAutoplayAfterFight !== false
    active = false
    target = null
    wasAutoplay = false
    fightStartedAt = 0
    if (bot.pathfinder) bot.pathfinder.stop()
    bot.clearControlStates()

    if (shouldResume && typeof resumeAutoplay === 'function') {
      setTimeout(() => {
        if (!enabled || tasks.currentTask) return
        tasks.start('autoplay', async signal => {
          await resumeAutoplay(signal)
        }).catch(err => {
          console.error('[mob-defense resume]', err.message)
          speaker.say(`Autoplay resume failed: ${shortError(err)}`, true)
        })
      }, settings.resumeDelayMs || 900)
    }
  }

  return {
    get enabled () {
      return enabled
    },
    get active () {
      return active
    },
    get targetName () {
      return target?.name || null
    },
    start () {
      enabled = true
    },
    stop () {
      enabled = false
      suppressResume = true
      stopFight(false)
    },
    cancel () {
      suppressResume = true
      stopFight(false)
    }
  }

  function shouldAbortStaleFight () {
    if (!active) return false
    if (!target?.isValid) return true
    const maxMs = settings.maxFightMs || 25000
    if (Date.now() - fightStartedAt > maxMs) return true
    const maxDistance = (settings.maxChaseDistance || config.behavior?.protectMaxChaseDistance || 12) + 8
    return target.position.distanceTo(bot.entity.position) > maxDistance
  }

  async function evadeThreat (signal) {
    if (!target?.position || !bot?.entity) return
    const dx = bot.entity.position.x - target.position.x
    const dz = bot.entity.position.z - target.position.z
    const awayX = Math.sign(dx || 1)
    const awayZ = Math.sign(dz || 1)
    const distance = settings.evadeDistance || config.modded?.evadeDistance || 22
    const pos = bot.entity.position.offset(awayX * distance, 0, awayZ * distance)
    bot.pathfinder?.stop()
    bot.setControlState('sprint', true)
    bot.setControlState('jump', true)
    await goNear(bot, pos, 5, signal, config.behavior?.pathTimeoutMs || 5000).catch(() => {})
    bot.setControlState('jump', false)
    bot.setControlState('sprint', false)
  }
}

async function craftStarterWeapon (bot, signal) {
  const { craftItemByName, prepareWoodForCrafting, ensureCraftingTable } = require('./crafting')
  await prepareWoodForCrafting(bot, signal).catch(() => {})
  await ensureCraftingTable(bot, signal).catch(() => null)
  await craftItemByName(bot, 'wooden_axe', 1, signal).catch(() => false)
  await craftItemByName(bot, 'wooden_sword', 1, signal).catch(() => false)
}

async function craftShieldIfPossible (bot, signal) {
  if (bot.inventory.items().some(item => item.name === 'shield')) return true
  const hasIron = bot.inventory.items().some(item => item.name === 'iron_ingot')
  const plankCount = bot.inventory.items()
    .filter(item => item.name.endsWith('_planks'))
    .reduce((sum, item) => sum + item.count, 0)
  if (!hasIron || plankCount < 6) return false
  const { craftItemByName, ensureCraftingTable } = require('./crafting')
  await ensureCraftingTable(bot, signal)
  return craftItemByName(bot, 'shield', 1, signal)
}

function findLikelyMobThreat (bot, config) {
  const range = config.mobDefense?.triggerRange || 10
  const best = findAdaptiveThreat(bot, config, null, range) || findBestHostileThreat(bot, config, false, range)
  if (best) return best

  return bot.nearestEntity(entity => {
    if (!entity?.isValid || entity.type !== 'mob') return false
    if (!HOSTILE_PRIORITY.includes(entity.name)) return false
    if (entity.customName) return false
    return entity.position.distanceTo(bot.entity.position) <= range
  })
}

function findPreemptiveThreat (bot, config) {
  const range = config.mobDefense?.preemptiveRange || 6
  const skeletonRange = config.mobDefense?.skeletonPreemptiveRange || 9
  const adaptive = findAdaptiveThreat(bot, config, null, Math.max(range, skeletonRange, config.modded?.threatScanRange || 12))
  if (adaptive) return adaptive
  return bot.nearestEntity(entity => {
    if (!entity?.isValid || entity.type !== 'mob') return false
    if (!HOSTILE_PRIORITY.includes(entity.name)) return false
    if (entity.customName) return false
    const distance = entity.position.distanceTo(bot.entity.position)
    if (['skeleton', 'stray', 'witch'].includes(entity.name)) return distance <= skeletonRange
    return distance <= range
  })
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)
}

module.exports = {
  createMobDefenseController,
  findLikelyMobThreat
}

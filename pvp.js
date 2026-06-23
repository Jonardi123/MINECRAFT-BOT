const { fightEntitySmart, equipBestWeapon } = require('./combat')
const { sleep } = require('./navigation')
const { createPvpTraining } = require('./pvpTraining')

function createPvpController (bot, speaker, config, tasks) {
  let enabled = Boolean(config.pvp?.enabledByDefault)
  let active = false
  let target = null
  let targetName = null
  let primaryName = null
  let lastHealth = bot.health || 20
  let loop = null
  const recentSwings = new Map()
  const combatFeedback = {
    lastTargetHurtAt: 0,
    lastTargetHurtName: null,
    lastDamageAt: 0,
    lastDamageAttackerName: null,
    lastOpponentSwingAt: 0,
    lastOpponentSwingName: null,
    lastBotTotemPopAt: 0,
    lastTargetTotemPopAt: 0,
    lastTargetTotemPopName: null
  }
  const training = createPvpTraining(bot, config, speaker)

  bot._client?.on?.('entity_status', packet => {
    if (!enabled || !bot.entity) return
    const status = Number(packet.entityStatus ?? packet.status ?? packet.entity_status)
    if (status !== (config.pvp?.totemPopEntityStatus ?? 35)) return
    const entityId = packet.entityId
    const now = Date.now()
    if (entityId === bot.entity.id) {
      combatFeedback.lastBotTotemPopAt = now
      training.recordEvent('bot_totem_pop', { target: targetName || primaryName, health: bot.health })
      return
    }
    const entity = Object.values(bot.entities || {}).find(entity => entity?.id === entityId)
    if (!isPlayerEntity(bot, entity)) return
    const name = playerName(bot, entity)
    combatFeedback.lastTargetTotemPopAt = now
    combatFeedback.lastTargetTotemPopName = name
    if (active) training.recordEvent('target_totem_pop', { target: name })
  })

  bot.on('entitySwingArm', entity => {
    if (!enabled || !isPlayerEntity(bot, entity) || !bot.entity) return
    const range = active ? (config.pvp?.multiTargetRange || 20) : (config.pvp?.triggerRange || 5)
    if (entity.position.distanceTo(bot.entity.position) > range) return
    rememberSwingInStore(recentSwings, entity)
    if (active) {
      training.recordEvent('opponent_swing', {
        target: playerName(bot, entity),
        distance: Math.round(entity.position.distanceTo(bot.entity.position) * 10) / 10
      })
      combatFeedback.lastOpponentSwingAt = Date.now()
      combatFeedback.lastOpponentSwingName = playerName(bot, entity)
    }
  })

  bot.on('health', () => {
    const oldHealth = lastHealth
    lastHealth = bot.health
    if (!enabled || !bot.entity) return
    if (bot.health >= oldHealth || bot.health <= 0) return

    const attacker = findLikelyPlayerAttacker(bot, config, recentSwings, active)
    if (attacker) startFight(attacker)
    combatFeedback.lastDamageAt = Date.now()
    combatFeedback.lastDamageAttackerName = attacker ? playerName(bot, attacker) : null
    training.recordDamageTaken(oldHealth - bot.health, {
      attacker: attacker ? playerName(bot, attacker) : null
    })
  })

  bot.on('entityHurt', entity => {
    if (!enabled || !bot.entity) return
    if (entity && entity.id === bot.entity.id) {
      const attacker = findLikelyPlayerAttacker(bot, config, recentSwings, active)
      if (attacker) startFight(attacker)
      return
    }
    if (active && isPlayerEntity(bot, entity)) {
      combatFeedback.lastTargetHurtAt = Date.now()
      combatFeedback.lastTargetHurtName = playerName(bot, entity)
      training.recordTargetHurt(entity)
    }
  })

  bot.on('entityDead', entity => {
    if (!enabled || !active || !entity || entity.type !== 'player') return
    const name = playerName(bot, entity)
    const sameEntity = target?.id != null && entity.id === target.id
    const sameName = samePlayerName(name, targetName) || samePlayerName(name, primaryName)
    if (!sameEntity && !sameName) return
    training.recordEvent('target_defeated', { target: name })
    stopFight(`PVP ended: defeated ${name}.`)
  })

  bot.on('death', () => {
    if (!active) return
    training.recordEvent('bot_death', { target: targetName || primaryName })
    stopFight('I died in PVP. Resetting.')
  })

  bot.once('spawn', () => {
    lastHealth = bot.health || 20
    if (enabled) console.log('[pvp] Retaliation armed.')
  })

  function startFight (playerEntity) {
    if (!enabled || !playerEntity?.isValid) return
    const name = playerName(bot, playerEntity)
    if (active) {
      training.recordTargetSwitch(target, playerEntity, { reason: 'retaliation' })
      target = playerEntity
      targetName = name
      if (!primaryName) primaryName = name
      return
    }

    active = true
    target = playerEntity
    targetName = name
    primaryName = name
    tasks.stop()
    training.startFight(targetName, {
      source: 'pvp_controller',
      position: bot.entity?.position?.floored?.()
    })
    speaker.say(`PVP: fighting ${targetName}.`, true)
    loop = fightLoop().catch(err => {
      console.error('[pvp]', err)
      stopFight('PVP stopped.')
    })
  }

  async function fightLoop () {
    const duelStartedAt = Date.now()
    const maxDuelMs = config.pvp?.duelMaxFightMs || 180000
    const segmentMs = config.pvp?.duelSegmentMs || 30000
    const lostGraceMs = config.pvp?.lostTargetGraceMs || 15000
    let lostSince = null
    let lastReason = 'unknown'

    while (enabled && active && Date.now() - duelStartedAt < maxDuelMs) {
      const visibleTarget = selectBestPvpTarget(bot, config, recentSwings, target, primaryName) ||
        findPlayerByName(bot, targetName) ||
        findPlayerByName(bot, primaryName) ||
        (target?.isValid ? target : null)

      if (!visibleTarget) {
        lostSince ||= Date.now()
        if (Date.now() - lostSince > lostGraceMs) {
          stopFight(`PVP ended: lost ${primaryName || targetName || 'target'}.`)
          return
        }
        await sleep(500)
        continue
      }

      lostSince = null
      target = visibleTarget
      targetName = playerName(bot, target)
      const result = await fightEntitySmart(bot, {}, config, speaker, target, { get cancelled () { return !enabled || !active } }, {
        maxChaseDistance: config.pvp?.maxChaseDistance || 48,
        attackRange: config.pvp?.attackRange || 3.2,
        tickMs: config.pvp?.tickMs || 300,
        maxFightMs: segmentMs,
        allowHungryDefense: config.pvp?.allowHungryDefense !== false,
        forceEngage: true,
        playerFight: true,
        targetSelector: current => {
          const selected = selectBestPvpTarget(bot, config, recentSwings, current || target, primaryName)
          if (selected?.isValid) {
            if (target?.isValid && selected.id !== target.id) {
              training.recordTargetSwitch(target, selected, { reason: 'score' })
            }
            target = selected
            targetName = playerName(bot, selected)
            return selected
          }
          return current
        },
        nearbyPlayers: () => visiblePvpPlayers(bot, config, primaryName),
        opponentSwingAgeMs: entity => {
          const swing = getRecentSwing(entity, recentSwings)
          return swing ? Date.now() - swing.at : null
        },
        opponentModel: () => training.opponentModel(targetName || primaryName),
        feedback: combatFeedback,
        training
      })

      lastReason = result?.reason || 'unknown'
      if (!enabled || !active || lastReason === 'cancelled') break
      if (lastReason === 'target_defeated') {
        training.recordEvent('target_defeated', { target: targetName || primaryName })
        stopFight(`PVP ended: defeated ${targetName || primaryName || 'target'}.`)
        return
      }
      if (lastReason === 'target_lost') {
        lostSince ||= Date.now()
        await sleep(350)
        continue
      }
      if (lastReason === 'low_health') {
        await sleep(config.pvp?.lowHealthReengageDelayMs || 900)
        continue
      }
      await sleep(config.pvp?.reengageDelayMs || 250)
    }

    if (active) stopFight(lastReason === 'cancelled' ? null : `PVP timed out after ${Math.round(maxDuelMs / 1000)}s.`)
  }

  function stopFight (message) {
    const wasActive = active
    const result = wasActive
      ? training.endFight({ reason: message || 'stopped' })
      : null
    active = false
    target = null
    targetName = null
    primaryName = null
    loop = null
    if (bot.pathfinder) bot.pathfinder.stop()
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    if (message && wasActive) speaker.say(message, true)
    if (result?.chat && wasActive && config.pvp?.trainingChatSummary !== false) speaker.say(result.chat, true)
  }

  return {
    get enabled () {
      return enabled
    },
    get active () {
      return active
    },
    get targetName () {
      return targetName || (target ? playerName(bot, target) : null)
    },
    combatStyle () {
      return inferCombatStyle(bot, config)
    },
    trainingSummary () {
      return training.status()
    },
    start () {
      enabled = true
    },
    stop () {
      enabled = false
      stopFight('PVP off.')
    },
    cancel () {
      stopFight('PVP cancelled.')
    },
    forceFight (playerEntity) {
      startFight(playerEntity)
    }
  }
}

function inferCombatStyle (bot, config) {
  const items = bot.inventory?.items?.() || []
  const names = new Set(items.map(item => item.name))
  const crystals = countItems(items, 'end_crystal')
  const anchors = countItems(items, 'obsidian') + countItems(items, 'bedrock')
  const hasShield = names.has('shield') || equippedName(bot, 'off-hand') === 'shield'
  const hasBow = names.has('bow') || names.has('crossbow')
  const hasMace = names.has('mace') || equippedName(bot, 'hand') === 'mace'
  const hasElytra = names.has('elytra') || equippedName(bot, 'torso') === 'elytra'

  if ((bot.health || 20) <= (config.pvp?.lowHealth || 8)) return 'Survival'
  if (crystals > 0 && anchors > 0) return 'Crystal Specialist'
  if (hasMace && hasElytra) return 'Mace Diver'
  if (hasBow && hasShield) return 'Hybrid Duelist'
  if (hasShield) return 'Defensive Duelist'
  if (hasBow) return 'Ranged Duelist'
  return 'Aggressive Duelist'
}

function equippedName (bot, slot) {
  if (!bot?.inventory) return null
  if (slot === 'hand') return bot.heldItem?.name || null
  try {
    return bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name || null
  } catch {
    return null
  }
}

function countItems (items, name) {
  return items
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}

function findPlayerByName (bot, name) {
  if (!name) return null
  const direct = bot.players[name]?.entity
  if (direct?.isValid) return direct
  const lower = name.toLowerCase()
  const match = Object.entries(bot.players || {}).find(([username, player]) => {
    return username.toLowerCase() === lower && player.entity?.isValid
  })
  return match?.[1]?.entity || null
}

function findLikelyPlayerAttacker (bot, config, recentSwings, active = false) {
  const range = active ? (config.pvp?.multiTargetRange || 20) : (config.pvp?.triggerRange || 5)
  cleanupRecentSwings(recentSwings, config)
  const swings = [...recentSwings.values()]
    .filter(swing => swing.entity?.isValid)
    .filter(swing => Date.now() - swing.at <= (config.pvp?.swingMemoryMs || 1500))
    .filter(swing => swing.entity.position.distanceTo(bot.entity.position) <= range)
    .sort((a, b) => b.at - a.at)
  if (swings[0]) return swings[0].entity

  return bot.nearestEntity(entity => {
    if (!isPlayerEntity(bot, entity)) return false
    return entity.position.distanceTo(bot.entity.position) <= range
  })
}

function visiblePvpPlayers (bot, config, primaryName = null) {
  if (!bot.entity) return []
  const range = config.pvp?.multiTargetRange || 20
  const primary = String(primaryName || '').toLowerCase()
  return Object.values(bot.entities || {})
    .filter(entity => isPlayerEntity(bot, entity))
    .filter(entity => {
      const name = playerName(bot, entity).toLowerCase()
      return entity.position.distanceTo(bot.entity.position) <= range || (primary && name === primary)
    })
}

function selectBestPvpTarget (bot, config, recentSwings, current = null, primaryName = null) {
  cleanupRecentSwings(recentSwings, config)
  const players = visiblePvpPlayers(bot, config, primaryName)
  if (!players.length) return null

  const scored = players.map(entity => ({
    entity,
    score: pvpTargetScore(bot, config, recentSwings, entity, current, primaryName, players)
  })).sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best) return null
  const currentScore = current?.isValid
    ? pvpTargetScore(bot, config, recentSwings, current, current, primaryName, players)
    : -Infinity
  if (
    current?.isValid &&
    best.entity.id !== current.id &&
    best.score < currentScore + (config.pvp?.targetSwitchMargin || 8)
  ) {
    return current
  }
  return best.entity
}

function pvpTargetScore (bot, config, recentSwings, entity, current, primaryName, players) {
  const distance = entity.position.distanceTo(bot.entity.position)
  const range = config.pvp?.multiTargetRange || 20
  const swing = getRecentSwing(entity, recentSwings)
  const swingAge = swing ? Date.now() - swing.at : Infinity
  const name = playerName(bot, entity)
  const health = readPlayerHealth(bot, entity, name)
  const clusterRadius = config.pvp?.targetClusterRadius || 4.2
  const clustered = players.filter(other => other.id !== entity.id && other.position.distanceTo(entity.position) <= clusterRadius).length
  const gear = readVisiblePlayerGear(entity)
  const verticalGap = entity.position.y - bot.entity.position.y
  const targetLow = Number.isFinite(health) && health <= (config.pvp?.finishHealth || 7)
  const outnumbered = players.length >= (config.pvp?.teamRetreatCount || 2)

  let score = Math.max(0, range - distance) * (config.pvp?.distanceTargetWeight || 1.8)
  if (entity.id === current?.id) score += config.pvp?.currentTargetBonus || 12
  if (primaryName && name.toLowerCase() === String(primaryName).toLowerCase()) score += config.pvp?.primaryTargetBonus || 4
  if (swingAge <= 650) score += config.pvp?.recentSwingBonus || 30
  else if (swingAge <= (config.pvp?.swingMemoryMs || 1500)) score += (config.pvp?.recentSwingBonus || 30) * 0.45
  if (Number.isFinite(health)) score += Math.max(0, 20 - health) * (config.pvp?.lowHealthTargetWeight || 1.2)
  if (targetLow) score += config.pvp?.finishTargetBonus || 28
  if (targetLow && outnumbered) score += config.pvp?.outnumberedWeakTargetBonus || 18
  if (gear.crystalReady && distance <= (config.pvp?.crystalReadyTargetRange || 6.2)) score += config.pvp?.crystalReadyTargetBonus || 12
  if (gear.weaponType === 'bow' || gear.weaponType === 'crossbow') score += config.pvp?.rangedTargetBonus || 6
  if (gear.weaponType === 'mace' && verticalGap > 1.2 && distance <= 6) score += config.pvp?.maceDiveTargetBonus || 16
  if (verticalGap >= (config.pvp?.highGroundVerticalGap || 2.6) && !targetLow) score -= config.pvp?.highGroundTargetPenalty || 8
  if (distance > range * 0.75 && !targetLow) score -= config.pvp?.farTargetPenalty || 10
  score += clustered * (config.pvp?.targetClusterBonus || 18)
  return score
}

function rememberSwingInStore (recentSwings, entity) {
  const record = { entity, at: Date.now(), name: entity.username || entity.name || null }
  for (const key of recentKeyCandidates(entity)) recentSwings.set(key, record)
}

function getRecentSwing (entity, recentSwings) {
  if (entity?.id != null && recentSwings.has(entity.id)) return recentSwings.get(entity.id)
  const name = entity?.username || entity?.name
  if (name && recentSwings.has(name.toLowerCase())) return recentSwings.get(name.toLowerCase())
  return null
}

function cleanupRecentSwings (recentSwings, config) {
  const ttl = Math.max(config.pvp?.swingMemoryMs || 1500, config.pvp?.multiTargetMemoryMs || 4500)
  const now = Date.now()
  for (const [key, swing] of recentSwings.entries()) {
    if (!swing?.entity?.isValid || now - swing.at > ttl) recentSwings.delete(key)
  }
}

function recentKeyCandidates (entity) {
  return [
    entity?.id,
    entity?.username ? entity.username.toLowerCase() : null,
    entity?.name ? String(entity.name).toLowerCase() : null
  ].filter(key => key != null)
}

function readPlayerHealth (bot, entity, name) {
  if (Number.isFinite(entity.health)) return entity.health
  const player = bot.players?.[name]
  if (Number.isFinite(player?.health)) return player.health
  return null
}

function isPlayerEntity (bot, entity) {
  if (!entity || !entity.isValid) return false
  if (entity.type !== 'player') return false
  if (entity.username === bot.username) return false
  return true
}

function playerName (bot, entity) {
  if (entity.username) return entity.username
  const match = Object.entries(bot.players || {}).find(([, player]) => player.entity?.id === entity.id)
  return match?.[0] || 'attacker'
}

function samePlayerName (a, b) {
  if (!a || !b) return false
  return String(a).toLowerCase() === String(b).toLowerCase()
}

function readVisiblePlayerGear (entity) {
  const equipment = Object.values(entity.equipment || {}).filter(Boolean)
  const candidates = [entity.heldItem, ...equipment].filter(Boolean)
  const visibleItems = candidates.map(item => item?.name).filter(Boolean)
  const weapon = candidates.find(item => item?.name && weaponType(item.name)) || null
  return {
    weapon,
    weaponType: weapon ? weaponType(weapon.name) : null,
    shield: visibleItems.includes('shield'),
    crystalReady: visibleItems.includes('end_crystal') || visibleItems.includes('obsidian')
  }
}

function weaponType (name) {
  if (name === 'mace') return 'mace'
  if (name === 'trident') return 'trident'
  if (name === 'bow') return 'bow'
  if (name === 'crossbow') return 'crossbow'
  return ['axe', 'sword', 'pickaxe', 'shovel'].find(type => name.endsWith(`_${type}`)) || null
}

module.exports = {
  createPvpController,
  equipBestWeapon
}

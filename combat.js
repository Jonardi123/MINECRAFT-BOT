const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { sleep, goNear, recoverFromStuck } = require('./navigation')
const { equipBestArmor, armorScore } = require('./equipment')
const { listAdaptiveThreats, shouldEvadeThreat, classifyEntityThreat } = require('./modThreat')
const { dangerousBlockNear } = require('./safety')

const WEAPON_TYPES = ['mace', 'axe', 'sword', 'trident', 'bow', 'crossbow', 'pickaxe', 'shovel']
const BUILD_UP_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'grass_block', 'oak_planks', 'spruce_planks',
  'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'netherrack'
]
const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow']
const PROJECTILE_DODGE_NAMES = new Set([
  'arrow',
  'spectral_arrow',
  'tipped_arrow',
  'trident',
  'fireball',
  'small_fireball',
  'dragon_fireball',
  'wither_skull',
  'shulker_bullet',
  'llama_spit',
  'snowball',
  'egg',
  'ender_pearl'
])

const HOSTILE_PRIORITY = [
  'creeper',
  'skeleton',
  'stray',
  'witch',
  'zombie',
  'zombie_villager',
  'husk',
  'drowned',
  'spider',
  'cave_spider'
]

const FOOD_NAMES = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
  'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton', 'potato',
  'rotten_flesh', 'spider_eye', 'mushroom_stew', 'sweet_berries'
])

async function fightEntitySmart (bot, memory, config, speaker, target, signal, options = {}) {
  if (!target?.isValid) throw new Error('target not visible')

  const playerFight = options.playerFight || target.type === 'player'
  await equipBestArmor(bot, memory, config, speaker, signal).catch(() => {})
  await equipBestWeapon(bot).catch(() => {})
  if (playerFight && shouldStartFightWithTotem(bot, target, config)) {
    await equipBestTotem(bot).catch(() => null)
  } else {
    await equipBestShield(bot).catch(() => {})
  }

  const start = bot.entity.position.clone()
  const maxChase = options.maxChaseDistance || config.pvp?.maxChaseDistance || 24
  const attackRange = options.attackRange || config.pvp?.attackRange || 3.2
  const tickMs = options.tickMs || config.pvp?.tickMs || 300
  const allowHungryDefense = Boolean(options.allowHungryDefense)
  const spacing = combatSpacing(config, attackRange, playerFight)
  const endAt = Date.now() + (options.maxFightMs || config.pvp?.maxFightMs || (playerFight ? 90000 : 45000))
  const arenaCenter = playerFight && config.pvp?.arenaLock !== false
    ? resolveArenaCenter(options, config, start)
    : null
  const arenaRadius = options.arenaRadius || config.pvp?.arenaRadius || 18
  const arenaMargin = config.pvp?.arenaLeashMargin || 2
  const movement = createMovementState(config)
  const combo = createComboState()
  const enemyMotion = createEnemyMotionState()
  let lastAttackAt = 0
  let lastBowAt = 0
  let lastBuildAt = 0
  let lastCrystalAt = 0
  let lastLooseCrystalId = null
  let lastLooseCrystalRecordAt = 0
  let crystalFailStreak = 0
  let crystalBlockedUntil = 0
  let lastElytraMaceAt = 0
  let lastCombatPearlAt = 0
  let lastGoldenAppleAt = 0
  let lastWeaponCheckAt = 0
  let lastOffhandCheckAt = 0
  let lastHandCheckAt = 0
  let lastMaceDangerEvadeAt = 0
  let lastTacticalResetAt = 0
  let lastShieldBaitAt = 0
  let lastCombatUnstickAt = 0
  let lastAntiComboAt = 0
  let lastProjectileDodgeAt = 0
  let lastPreShotDodgeAt = 0
  let lastHitConfirmRecordAt = 0
  let lastArenaCutoffRecordAt = 0
  let lastAntiBaitRecordAt = 0
  let lastPredictiveAimRecordAt = 0
  let lastCombatDecisionSignature = null
  let lastCombatDecisionRecordAt = 0
  let lastTacticName = null
  let lastMovementSignature = null
  let lastTargetDistance = null
  let lastHealth = bot.health || 20
  let lastDamageAt = 0
  const damageWindow = []
  const fallRecovery = createFallRecoveryState()
  let shieldRaised = false
  let shieldRaisedAt = 0
  let lastPosition = bot.entity.position.clone()
  let lastMovedAt = Date.now()
  let endReason = 'unknown'

  while (!signal?.cancelled && Date.now() < endAt) {
    if (typeof options.targetSelector === 'function') {
      const selected = options.targetSelector(target)
      if (selected?.isValid) target = selected
    }
    if (!target?.isValid) {
      endReason = 'target_lost'
      break
    }
    if (playerFight && targetDefeated(bot, target, config)) {
      endReason = 'target_defeated'
      break
    }

    const adaptive = classifyEntityThreat(bot, target, config, memory)
    if (!options.forceEngage && shouldEvadeThreat(bot, adaptive, config)) {
      speaker?.autopilot?.(`Threat ${target.name || target.type} looks ranged/modded; taking cover.`, true)
      await kiteAway(bot, target, config, signal).catch(() => {})
      endReason = 'evaded'
      break
    }

    const distanceFromStart = bot.entity.position.distanceTo(start)
    if (distanceFromStart > maxChase) {
      endReason = 'max_chase'
      break
    }

    if (bot.health <= retreatHealth(config, bot)) {
      const ate = await eatIfSafe(bot, target).catch(() => false)
      if (ate) {
        recordTraining(options, 'eat', { reason: 'retreat_health', health: bot.health })
        continue
      }
      await kiteAway(bot, target, config, signal).catch(() => {})
      endReason = 'low_health'
      break
    }

    if (bot.food <= 6 && !allowHungryDefense) {
      speaker?.say?.('Too hungry to fight well.')
      endReason = 'hungry'
      break
    }

    if (!playerFight && bot.health <= (config.pvp?.eatHealth || 10)) {
      const ate = await eatIfSafe(bot, target).catch(() => false)
      if (ate) {
        recordTraining(options, 'eat', { reason: 'low_health', health: bot.health })
        continue
      }
    }

    const nearbyHostiles = countNearbyHostiles(bot, 5, config, memory)
    if (target.type !== 'player' && target.name !== 'creeper' && !hasStoneOrBetterWeapon(bot)) {
      await kiteAway(bot, target, config, signal).catch(() => {})
      endReason = 'undergeared'
      break
    }
    if (nearbyHostiles >= 4 && target.type !== 'player') {
      await kiteAway(bot, target, config, signal).catch(() => {})
      endReason = 'outnumbered'
      break
    }

    const distance = bot.entity.position.distanceTo(target.position)
    const now = Date.now()
    const verticalGap = target.position.y - bot.entity.position.y
    const opponentSwingAgeMs = typeof options.opponentSwingAgeMs === 'function' ? options.opponentSwingAgeMs(target) : null
    const enemyGear = readTargetGear(target)
    const maceDiveDanger = isMaceDiveDanger(target, enemyGear, distance, verticalGap, config)
    const hasCrystalKit = playerFight && config.pvp?.crystalsEnabled !== false && hasCrystalLoadout(bot)
    if ((bot.health || 0) < lastHealth - 0.05) {
      const damage = Math.max(0, lastHealth - (bot.health || 0))
      lastDamageAt = now
      damageWindow.push({ at: now, amount: damage })
    }
    pruneDamageWindow(damageWindow, now, config)
    lastHealth = bot.health || lastHealth
    const recentlyDamaged = now - lastDamageAt <= (config.pvp?.recentDamageMs || 1400)
    const nearbyPlayers = playerFight ? nearbyPlayerTargets(options, target) : []
    const distanceTrend = distanceTrendFrom(lastTargetDistance, distance)
    const targetShielding = targetLikelyShielding(target)
    const attackReady = now - lastAttackAt >= attackCooldownMs(bot.heldItem, config) - combatLatencyAttackLeadMs(bot, config)
    const opponentModel = typeof options.opponentModel === 'function'
      ? options.opponentModel()
      : options.opponentModel || null
    const enemyMotionState = playerFight
      ? updateEnemyMotionState(enemyMotion, bot, target, now, distance, config)
      : null
    const hitConfirmAgeMs = options.feedback?.lastTargetHurtAt
      ? now - options.feedback.lastTargetHurtAt
      : Infinity
    const hitConfirmed = hitConfirmAgeMs >= 0 && hitConfirmAgeMs <= (config.pvp?.hitConfirmPressureMs || 900)
    const comboState = updateComboState(combo, bot, target, now, distance, options.feedback, config, options)
    const situation = playerFight
      ? assessPvpSituation(bot, target, config, {
          distance,
          verticalGap,
          enemyGear,
          targetShielding,
          nearbyPlayers,
          baseSpacing: spacing,
          opponentSwingAgeMs,
          attackReady,
          recentlyDamaged,
          damageWindow,
          distanceTrend,
          hasCrystalKit,
          opponentModel,
          enemyMotion: enemyMotionState,
          hitConfirmed,
          hitConfirmAgeMs,
          combo: comboState,
          feedback: options.feedback
        })
      : { name: 'mob', spacing, playerFight: false }
    if (playerFight && situation.predictiveAim && now - lastPredictiveAimRecordAt > (config.pvp?.predictiveAimRecordCooldownMs || 1200)) {
      recordTraining(options, 'predictive_aim', {
        target: targetLabel(target),
        leadTicks: roundMetric(situation.aimLeadTicks || 0, 1),
        comboChain: situation.comboChain || 0,
        distance: roundMetric(distance, 2)
      })
      lastPredictiveAimRecordAt = now
    }
    if (playerFight && hitConfirmed && now - lastHitConfirmRecordAt > (config.pvp?.hitConfirmRecordCooldownMs || 650)) {
      recordTraining(options, 'hit_confirm_pressure', {
        target: targetLabel(target),
        distance: roundMetric(distance, 2),
        ageMs: roundMetric(hitConfirmAgeMs, 0)
      })
      lastHitConfirmRecordAt = now
    }
    const activeSpacing = situation.spacing || spacing
    situation.spacingState = spacingState(distance, activeSpacing, config)
    if (playerFight) {
      situation.tempo = assessCombatTempo(bot, target, distance, activeSpacing, situation, config, now, {
        lastAttackAt,
        lastDamageAt,
        attackReady,
        hitConfirmAgeMs,
        feedback: options.feedback,
        targetShielding
      })
    }
    const antiBaitHold = playerFight && shouldHoldAntiBait(situation, distance, attackReady, config, bot)
    situation.antiBaitHold = antiBaitHold
    if (antiBaitHold && now - lastAntiBaitRecordAt > (config.pvp?.antiBaitRecordCooldownMs || 800)) {
      recordTraining(options, 'anti_bait_hold', {
        target: targetLabel(target),
        tactic: situation.name,
        distance: roundMetric(distance, 2),
        reason: antiBaitReason(situation, distance, config)
      })
      lastAntiBaitRecordAt = now
    }
    if (playerFight) {
      const decision = decideCombatAction(bot, target, situation, distance, activeSpacing, attackReady, config, {
        recentlyDamaged,
        adaptive,
        enemyGear,
        hasCrystalKit,
        verticalGap,
        nearbyHostiles,
        lastGoldenAppleAt
      })
      situation.combatDecision = decision
      const decisionSignature = combatDecisionSignature(decision, situation)
      if (shouldRecordCombatDecision(decisionSignature, now, lastCombatDecisionSignature, lastCombatDecisionRecordAt, config)) {
        recordTraining(options, 'combat_decision', {
          action: decision.action,
          reason: decision.reason,
          tactic: situation.name,
          spacing: situation.spacingState?.label || null,
          distance: roundMetric(distance, 2),
          health: roundMetric(bot.health || 0, 2),
          targetHealth: situation.targetHealth,
          comboChain: situation.comboChain || 0,
          enemyPattern: situation.enemyMovementPattern || null
        })
        lastCombatDecisionSignature = decisionSignature
        lastCombatDecisionRecordAt = now
      }
    }
    updateMovementState(movement, situation, distance, now, config)
    if (playerFight && movementSignature(movement) !== lastMovementSignature) {
      lastMovementSignature = movementSignature(movement)
      recordTraining(options, 'movement_mode', {
        mode: movement.mode,
        strafe: movement.strafe,
        tactic: situation.name,
        distance: roundMetric(distance, 2)
      })
    }
    const strafe = movement.strafe
    const preferAxe = playerFight && shouldPreferAxe(bot, target, distance, targetShielding, attackReady, situation, config)
    if (playerFight && situation.name !== lastTacticName) {
      recordTraining(options, 'tactic_shift', {
        from: lastTacticName,
        to: situation.name,
        distance: roundMetric(distance, 2),
        health: roundMetric(bot.health || 0, 2),
        targetHealth: situation.targetHealth
      })
      lastTacticName = situation.name
    }
    lastTargetDistance = distance
    if (arenaCenter) {
      const botArenaDistance = horizontalDistance(bot.entity.position, arenaCenter)
      const targetArenaDistance = horizontalDistance(target.position, arenaCenter)
      const arenaEdgePressure = shouldPressureAtArenaEdge(
        botArenaDistance,
        targetArenaDistance,
        distance,
        activeSpacing,
        arenaRadius,
        arenaMargin,
        config,
        options
      )
      if (botArenaDistance > arenaRadius && !arenaEdgePressure) {
        lowerShield(bot)
        shieldRaised = false
        clearCombatControls(bot)
        recordTraining(options, 'arena_return', { distance: roundMetric(botArenaDistance, 2) })
        await nudgeTowardArenaCenter(bot, arenaCenter, target, config).catch(() => {})
        lastMovedAt = Date.now()
        continue
      }
      if (targetArenaDistance > arenaRadius + arenaMargin && distance > activeSpacing.hit && !arenaEdgePressure) {
        bot.pathfinder?.stop()
        applyStrafe(bot, strafe)
        await bot.lookAt(target.position.offset(0, target.height || 1.5, 0), true).catch(() => {})
        await sleep(tickMs)
        continue
      }
      if (arenaEdgePressure) {
        situation.arenaEdgePressure = true
        situation.arenaCenter = arenaCenter
        situation.arenaRadius = arenaRadius
        if (
          config.pvp?.arenaCutoffEnabled !== false &&
          distance > activeSpacing.hit &&
          now - lastArenaCutoffRecordAt > (config.pvp?.arenaCutoffRecordCooldownMs || 1000)
        ) {
          recordTraining(options, 'arena_cutoff', {
            botArenaDistance: roundMetric(botArenaDistance, 2),
            targetArenaDistance: roundMetric(targetArenaDistance, 2),
            distance: roundMetric(distance, 2)
          })
          lastArenaCutoffRecordAt = now
        }
        recordTraining(options, 'arena_edge_pressure', {
          botArenaDistance: roundMetric(botArenaDistance, 2),
          targetArenaDistance: roundMetric(targetArenaDistance, 2),
          distance: roundMetric(distance, 2)
        })
      }
    }
    const fallThreat = fallThreatProfile(bot, config)
    if (fallThreat && shouldRunFallRecovery(fallThreat, fallRecovery, now, config)) {
      const recovered = await emergencyFallRecover(bot, target, config, signal, fallRecovery, options.training).catch(() => ({ attempted: false }))
      if (recovered?.attempted) {
        lastMovedAt = Date.now()
        continue
      }
    }

    if (dangerousCombatFooting(bot)) {
      await kiteAway(bot, target, config, signal).catch(() => {})
      break
    }

    const projectileThreat = playerFight ? findIncomingProjectile(bot, target, config) : null
    if (projectileThreat && now - lastProjectileDodgeAt > (config.pvp?.projectileDodgeCooldownMs || 450)) {
      await projectileDodge(bot, target, projectileThreat, movement, config).catch(() => {})
      lastProjectileDodgeAt = Date.now()
      recordTraining(options, 'projectile_dodge', {
        target: targetLabel(target),
        projectile: projectileThreat.projectile?.name || projectileThreat.projectile?.displayName || 'projectile',
        distance: roundMetric(projectileThreat.distance, 2),
        impactMs: roundMetric(projectileThreat.impactMs, 0),
        pass: roundMetric(projectileThreat.closePass, 2)
      })
      continue
    }

    if (playerFight && shouldPreemptiveProjectileJuke(bot, target, enemyGear, distance, now, lastPreShotDodgeAt, attackReady, activeSpacing, config)) {
      await preemptiveProjectileJuke(bot, target, movement, config).catch(() => {})
      lastPreShotDodgeAt = Date.now()
      recordTraining(options, 'projectile_pre_dodge', {
        target: targetLabel(target),
        weapon: enemyGear.weaponType,
        distance: roundMetric(distance, 2)
      })
      continue
    }

    if (playerFight && shouldAntiComboCounterAttack(bot, target, situation, distance, activeSpacing, attackReady, config)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
        recordTraining(options, 'shield_lower', { reason: 'anti_combo_counter' })
        await sleep(config.pvp?.antiComboCounterShieldDropMs || 35)
      }
      await equipBestCombatWeapon(bot, target, {
        preferAxe,
        preferMace: situation.finish && situation.targetHigh,
        playerFight,
        normalDuel: situation.normalDuel
      }).catch(() => {})
      await combatLookAt(bot, target, config, situation, { attack: true }).catch(() => {})
      bot.setControlState('sprint', true)
      bot.attack(target)
      recordMeleeAttack(options, combo, target, distance, bot.heldItem, targetShielding, situation, { priority: true, comboCounter: true })
      lastAttackAt = Date.now()
      lastAntiComboAt = Date.now()
      await sprintReset(bot, target, { comboPressure: true, config, situation }).catch(() => {})
      continue
    }

    if (playerFight && shouldAntiComboReset(situation, distance, now, lastAntiComboAt, config)) {
      await antiComboReset(bot, target, strafe, config, situation, distance).catch(() => {})
      lastAntiComboAt = Date.now()
      recordTraining(options, 'anti_combo_reset', {
        target: targetLabel(target),
        damage: roundMetric(situation.comboDamage || 0, 2),
        hits: situation.comboHits || 0,
        distance: roundMetric(distance, 2)
      })
      continue
    }

    const moved = bot.entity.position.distanceTo(lastPosition)
    if (moved > 0.25) {
      lastPosition = bot.entity.position.clone()
      lastMovedAt = now
    } else if (distance > activeSpacing.max && now - lastMovedAt > (config.pvp?.stuckRecoverMs || 5000)) {
      recordTraining(options, 'stuck_recovery', { distance: roundMetric(distance, 2), target: targetLabel(target) })
      await recoverFromStuck(bot, signal, { jump: false, backMs: 450 }).catch(() => {})
      lastMovedAt = now
    } else if (
      playerFight &&
      now - lastMovedAt > (config.pvp?.combatStuckMs || 1700) &&
      now - lastCombatUnstickAt > (config.pvp?.combatUnstickCooldownMs || 1200) &&
      (recentlyDamaged || situation.pressure || distance <= activeSpacing.max + 0.8)
    ) {
      recordTraining(options, 'stuck_recovery', { distance: roundMetric(distance, 2), target: targetLabel(target), combat: true })
      await combatUnstick(bot, target, config).catch(() => {})
      lastCombatUnstickAt = Date.now()
      lastMovedAt = Date.now()
    }

    if (playerFight && shouldBuildUpToTarget(bot, target, verticalGap, distance, config, arenaCenter, arenaRadius) && now - lastBuildAt > (config.pvp?.buildUpCooldownMs || 1300)) {
      recordTraining(options, 'build_up', { target: targetLabel(target), verticalGap: roundMetric(verticalGap, 2), distance: roundMetric(distance, 2) })
      await buildUpTowardTarget(bot, target, signal, arenaCenter, arenaRadius, config).catch(() => {})
      lastBuildAt = now
      continue
    }

    if (now - lastWeaponCheckAt > 550) {
      await equipBestCombatWeapon(bot, target, {
        preferAxe,
        preferMace: situation.finish && situation.targetHigh,
        playerFight,
        normalDuel: situation.normalDuel
      }).catch(() => {})
      lastWeaponCheckAt = now
    }
    if (now - lastHandCheckAt > (config.pvp?.combatHandCheckMs || 250) && shouldForceCombatHand(bot, distance, activeSpacing)) {
      await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
      lastHandCheckAt = now
    }
    if (shouldTacticalReset(situation, distance, attackReady, now, lastTacticalResetAt, config)) {
      await tacticalReset(bot, target, config, situation).catch(() => {})
      lastTacticalResetAt = Date.now()
      recordTraining(options, 'tactical_reset', { tactic: situation.name, target: targetLabel(target), distance: roundMetric(distance, 2) })
      continue
    }
    if (!situation.comboMomentum && shouldBreakCloseClump(target, distance, attackReady, activeSpacing, config)) {
      await closeRangeReset(bot, target, config).catch(() => {})
      recordTraining(options, 'close_reset', { target: targetLabel(target), distance: roundMetric(distance, 2) })
      continue
    }
    if (shouldBaitShield(situation, distance, attackReady, now, lastShieldBaitAt, config)) {
      await baitShield(bot, target, config).catch(() => {})
      lastShieldBaitAt = Date.now()
      recordTraining(options, 'shield_bait', { target: targetLabel(target), distance: roundMetric(distance, 2) })
      continue
    }
    if (target.name === 'creeper' && (bot.food <= 8 || bot.health <= 10)) {
      await kiteAway(bot, target, config, signal).catch(() => {})
      endReason = 'creeper_safety'
      break
    }
    if (maceDiveDanger && now - lastMaceDangerEvadeAt > (config.pvp?.maceDangerEvadeCooldownMs || 900) && !attackReady) {
      await evadeMaceDive(bot, target, config).catch(() => {})
      lastMaceDangerEvadeAt = Date.now()
      recordTraining(options, 'mace_danger_evade', { target: targetLabel(target), verticalGap: roundMetric(verticalGap, 2), distance: roundMetric(distance, 2) })
      continue
    }
    if (hasCrystalKit && now - lastCrystalAt >= (config.pvp?.crystalLooseDetonateCooldownMs || 120)) {
      const looseCrystalId = await detonateNearbyCrystal(bot, target, config, nearbyPlayers, null, options.training, 'loose').catch(() => false)
      if (looseCrystalId) {
        if (looseCrystalId !== lastLooseCrystalId || now - lastLooseCrystalRecordAt > (config.pvp?.crystalLooseRecordCooldownMs || 750)) {
          recordTraining(options, 'crystal_success', { target: targetLabel(target), distance: roundMetric(distance, 2), loose: true })
          lastLooseCrystalId = looseCrystalId
          lastLooseCrystalRecordAt = now
        }
        await sleep(config.pvp?.crystalLooseDetonateCooldownMs || 120)
        await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
        lastCrystalAt = Date.now()
        continue
      }
    }
    if (playerFight && shouldUseAxePressure(bot, target, distance, targetShielding, attackReady, situation, config, now, lastAttackAt)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
        recordTraining(options, 'shield_lower', { reason: 'axe_pressure' })
        await sleep(config.pvp?.axeShieldDropMs || 55)
      }
      await equipBestCombatWeapon(bot, target, { preferAxe: true, playerFight, normalDuel: situation.normalDuel }).catch(() => {})
      await combatLookAt(bot, target, config, situation, { attack: true }).catch(() => {})
      bot.setControlState('sprint', true)
      bot.attack(target)
      recordMeleeAttack(options, combo, target, distance, bot.heldItem, targetShielding, situation, { axePressure: true })
      lastAttackAt = Date.now()
      if (playerFight) await sprintReset(bot, target, { axePressure: true, comboPressure: situation.comboMomentum, config, situation }).catch(() => {})
      continue
    }
    const shouldTotem = await shouldUseTotem(bot, target, distance, config, recentlyDamaged, verticalGap, situation)
    if (now - lastOffhandCheckAt > (config.pvp?.offhandCheckMs || 350)) {
      await maintainCombatOffhand(bot, target, distance, config, shouldTotem, recentlyDamaged, situation).catch(() => {})
      lastOffhandCheckAt = now
    }
    if (shouldTotem) {
      lowerShield(bot)
      shieldRaised = false
      shieldRaisedAt = 0
      const totem = await equipBestTotem(bot).catch(() => null)
      recordTraining(options, totem ? 'totem_equip' : 'totem_missing', { health: bot.health, distance: roundMetric(distance, 2) })
    }
    if (playerFight && shouldUseGoldenApple(bot, target, distance, config, now, lastGoldenAppleAt, attackReady, activeSpacing, recentlyDamaged, situation)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
      }
      const ate = await eatGoldenAppleInCombat(bot, target, config, signal).catch(() => false)
      lastGoldenAppleAt = Date.now()
      if (ate) {
        recordTraining(options, 'golden_apple', { health: roundMetric(bot.health, 2), distance: roundMetric(distance, 2) })
        await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
        continue
      }
    } else if (playerFight && shouldTempoMelee(bot, target, distance, activeSpacing, situation, config, attackReady, now, lastAttackAt, targetShielding)) {
      const tempoReason = tempoMeleeReason(situation, config)
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
        recordTraining(options, 'shield_lower', { reason: 'tempo_attack' })
        await sleep(config.pvp?.tempoShieldDropMs ?? 30)
      }
      await equipBestCombatWeapon(bot, target, {
        preferAxe,
        preferMace: situation.finish && situation.targetHigh,
        playerFight,
        normalDuel: situation.normalDuel
      }).catch(() => {})
      await combatLookAt(bot, target, config, situation, { attack: true }).catch(() => {})
      bot.setControlState('sprint', true)
      bot.attack(target)
      recordTraining(options, 'tempo_attack', {
        target: targetLabel(target),
        reason: tempoReason,
        distance: roundMetric(distance, 2),
        cooldownAge: roundMetric(situation.tempo?.sinceAttack || 0, 0),
        targetTotemPopped: Boolean(situation.targetTotemPopped),
        goodEnough: Boolean(situation.tempo?.goodEnough)
      })
      recordMeleeAttack(options, combo, target, distance, bot.heldItem, targetShielding, situation, {
        tempoAttack: true,
        tempoReason,
        goodEnough: Boolean(situation.tempo?.goodEnough)
      })
      lastAttackAt = Date.now()
      await sprintReset(bot, target, { comboPressure: situation.comboMomentum || situation.targetTotemPopped, config, situation }).catch(() => {})
      continue
    } else if (playerFight && shouldUseCombatPearl(bot, target, distance, config, now, lastCombatPearlAt, situation, arenaCenter, arenaRadius)) {
      const pearlReason = shouldUseCombatPearl(bot, target, distance, config, now, lastCombatPearlAt, situation, arenaCenter, arenaRadius)
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
        recordTraining(options, 'shield_lower', { reason: 'combat_pearl' })
        await sleep(config.pvp?.combatPearlShieldDropMs ?? 30)
      }
      const pearled = await throwCombatEnderPearl(bot, target, config, situation, arenaCenter, arenaRadius).catch(() => false)
      lastCombatPearlAt = Date.now()
      if (pearled) {
        recordTraining(options, 'combat_pearl', {
          target: targetLabel(target),
          reason: pearlReason,
          distance: roundMetric(distance, 2),
          targetHealth: situation.targetHealth,
          bossPhase: situation.bossPhase || null
        })
        await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
        continue
      }
    } else if (shouldPrioritizeMelee(target, distance, bot, adaptive, attackReady, activeSpacing, situation, config)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
        recordTraining(options, 'shield_lower', { reason: 'melee_priority' })
        await sleep(55)
      }
      await equipBestCombatWeapon(bot, target, {
        preferAxe,
        preferMace: situation.finish && situation.targetHigh,
        playerFight,
        normalDuel: situation.normalDuel
      }).catch(() => {})
      await combatLookAt(bot, target, config, situation, { attack: true }).catch(() => {})
      bot.setControlState('sprint', true)
      if (canCritical(bot, target, playerFight, targetShielding)) {
        bot.setControlState('jump', true)
        await sleep(120)
        bot.setControlState('jump', false)
      }
      bot.attack(target)
      recordMeleeAttack(options, combo, target, distance, bot.heldItem, targetShielding, situation, { priority: true })
      lastAttackAt = Date.now()
      if (playerFight) await sprintReset(bot, target, { comboPressure: situation.comboMomentum, config, situation }).catch(() => {})
      continue
    } else if (playerFight && shouldUseElytraMace(bot, target, distance, verticalGap, config, now, lastElytraMaceAt, arenaCenter, arenaRadius, situation)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
      }
      const attacked = await elytraMaceChain(bot, target, config, signal, arenaCenter, arenaRadius, options.training, options).catch(() => false)
      lastElytraMaceAt = Date.now()
      if (attacked) {
        lastAttackAt = Date.now()
        continue
      }
      await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
    } else if (playerFight && shouldUseCrystal(bot, target, distance, config, now, lastCrystalAt, attackReady, activeSpacing, targetShielding, crystalBlockedUntil, situation)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
      }
      recordTraining(options, 'crystal_attempt', { target: targetLabel(target), distance: roundMetric(distance, 2) })
      const usedCrystal = await crystalBurst(
        bot,
        target,
        config,
        signal,
        nearbyPlayers,
        Date.now() + (config.pvp?.crystalAttemptTimeoutMs || 850),
        options.training
      ).catch(() => false)
      await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
      if (usedCrystal) {
        recordTraining(options, 'crystal_success', { target: targetLabel(target), distance: roundMetric(distance, 2) })
        crystalFailStreak = 0
        lastCrystalAt = Date.now()
        continue
      }
      recordTraining(options, 'crystal_failed', { target: targetLabel(target), distance: roundMetric(distance, 2) })
      crystalFailStreak += 1
      if (crystalFailStreak >= (config.pvp?.crystalFailedAttemptLimit || 2)) {
        crystalBlockedUntil = Date.now() + (config.pvp?.crystalFailedAttemptCooldownMs || 1800)
        crystalFailStreak = 0
      }
    } else if (shouldUseBow(bot, target, distance, verticalGap, playerFight, config, now, lastBowAt, enemyGear, situation)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
      }
      applyRangedStrafe(bot, strafe)
      const shot = await shootBowAtTarget(bot, target, config, signal).catch(() => false)
      if (shot) {
        recordTraining(options, 'bow_shot', { target: targetLabel(target), distance: roundMetric(distance, 2), verticalGap: roundMetric(verticalGap, 2) })
        if (distance <= (config.pvp?.bowReturnWeaponRange || 8.5)) {
          await returnToCombatWeapon(bot, target, preferAxe, playerFight, situation).catch(() => {})
        }
        lastBowAt = Date.now()
        continue
      }
    }

    const shouldShield = !shouldTotem && await shouldUseShield(bot, target, distance, attackRange, attackReady, nearbyHostiles, adaptive, targetShielding, opponentSwingAgeMs, enemyGear, situation)
    if (shouldShield) {
      const wasRaised = shieldRaised
      shieldRaised = await raiseShield(bot).catch(() => false)
      if (shieldRaised && !wasRaised) {
        shieldRaisedAt = now
        recordTraining(options, 'shield_raise', { target: targetLabel(target), distance: roundMetric(distance, 2), enemyWeapon: enemyGear.weaponType || null })
      }
    } else if (shieldRaised) {
      lowerShield(bot)
      shieldRaised = false
      shieldRaisedAt = 0
      recordTraining(options, 'shield_lower', { reason: 'not_needed' })
    }
    if (shieldRaised && target.type === 'player' && enemyGear.weaponType !== 'bow' && enemyGear.weaponType !== 'crossbow' && now - shieldRaisedAt > shieldHoldWindow(config, situation) && attackReady) {
      lowerShield(bot)
      shieldRaised = false
      shieldRaisedAt = 0
      recordTraining(options, 'shield_lower', { reason: 'attack_window' })
    }

    if (target.name === 'creeper') {
      await creeperSpacing(bot, target, config, signal)
    } else {
      await combatLookAt(bot, target, config, situation).catch(() => {})
      applyTacticalMovement(bot, target, distance, activeSpacing, movement, situation, config)
    }

    await combatLookAt(bot, target, config, situation).catch(() => {})

    if (distance <= activeSpacing.hit && attackReady && decisionAllowsMelee(situation, distance, activeSpacing) && !shouldHoldAntiBait(situation, distance, attackReady, config, bot) && !shouldHoldShieldInsteadOfAttack(target, distance, bot, adaptive, attackReady, situation) && !shouldDelayMeleeForTiming(situation, distance, config)) {
      if (shieldRaised) {
        lowerShield(bot)
        shieldRaised = false
        shieldRaisedAt = 0
        await sleep(80)
      }
      await equipBestCombatWeapon(bot, target, {
        preferAxe,
        preferMace: situation.finish && situation.targetHigh,
        playerFight,
        normalDuel: situation.normalDuel
      }).catch(() => {})
      await combatLookAt(bot, target, config, situation, { attack: true }).catch(() => {})
      bot.setControlState('sprint', true)
      if (canCritical(bot, target, playerFight, targetShielding)) {
        bot.setControlState('jump', true)
        await sleep(120)
        bot.setControlState('jump', false)
      }
      bot.attack(target)
      recordMeleeAttack(options, combo, target, distance, bot.heldItem, targetShielding, situation)
      lastAttackAt = Date.now()
      if (playerFight) await sprintReset(bot, target, { comboPressure: situation.comboMomentum, config, situation }).catch(() => {})
    }

    if (playerFight && target.name !== 'creeper') {
      await sustainCombatMovement(bot, target, movement, situation, activeSpacing, config, tickMs, signal, options)
    } else {
      await sleep(tickMs)
    }
  }

  if (signal?.cancelled) endReason = 'cancelled'
  else if (!target?.isValid) endReason = 'target_lost'
  else if (Date.now() >= endAt) endReason = 'timeout'

  clearCombatControls(bot)
  return { reason: endReason }
}

function findBestHostileThreat (bot, config, aroundPlayerOnly = false, rangeOverride = null, memory = null) {
  const range = rangeOverride || config.behavior?.protectRange || 8
  const adaptive = listAdaptiveThreats(bot, config, memory, range)
    .filter(threat => !aroundPlayerOnly || nearAllowedPlayer(bot, threat.entity, config))
  if (adaptive.length) return adaptive[0].entity

  const entities = Object.values(bot.entities || {})
    .filter(entity => entity?.isValid && HOSTILE_PRIORITY.includes(entity.name))
    .filter(entity => entity.position.distanceTo(bot.entity.position) <= range)
    .filter(entity => !aroundPlayerOnly || nearAllowedPlayer(bot, entity, config))

  return entities.sort((a, b) => {
    const pa = priority(a.name)
    const pb = priority(b.name)
    if (pa !== pb) return pa - pb
    return a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
  })[0] || null
}

async function eatIfSafe (bot, target) {
  if (target?.isValid && target.position.distanceTo(bot.entity.position) < 4) return false
  const food = bot.inventory.items().find(item => FOOD_NAMES.has(item.name))
  if (!food) return false
  await bot.equip(food, 'hand')
  await bot.consume()
  return true
}

function shouldUseGoldenApple (bot, target, distance, config, now, lastGoldenAppleAt, attackReady, spacing, recentlyDamaged = false, situation = null) {
  if (!findGoldenApple(bot)) return false
  if (now - lastGoldenAppleAt < (config.pvp?.goldenAppleCooldownMs || 9000)) return false
  const health = bot.health || 20
  const aggression = pvpAggression(config)
  const noTotem = !hasTotem(bot)
  const emergencyHealth = noTotem
    ? (config.pvp?.noTotemGoldenAppleEmergencyHealth ?? config.pvp?.goldenAppleEmergencyHealth ?? 9)
    : (config.pvp?.goldenAppleEmergencyHealth || 9)
  const normalHealth = noTotem
    ? (config.pvp?.noTotemGoldenAppleHealth ?? config.pvp?.goldenAppleHealth ?? 14)
    : (config.pvp?.goldenAppleHealth || 14)
  if (!noTotem && aggression >= 1.25 && attackReady && distance <= (spacing?.hit || 3.35) + 0.2 && health > emergencyHealth) return false
  if (!noTotem && config.pvp?.highPressureMeleeMode && health > emergencyHealth && distance <= (spacing?.max || 4.2) + 1.2) return false
  if (health > normalHealth) return false
  if (!noTotem && situation?.hitConfirmed && health > emergencyHealth && distance <= (spacing?.max || 4.2)) return false
  if (noTotem) {
    const safeDistance = health <= emergencyHealth
      ? (config.pvp?.noTotemGoldenAppleEmergencyMinDistance ?? 2.8)
      : (config.pvp?.noTotemGoldenAppleMinDistance ?? 4.0)
    if (situation?.pressure || situation?.comboed || recentlyDamaged || health <= emergencyHealth) {
      return distance >= safeDistance || targetLikelyShielding(target)
    }
    return distance >= Math.max(safeDistance, (spacing?.hit || 3.35) + 0.35) || targetLikelyShielding(target)
  }
  if (health <= emergencyHealth) return distance >= Math.max(config.pvp?.goldenAppleEmergencyMinDistance || 3.0, (spacing?.hit || 3.35) - 0.15)
  if (situation?.outgeared && health <= (config.pvp?.outgearedGoldenAppleHealth || 16) && distance >= (config.pvp?.outgearedGoldenAppleDistance || 3.7)) return true
  if (situation?.pressure && distance >= Math.max(3.1, (spacing?.hit || 3.35) - 0.2)) return true
  if (situation?.outnumbered && distance >= 3.4) return true
  if (attackReady && distance <= (spacing?.hit || 3.35)) return false
  if (recentlyDamaged && distance >= Math.max(3.6, (spacing?.hit || 3.35) + 0.3)) return true
  return distance >= (config.pvp?.goldenAppleMinDistance || 4.6) || targetLikelyShielding(target)
}

async function eatGoldenAppleInCombat (bot, target, config, signal) {
  const apple = findGoldenApple(bot)
  if (!apple) return false
  bot.pathfinder?.stop()
  if (target?.isValid) {
    await bot.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
    bot.setControlState('back', true)
    bot.setControlState('sprint', true)
  }
  try {
    await bot.equip(apple, 'hand')
    await bot.consume()
    return !signal?.cancelled
  } finally {
    bot.setControlState('back', false)
    bot.setControlState('sprint', false)
  }
}

function findGoldenApple (bot) {
  return bot.inventory.items().find(item => item.name === 'enchanted_golden_apple') ||
    bot.inventory.items().find(item => item.name === 'golden_apple') ||
    null
}

async function creeperSpacing (bot, target, config, signal) {
  const distance = bot.entity.position.distanceTo(target.position)
  if (distance < 3.0) {
    await kiteAway(bot, target, config, signal).catch(() => {})
    return
  }
  if (distance > 4.2) {
    await goNear(bot, target.position, 3.8, signal, config.behavior?.pathTimeoutMs || 5000).catch(() => {})
  } else {
    bot.pathfinder.stop()
  }
}

async function kiteAway (bot, target, config, signal) {
  const dx = bot.entity.position.x - target.position.x
  const dz = bot.entity.position.z - target.position.z
  const awayX = Math.sign(dx || 1)
  const awayZ = Math.sign(dz || 1)
  const distance = config.mobDefense?.evadeDistance || 18
  const pos = bot.entity.position.offset(awayX * distance, 0, awayZ * distance)
  bot.pathfinder.stop()
  await faceVector(bot, awayX, awayZ).catch(() => {})
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  await sleep(config.mobDefense?.evadeBurstMs || 1200)
  bot.setControlState('jump', false)
  await goNear(bot, pos, 4, signal, config.behavior?.pathTimeoutMs || 5000).catch(() => {})
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
}

function retreatHealth (config, bot = null) {
  const explicit = config.pvp && Object.prototype.hasOwnProperty.call(config.pvp, 'retreatHealth')
    ? Number(config.pvp.retreatHealth)
    : 8
  const pvpRetreat = Number.isFinite(explicit) ? explicit : 8
  const noTotemRetreat = bot && !hasTotem(bot)
    ? Number(config.pvp?.noTotemRetreatHealth ?? 6.5)
    : 0
  return Math.max(pvpRetreat, config.behavior?.lowHealth || 0, Number.isFinite(noTotemRetreat) ? noTotemRetreat : 0)
}

async function faceVector (bot, x, z) {
  const yaw = Math.atan2(-x, -z)
  await bot.look(yaw, 0, true)
}

async function shouldUseShield (bot, target, distance, attackRange, attackReady, nearbyHostiles, adaptive = null, targetShielding = false, opponentSwingAgeMs = null, enemyGear = {}, situation = null) {
  const name = target.name || target.type
  const aggression = pvpAggression({ pvp: situation?.config || {} })
  const swingIncoming = typeof opponentSwingAgeMs === 'number' && opponentSwingAgeMs >= 0 && opponentSwingAgeMs <= (situation?.outgeared ? 760 : 650)
  const enemyRanged = ['bow', 'crossbow', 'trident'].includes(enemyGear.weaponType)
  const enemyAxe = enemyGear.weaponType === 'axe'
  if (distance > (enemyRanged ? 18 : 12)) return false
  const shield = await equipBestShield(bot)
  if (!shield) return false

  if (['skeleton', 'stray'].includes(name)) return distance > attackRange + 0.2 || !attackReady
  if (name === 'witch') return distance > attackRange + 0.2 || bot.health <= 12
  if (name === 'creeper') return distance <= 5.5
  if (target.type === 'player') {
    const noTotem = !hasTotem(bot)
    if (situation?.crystalReady) return false
    if (situation?.combatDecision?.action === 'shield_block' && !enemyAxe) return true
    if (situation?.comboMomentum && attackReady && distance <= attackRange + 0.8) return false
    if (aggression >= 1.3 && attackReady && distance <= attackRange + 0.5 && !swingIncoming) return false
    if (noTotem && bot.health <= (situation?.config?.noTotemShieldHealth || 14) && !enemyAxe && distance <= 5.4 && (!attackReady || swingIncoming)) return true
    if (situation?.outgeared && distance <= 5.2 && !situation.counterWindow) return true
    if (situation?.pressure && distance <= 5.2 && !attackReady) return true
    if (enemyRanged && distance <= attackRange + 0.55 && attackReady) return false
    if (enemyRanged && distance <= 18) return true
    if (swingIncoming && distance <= 4.4) return true
    if (enemyAxe && distance <= 3.4 && bot.health > 10 && !swingIncoming) return false
    return distance <= 4.6 && (!attackReady || bot.health <= 12)
  }
  if (['zombie', 'zombie_villager', 'husk', 'drowned', 'spider', 'cave_spider'].includes(name)) {
    return distance <= attackRange + 0.7 && (!attackReady || bot.health <= 10 || nearbyHostiles >= 2)
  }
  return false
}

function shouldHoldShieldInsteadOfAttack (target, distance, bot, adaptive = null, attackReady = false, situation = null) {
  const name = target.name || target.type
  if (situation?.finish && attackReady) return false
  if (situation?.crystalReady) return false
  if (situation?.outgeared && target.type === 'player') {
    if (situation.counterWindow && attackReady) return false
    return distance <= (situation.spacing?.sweet || 4.0)
  }
  if (target.type === 'player') return !attackReady && distance <= 4.4
  if (adaptive?.ranged) return true
  if (name === 'creeper' && (distance <= 2.8 || bot.health <= 8)) return true
  if (name === 'witch' && bot.health <= 8) return true
  return false
}

async function raiseShield (bot) {
  const shield = await equipBestShield(bot)
  if (!shield || typeof bot.activateItem !== 'function') return false
  bot.activateItem(true)
  return true
}

function lowerShield (bot) {
  try { bot.deactivateItem() } catch {}
}

function applyStrafe (bot, direction) {
  bot.setControlState('left', direction < 0)
  bot.setControlState('right', direction > 0)
  bot.setControlState('sprint', true)
}

function applyCombatSpacing (bot, target, distance, spacing, strafe, config = {}) {
  if (distance > spacing.max) {
    if (shouldDirectChase(distance, spacing, config)) {
      applyDirectChase(bot, strafe, distance, spacing, config)
      return
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, spacing.sweet), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    return
  }

  bot.pathfinder.stop()
  applyStrafe(bot, strafe)
  bot.setControlState('forward', distance > spacing.sweet + 0.25)
  bot.setControlState('back', distance < spacing.min)
  bot.setControlState('sprint', distance > spacing.min + 0.1)
}

function shouldDirectChase (distance, spacing, config = {}) {
  if (config.pvp?.directChaseEnabled === false) return false
  const range = config.pvp?.directChaseRange || Math.max(12, (spacing?.max || 4) + 10)
  return distance <= range
}

function applyDirectChase (bot, strafe, distance, spacing, config = {}) {
  bot.pathfinder?.stop()
  bot.setControlState('forward', true)
  bot.setControlState('back', false)
  bot.setControlState('sprint', true)
  bot.setControlState('left', strafe < 0 && distance < (config.pvp?.directChaseStrafeRange || (spacing?.hit || 3.35) + 2.5))
  bot.setControlState('right', strafe > 0 && distance < (config.pvp?.directChaseStrafeRange || (spacing?.hit || 3.35) + 2.5))
  bot.setControlState('jump', distance > (config.pvp?.directChaseJumpRange || 7) && Math.random() < (config.pvp?.directChaseJumpChance || 0.08))
}

function clearCombatControls (bot) {
  if (bot.pathfinder) bot.pathfinder.stop()
  for (const control of ['left', 'right', 'forward', 'back', 'sprint', 'jump', 'sneak']) {
    bot.setControlState(control, false)
  }
  lowerShield(bot)
}

function meleeAimPoint (target, config = {}, situation = null) {
  const height = target?.height || 1.8
  const ratio = situation?.comboMomentum
    ? (config.pvp?.comboMeleeAimHeightRatio ?? 0.62)
    : situation?.outgeared
    ? (config.pvp?.outgearedMeleeAimHeightRatio ?? 0.72)
    : (config.pvp?.meleeAimHeightRatio ?? 0.68)
  const base = situation?.predictedTargetPosition
    ? asVec3(situation.predictedTargetPosition)
    : predictEntityPosition(target, situation?.aimLeadTicks ?? (config.pvp?.meleeLeadTicks ?? 2.2), config)
  return base.offset(0, height * ratio, 0)
}

async function combatLookAt (bot, target, config = {}, situation = null, options = {}) {
  if (!target?.isValid) return
  const point = meleeAimPoint(target, config, situation)
  if (config.pvp?.combatAimSmoothing === false) {
    await bot.lookAt(point, true)
    return
  }
  const eye = bot.entity.position.offset(0, (bot.entity.height || 1.8) * 0.9, 0)
  const desired = lookAngles(eye, point)
  const currentYaw = Number.isFinite(bot.entity.yaw) ? bot.entity.yaw : desired.yaw
  const currentPitch = Number.isFinite(bot.entity.pitch) ? bot.entity.pitch : desired.pitch
  const latencyBoost = 1 + clamp(combatLatencyMs(bot, config) / 280, 0, 0.55)
  const attackBoost = options.attack ? (config.pvp?.combatAimAttackMultiplier || 1.65) : 1
  const yawStep = radians(config.pvp?.combatAimMaxYawStepDeg || 55) * latencyBoost * attackBoost
  const pitchStep = radians(config.pvp?.combatAimMaxPitchStepDeg || 35) * latencyBoost * attackBoost
  const yawDelta = shortestAngleDelta(currentYaw, desired.yaw)
  const pitchDelta = desired.pitch - currentPitch
  const minStep = radians(config.pvp?.combatAimMinStepDeg || 4)
  const nextYaw = Math.abs(yawDelta) <= Math.max(minStep, yawStep)
    ? desired.yaw
    : currentYaw + clamp(yawDelta, -yawStep, yawStep)
  const nextPitch = Math.abs(pitchDelta) <= Math.max(minStep * 0.7, pitchStep)
    ? desired.pitch
    : currentPitch + clamp(pitchDelta, -pitchStep, pitchStep)
  await bot.look(normalizeAngle(nextYaw), clamp(nextPitch, -Math.PI / 2, Math.PI / 2), true)
}

function lookAngles (from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const horizontal = Math.sqrt(dx * dx + dz * dz)
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(-dy, Math.max(0.001, horizontal))
  }
}

function shortestAngleDelta (from, to) {
  return normalizeAngle(to - from)
}

function normalizeAngle (angle) {
  let value = angle
  while (value <= -Math.PI) value += Math.PI * 2
  while (value > Math.PI) value -= Math.PI * 2
  return value
}

function radians (degrees) {
  return degrees * Math.PI / 180
}

function combatLatencyMs (bot, config = {}) {
  if (config.pvp?.latencyCompensationEnabled === false) return 0
  const values = [
    bot.player?.ping,
    bot._client?.latency,
    bot._client?.ping
  ].map(Number).filter(Number.isFinite)
  return values.length ? clamp(Math.max(...values), 0, config.pvp?.latencyMaxMs || 450) : 0
}

function combatLatencyAttackLeadMs (bot, config = {}) {
  const latency = combatLatencyMs(bot, config)
  if (!latency) return 0
  return clamp(latency * (config.pvp?.latencyAttackLeadScale ?? 0.12), 0, config.pvp?.latencyAttackLeadMaxMs || 85)
}

function shieldHoldWindow (config = {}, situation = null) {
  if (situation?.outgeared) return config.pvp?.outgearedShieldMaxHoldMs || 720
  if (situation?.pressure) return config.pvp?.pressureShieldMaxHoldMs || 680
  return config.pvp?.shieldMaxHoldMs || 850
}

function canCritical (bot, target, playerFight = false, targetShielding = false) {
  if (target.name === 'creeper') return false
  if (playerFight) return Boolean(!targetShielding && bot.entity.onGround && bot.health > 14 && bot.food > 12 && bot.entity.position.distanceTo(target.position) < 2.8)
  return Boolean(bot.entity.onGround && bot.health > 8 && bot.food > 6)
}

function countNearbyHostiles (bot, range, config = {}, memory = null) {
  return listAdaptiveThreats(bot, config, memory, range).length || Object.values(bot.entities || {})
    .filter(entity => entity?.isValid && HOSTILE_PRIORITY.includes(entity.name))
    .filter(entity => entity.position.distanceTo(bot.entity.position) <= range)
    .length
}

function nearAllowedPlayer (bot, entity, config) {
  const allowed = new Set(config.allowedPlayers || [])
  return Object.entries(bot.players || {}).some(([username, player]) => {
    if (!player.entity || !allowed.has(username)) return false
    return player.entity.position.distanceTo(entity.position) <= (config.behavior?.protectRange || 8)
  })
}

function priority (name) {
  const index = HOSTILE_PRIORITY.indexOf(name)
  return index === -1 ? HOSTILE_PRIORITY.length : index
}

async function equipBestWeapon (bot) {
  const weapon = bot.inventory.items()
    .filter(item => isWeaponCandidate(item.name) && durabilityOk(item))
    .sort((a, b) => weaponScore(b) - weaponScore(a))[0]

  if (weapon) {
    await bot.equip(weapon, 'hand')
    return weapon
  }

  return null
}

async function equipBestCombatWeapon (bot, target, options = {}) {
  const weapon = bot.inventory.items()
    .filter(item => isWeaponCandidate(item.name) && durabilityOk(item))
    .sort((a, b) => combatWeaponScore(b, target, options) - combatWeaponScore(a, target, options))[0]

  if (weapon) {
    await bot.equip(weapon, 'hand')
    return weapon
  }

  return null
}

async function equipBestShield (bot) {
  const current = offhandItem(bot)
  if (current?.name === 'shield' && durabilityOk(current)) return current
  const shield = bot.inventory.items()
    .filter(item => item.name === 'shield' && durabilityOk(item))
    .sort((a, b) => durabilityRatio(b) - durabilityRatio(a))[0]
  if (!shield) return null

  const offhandSlot = bot.getEquipmentDestSlot('off-hand')
  const equipped = bot.inventory.slots[offhandSlot]
  if (equipped?.name !== 'shield' || durabilityRatio(shield) > durabilityRatio(equipped)) {
    await bot.equip(shield, 'off-hand')
  }
  return shield
}

function weaponScore (item) {
  const name = item.name
  const type = weaponType(name)
  const material = weaponMaterial(name)
  const typeScore = {
    mace: 13,
    axe: 10,
    sword: 8,
    trident: 8,
    bow: 6,
    crossbow: 6,
    pickaxe: 4,
    shovel: 2
  }[type] || 0
  const materialScore = {
    netherite: 6,
    diamond: 5,
    iron: 4,
    stone: 3,
    golden: 2,
    gold: 2,
    wooden: 1,
    wood: 1
  }[material] || 0
  return typeScore * 100 + materialScore * 10 + durabilityRatio(item)
}

function combatWeaponScore (item, target, options = {}) {
  let score = weaponScore(item)
  const type = weaponType(item.name)
  const playerFight = options.playerFight || target?.type === 'player'
  if (playerFight) {
    if (options.normalDuel) {
      if (type === 'sword') score += 330
      if (type === 'axe') score += options.preferAxe ? 380 : -170
    } else {
      if (type === 'sword') score += 260
      if (type === 'axe') score += options.preferAxe ? 260 : -80
    }
    if (type === 'mace') score += options.preferMace ? 300 : -480
    if (type === 'trident') score += 25
  }
  if (options.preferAxe && type === 'axe') score += 120
  return score
}

function combatSpacing (config, attackRange, playerFight) {
  if (playerFight) {
    return {
      min: config.pvp?.minSpacing || 2.35,
      sweet: config.pvp?.sweetSpacing || 2.95,
      max: config.pvp?.maxSpacing || 3.55,
      hit: Math.max(attackRange + 0.15, config.pvp?.hitRange || 3.35)
    }
  }
  return {
    min: 2.1,
    sweet: Math.max(2.6, attackRange - 0.35),
    max: attackRange + 0.8,
    hit: attackRange + 0.35
  }
}

function attackCooldownMs (item, config = {}) {
  const name = item?.name || ''
  const safety = config.pvp?.cooldownSafety ?? 1.05
  let base = 650
  if (name === 'mace') base = 900
  else if (name === 'trident') base = 900
  else if (name.endsWith('_sword')) base = 625
  else if (name.endsWith('_axe')) {
    if (name.startsWith('wooden_') || name.startsWith('stone_')) base = 1250
    else if (name.startsWith('iron_')) base = 1100
    else base = 1000
  } else if (name.endsWith('_pickaxe') || name.endsWith('_shovel')) {
    base = 850
  }
  return Math.round(base * safety)
}

async function sprintReset (bot, target, options = {}) {
  const config = options.config || {}
  const situation = options.situation || {}
  const spacing = situation.spacing || {}
  const currentDistance = target?.isValid ? bot.entity.position.distanceTo(target.position) : 99
  const tooClose = situation.spacingState?.tooClose ||
    currentDistance < (config.pvp?.comboSpacingBackRange || Math.max(1.7, (spacing.min || 2.1) - 0.15))
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
  const comboPressure = Boolean(options.comboPressure)
  const resetRange = comboPressure ? (config.pvp?.comboSprintResetRange || 2.25) : 2.7
  if (target?.isValid && (tooClose || currentDistance < resetRange)) {
    const strafeRight = Math.random() > 0.5
    bot.setControlState('back', true)
    if (comboPressure && config.pvp?.comboResetStrafe !== false) bot.setControlState(strafeRight ? 'right' : 'left', true)
    await sleep(comboPressure
      ? (tooClose ? (config.pvp?.comboSTapBackMs || 82) : (config.pvp?.comboSprintResetBackMs || 55))
      : options.axePressure ? (config.pvp?.axePressureResetMs || 130) : (config.pvp?.sprintResetBackMs || 90))
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
  } else {
    if (comboPressure && config.pvp?.comboWTapForwardPulse !== false && currentDistance > (spacing.min || 2.1)) {
      bot.setControlState('forward', true)
      await sleep(config.pvp?.comboWTapForwardMs || 35)
      bot.setControlState('forward', false)
    } else {
      await sleep(comboPressure ? (config.pvp?.comboSprintResetPauseMs || 35) : (config.pvp?.sprintResetPauseMs || 70))
    }
  }
  bot.setControlState('sprint', true)
}

function recordTraining (options, type, details = {}) {
  if (!options?.training || typeof options.training.recordEvent !== 'function') return
  options.training.recordEvent(type, details)
}

function recordMeleeAttack (options, combo, target, distance, heldItem, targetShielding, situation = {}, extra = {}) {
  const now = Date.now()
  if (combo) {
    combo.pendingAttack = {
      at: now,
      hurtSeenAt: combo.lastTargetHurtAt || 0,
      distance,
      tactic: situation.name
    }
  }
  recordTraining(options, 'melee_attack', {
    target: targetLabel(target),
    distance: roundMetric(distance, 2),
    weapon: heldItem?.name || null,
    targetShielding,
    tactic: situation.name,
    hitConfirm: Boolean(situation.hitConfirmed),
    comboChain: situation.comboChain || 0,
    comboMomentum: Boolean(situation.comboMomentum),
    targetKnockbackSpeed: roundMetric(situation.targetKnockbackSpeed || 0, 3),
    ...extra
  })
}

function createComboState () {
  return {
    chain: 0,
    maxChain: 0,
    lastComboAt: 0,
    lastTargetHurtAt: 0,
    lastDamageAt: 0,
    brokenUntil: 0,
    lastBreakAt: 0,
    breakReason: null,
    momentumUntil: 0,
    lostTradeUntil: 0,
    targetKnockbackSpeed: 0,
    predictedTargetPosition: null,
    aimLeadTicks: 0,
    pendingAttack: null
  }
}

function updateComboState (combo, bot, target, now, distance, feedback = {}, config = {}, options = {}) {
  const targetName = targetLabel(target)
  const hurtAt = feedback?.lastTargetHurtAt || 0
  const hurtName = feedback?.lastTargetHurtName || null
  const hurtMatches = hurtAt && hurtAt !== combo.lastTargetHurtAt && (!hurtName || !targetName || hurtName === targetName)
  if (hurtMatches && now - hurtAt <= (config.pvp?.comboFeedbackMaxAgeMs || 1800)) {
    const withinChain = hurtAt - combo.lastComboAt <= (config.pvp?.comboChainWindowMs || 1350)
    combo.chain = withinChain ? combo.chain + 1 : 1
    combo.maxChain = Math.max(combo.maxChain, combo.chain)
    combo.lastComboAt = hurtAt
    combo.lastTargetHurtAt = hurtAt
    combo.momentumUntil = now + (config.pvp?.comboMomentumMs || 950)
    combo.targetKnockbackSpeed = horizontalSpeed(target.velocity)
    combo.predictedTargetPosition = predictEntityPosition(target, comboLeadTicks(combo, distance, config), config)
    combo.aimLeadTicks = comboLeadTicks(combo, distance, config)
    combo.pendingAttack = null
    combo.breakReason = null
    combo.brokenUntil = 0
    recordTraining(options, 'combo_chain', {
      target: targetName,
      chain: combo.chain,
      maxChain: combo.maxChain,
      distance: roundMetric(distance, 2),
      knockback: roundMetric(combo.targetKnockbackSpeed, 3)
    })
    if (awayVelocityFromBot(bot, target) >= (config.pvp?.knockbackReadMinAwaySpeed || 0.08)) {
      recordTraining(options, 'knockback_read', {
        target: targetName,
        chain: combo.chain,
        awaySpeed: roundMetric(awayVelocityFromBot(bot, target), 3)
      })
    }
  }

  const damageAt = feedback?.lastDamageAt || 0
  const damageAttacker = feedback?.lastDamageAttackerName || null
  const damageMatches = damageAt && damageAt !== combo.lastDamageAt && (!damageAttacker || !targetName || damageAttacker === targetName)
  if (damageMatches) {
    combo.lastDamageAt = damageAt
    if (combo.chain > 0 && Math.abs(damageAt - combo.lastComboAt) <= (config.pvp?.comboTradeWindowMs || 900)) {
      combo.lostTradeUntil = now + (config.pvp?.comboLostTradeMs || 650)
      recordTraining(options, 'combo_trade_lost', {
        target: targetName,
        chain: combo.chain,
        distance: roundMetric(distance, 2)
      })
    }
  }

  if (combo.pendingAttack && now - combo.pendingAttack.at > (config.pvp?.meleeMissWindowMs || 750)) {
    const hitAfterAttack = combo.lastTargetHurtAt >= combo.pendingAttack.at
    if (!hitAfterAttack) {
      recordTraining(options, 'melee_miss', {
        target: targetName,
        tactic: combo.pendingAttack.tactic,
        distance: roundMetric(combo.pendingAttack.distance, 2)
      })
      if (combo.chain > 0) markComboBroken(combo, now, 'missed_followup', targetName, distance, config, options)
    }
    combo.pendingAttack = null
  }

  if (
    combo.chain > 0 &&
    distance > (config.pvp?.comboBreakRange || 4.15) &&
    now - combo.lastComboAt > (config.pvp?.comboBreakGraceMs || 520)
  ) {
    markComboBroken(combo, now, 'spacing_lost', targetName, distance, config, options)
  }
  if (combo.chain > 0 && now - combo.lastComboAt > (config.pvp?.comboDropMs || 1800)) {
    markComboBroken(combo, now, 'window_expired', targetName, distance, config, options)
    combo.chain = 0
  }
  combo.predictedTargetPosition = predictEntityPosition(target, comboLeadTicks(combo, distance, config), config)
  combo.aimLeadTicks = comboLeadTicks(combo, distance, config)
  combo.comboMomentum = combo.chain > 0 && now <= combo.momentumUntil
  combo.comboBroken = now <= combo.brokenUntil
  combo.tradeLost = now <= combo.lostTradeUntil
  return combo
}

function markComboBroken (combo, now, reason, targetName, distance, config = {}, options = {}) {
  if (now - (combo.lastBreakAt || 0) < (config.pvp?.comboBreakRecordCooldownMs || 700)) return
  combo.lastBreakAt = now
  combo.breakReason = reason
  combo.brokenUntil = now + (config.pvp?.comboReentryMs || 760)
  recordTraining(options, 'combo_break', {
    target: targetName,
    reason,
    chain: combo.chain || 0,
    distance: roundMetric(distance, 2)
  })
}

function comboLeadTicks (combo, distance, config = {}) {
  const base = combo?.chain > 0 ? (config.pvp?.meleeComboLeadTicks ?? 3.2) : (config.pvp?.meleeLeadTicks ?? 2.2)
  return clamp(base + Math.max(0, distance - 2.4) * (config.pvp?.meleeLeadTicksPerBlock ?? 0.45), 0, config.pvp?.meleeMaxLeadTicks ?? 5)
}

function predictEntityPosition (entity, leadTicks = 2, config = {}, velocityOverride = null) {
  const velocity = velocityOverride || entity?.velocity || new Vec3(0, 0, 0)
  const maxLead = config.pvp?.meleeMaxLeadBlocks ?? 1.25
  return entity.position.offset(
    clamp(velocity.x * leadTicks, -maxLead, maxLead),
    clamp(velocity.y * leadTicks, -maxLead * 0.4, maxLead * 0.4),
    clamp(velocity.z * leadTicks, -maxLead, maxLead)
  )
}

function createEnemyMotionState () {
  return {
    lastPosition: null,
    lastAt: 0,
    velocity: new Vec3(0, 0, 0),
    samples: []
  }
}

function updateEnemyMotionState (state, bot, target, now, distance, config = {}) {
  const position = target.position.clone()
  const liveVelocity = target.velocity || new Vec3(0, 0, 0)
  let measuredVelocity = liveVelocity
  if (state.lastPosition && state.lastAt) {
    const ticks = clamp((now - state.lastAt) / 50, 0.5, 8)
    measuredVelocity = new Vec3(
      (position.x - state.lastPosition.x) / ticks,
      (position.y - state.lastPosition.y) / ticks,
      (position.z - state.lastPosition.z) / ticks
    )
  }
  const previous = state.velocity || liveVelocity
  const alpha = clamp(config.pvp?.enemyVelocityBlend ?? 0.62, 0.1, 0.9)
  const velocity = new Vec3(
    previous.x * (1 - alpha) + (measuredVelocity.x * 0.65 + liveVelocity.x * 0.35) * alpha,
    previous.y * (1 - alpha) + (measuredVelocity.y * 0.65 + liveVelocity.y * 0.35) * alpha,
    previous.z * (1 - alpha) + (measuredVelocity.z * 0.65 + liveVelocity.z * 0.35) * alpha
  )
  state.lastPosition = position
  state.lastAt = now
  state.velocity = velocity

  const radial = horizontalUnit(bot.entity.position, target.position)
  const awaySpeed = velocity.x * radial.x + velocity.z * radial.z
  const lateralSpeed = velocity.x * -radial.z + velocity.z * radial.x
  const speed = horizontalSpeed(velocity)
  const lookDot = targetLookDot(bot, target)
  const sprinting = speed >= (config.pvp?.enemySprintSpeed || 0.17) || awaySpeed >= (config.pvp?.enemySprintAwaySpeed || 0.11)
  rememberLimited(state.samples, { at: now, awaySpeed, lateralSpeed, speed, lookDot }, Math.max(5, config.pvp?.enemyMotionSamples || 9))
  const pattern = classifyEnemyMovement(state.samples, config)
  const latencyLeadTicks = clamp(
    (combatLatencyMs(bot, config) / 50) * (config.pvp?.latencyLeadScale ?? 0.35),
    0,
    config.pvp?.latencyMaxLeadTicks ?? 2
  )
  const leadTicks = clamp(
    (config.pvp?.meleeLeadTicks ?? 2.2) +
      speed * (config.pvp?.motionLeadSpeedScale ?? 4.2) +
      Math.max(0, awaySpeed) * (config.pvp?.motionLeadAwayScale ?? 3.5) +
      Math.max(0, distance - 2.5) * (config.pvp?.meleeLeadTicksPerBlock ?? 0.45) +
      latencyLeadTicks,
    0,
    config.pvp?.meleeMaxLeadTicks ?? 5
  )

  return {
    velocity,
    speed,
    awaySpeed,
    lateralSpeed,
    lookDot,
    sprinting,
    pattern,
    leadTicks,
    predictedPosition: predictEntityPosition(target, leadTicks, config, velocity)
  }
}

function horizontalUnit (from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.sqrt(dx * dx + dz * dz)
  if (length < 0.001) return { x: 0, z: 1 }
  return { x: dx / length, z: dz / length }
}

function targetLookDot (bot, target) {
  if (!target?.position || !bot?.entity?.position) return 0
  const yaw = target.yaw || 0
  const facing = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
  const toBot = bot.entity.position.minus(target.position)
  toBot.y = 0
  const distance = Math.max(0.001, Math.sqrt(toBot.x * toBot.x + toBot.z * toBot.z))
  return (facing.x * toBot.x + facing.z * toBot.z) / distance
}

function classifyEnemyMovement (samples = [], config = {}) {
  if (samples.length < 3) return 'reading'
  const recent = samples.slice(-Math.max(3, config.pvp?.enemyMovementPatternSamples || 7))
  const avgAway = average(recent.map(sample => sample.awaySpeed))
  const avgSpeed = average(recent.map(sample => sample.speed))
  const avgLateral = average(recent.map(sample => Math.abs(sample.lateralSpeed)))
  let lateralFlips = 0
  for (let i = 1; i < recent.length; i++) {
    if (Math.sign(recent[i - 1].lateralSpeed) !== Math.sign(recent[i].lateralSpeed)) lateralFlips++
  }
  if (avgSpeed < (config.pvp?.enemyHoldingSpeed || 0.035)) return 'holding'
  if (avgAway > (config.pvp?.enemyKitingAwaySpeed || 0.075)) return 'kiting'
  if (avgAway < -(config.pvp?.enemyRushingAwaySpeed || 0.06)) return 'rushing'
  if (avgLateral > Math.max(0.06, avgSpeed * 0.52) && lateralFlips >= 2) return 'juking'
  if (avgLateral > Math.max(0.055, avgSpeed * 0.42)) return 'strafing'
  return 'linear'
}

function average (values = []) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
}

function horizontalSpeed (velocity = new Vec3(0, 0, 0)) {
  return Math.sqrt((velocity.x || 0) * (velocity.x || 0) + (velocity.z || 0) * (velocity.z || 0))
}

function awayVelocityFromBot (bot, target) {
  if (!bot?.entity || !target?.position) return 0
  const velocity = target.velocity || new Vec3(0, 0, 0)
  const dx = target.position.x - bot.entity.position.x
  const dz = target.position.z - bot.entity.position.z
  const length = Math.sqrt(dx * dx + dz * dz)
  if (length < 0.001) return 0
  return (velocity.x * dx + velocity.z * dz) / length
}

function assessPvpSituation (bot, target, config = {}, ctx = {}) {
  const baseSpacing = ctx.baseSpacing || combatSpacing(config, config.pvp?.attackRange || 3.2, true)
  const targetHealth = readTargetHealth(bot, target)
  const botHealth = bot.health || 20
  const bossMode = config.pvp?.finalBossMode === true
  const totemReady = hasTotem(bot)
  const noTotem = !totemReady
  const feedback = ctx.feedback || {}
  const targetName = targetLabel(target)
  const targetTotemPopAgeMs = feedback.lastTargetTotemPopAt &&
    (!feedback.lastTargetTotemPopName || !targetName || feedback.lastTargetTotemPopName === targetName)
    ? Date.now() - feedback.lastTargetTotemPopAt
    : Infinity
  const botTotemPopAgeMs = feedback.lastBotTotemPopAt ? Date.now() - feedback.lastBotTotemPopAt : Infinity
  const targetTotemPopped = targetTotemPopAgeMs <= (config.pvp?.tempoTargetPopExecuteMs || 4200)
  const botTotemPopped = botTotemPopAgeMs <= (config.pvp?.tempoBotPopSurvivalMs || 2600)
  const enemies = uniqueEntities(ctx.nearbyPlayers || [target]).filter(entity => entity?.isValid)
  const enemyCount = enemies.length || 1
  const comboDamage = recentDamageAmount(ctx.damageWindow || [])
  const comboHits = (ctx.damageWindow || []).length
  const comboed = comboHits >= (config.pvp?.comboResetHits || 2) ||
    comboDamage >= (config.pvp?.comboResetDamage || 5.5)
  const outnumbered = enemyCount >= (config.pvp?.teamRetreatCount || 2)
  const finishHealth = bossMode
    ? (config.pvp?.finalBossFinishHealth ?? config.pvp?.finishHealth ?? 7)
    : (config.pvp?.finishHealth || 7)
  const targetLow = targetTotemPopped || (Number.isFinite(targetHealth) && targetHealth <= finishHealth)
  const botLow = botHealth <= (noTotem
    ? (config.pvp?.noTotemGoldenAppleHealth ?? config.pvp?.goldenAppleHealth ?? 14)
    : (config.pvp?.goldenAppleHealth || 14))
  const emergencyLow = botHealth <= (noTotem
    ? (config.pvp?.noTotemGoldenAppleEmergencyHealth ?? config.pvp?.goldenAppleEmergencyHealth ?? 9)
    : (config.pvp?.goldenAppleEmergencyHealth || 9))
  const targetHigh = ctx.verticalGap >= (config.pvp?.highGroundVerticalGap || 2.6)
  const runner = isTargetRunning(bot, target, ctx.distance, ctx.distanceTrend, config)
  const crystalReady = Boolean(ctx.enemyGear?.crystalReady || nearbyCrystalThreat(bot, config))
  const normalDuel = !ctx.hasCrystalKit && !crystalReady
  const enemyWeaponType = ctx.enemyGear?.weaponType || null
  const enemyAxe = enemyWeaponType === 'axe'
  const opponentModel = ctx.opponentModel || {}
  const opponentRanged = opponentHasStyle(opponentModel, 'ranged')
  const opponentShieldTurtle = opponentHasStyle(opponentModel, 'shield_turtle')
  const opponentCrystalUser = opponentHasStyle(opponentModel, 'crystal_user')
  const opponentKiter = opponentHasStyle(opponentModel, 'kiter')
  const opponentMeleeRusher = opponentHasStyle(opponentModel, 'melee_rusher')
  const opponentBaiter = opponentHasStyle(opponentModel, 'baiter')
  const opponentComboable = opponentHasStyle(opponentModel, 'comboable')
  const counterPlan = opponentModel.counterPlan || {}
  const combo = ctx.combo || {}
  const motion = ctx.enemyMotion || {}
  const comboMomentum = Boolean(combo.comboMomentum)
  const comboBroken = Boolean(combo.comboBroken)
  const tradeLost = Boolean(combo.tradeLost)
  const gear = comparePvpGear(bot, target)
  const outgeared = normalDuel && gear.gap >= (config.pvp?.outgearedGap || 95)
  const badlyOutgeared = normalDuel && gear.gap >= (config.pvp?.badlyOutgearedGap || 170)
  const counterWindow = normalDuel &&
    typeof ctx.opponentSwingAgeMs === 'number' &&
    ctx.opponentSwingAgeMs >= (config.pvp?.duelCounterMinAgeMs || 130) &&
    ctx.opponentSwingAgeMs <= (outgeared ? (config.pvp?.outgearedCounterWindowMs || 520) : (config.pvp?.duelCounterWindowMs || 650)) &&
    ctx.distance <= (baseSpacing.hit + (config.pvp?.duelCounterExtraRange || 0.35))
  const noTotemPressure = noTotem && botHealth <= (config.pvp?.noTotemPressureHealth || 13)
  const pressure = botTotemPopped || emergencyLow || noTotemPressure || botHealth <= (config.pvp?.pressureHealth || 13) || comboed ||
    (outnumbered && botHealth <= (config.pvp?.teamRetreatHealth || 15)) ||
    (ctx.recentlyDamaged && botHealth <= (config.pvp?.pressureHealth || 13)) ||
    (opponentMeleeRusher && ctx.recentlyDamaged && botHealth <= (config.pvp?.rusherPressureHealth || 16))
  let name = 'trade'

  if (pressure) name = 'survive'
  else if (crystalReady || opponentCrystalUser) name = 'anti_crystal'
  else if (comboMomentum) name = 'combo'
  else if (opponentBaiter && !ctx.hitConfirmed) name = 'bait_check'
  else if (targetLow) name = 'finish'
  else if (outgeared) name = 'outgeared_duel'
  else if (ctx.targetShielding || opponentShieldTurtle) name = 'shield_break'
  else if (normalDuel && enemyAxe && ctx.distance <= (config.pvp?.duelAxeThreatRange || 4.2)) name = 'axe_kite'
  else if (opponentRanged && ctx.distance > baseSpacing.hit + 0.5) name = 'chase'
  else if (counterWindow && ctx.attackReady) name = 'counter'
  else if (targetHigh) name = 'high_ground'
  else if (runner || opponentKiter) name = 'chase'

  const bossPhase = bossMode
    ? pressure
      ? 'survival'
      : targetLow
        ? 'execute'
        : comboMomentum || ctx.hitConfirmed
          ? 'combo'
          : (runner || opponentKiter || opponentRanged)
            ? 'hunt'
            : 'duel'
    : null

  const situation = {
    name,
    playerFight: true,
    bossMode,
    bossPhase,
    totemReady,
    noTotem,
    targetTotemPopped,
    targetTotemPopAgeMs: Number.isFinite(targetTotemPopAgeMs) ? targetTotemPopAgeMs : null,
    botTotemPopped,
    botTotemPopAgeMs: Number.isFinite(botTotemPopAgeMs) ? botTotemPopAgeMs : null,
    targetHealth: Number.isFinite(targetHealth) ? roundMetric(targetHealth, 1) : null,
    botLow,
    targetLow,
    finish: targetLow,
    pressure,
    comboed,
    comboHits,
    comboDamage,
    outnumbered,
    enemyCount,
    targetHigh,
    runner,
    crystalReady,
    normalDuel,
    outgeared,
    badlyOutgeared,
    gearGap: roundMetric(gear.gap, 1),
    botGearScore: roundMetric(gear.bot, 1),
    targetGearScore: roundMetric(gear.target, 1),
    enemyWeaponType,
    enemyAxe,
    counterWindow,
    targetShielding: Boolean(ctx.targetShielding),
    opponentSwingAgeMs: ctx.opponentSwingAgeMs,
    attackReady: Boolean(ctx.attackReady),
    hitConfirmed: Boolean(ctx.hitConfirmed),
    hitConfirmAgeMs: ctx.hitConfirmAgeMs,
    opponentModel,
    opponentRanged,
    opponentShieldTurtle,
    opponentCrystalUser,
    opponentKiter,
    opponentMeleeRusher,
    opponentBaiter,
    opponentComboable,
    counterPlan,
    comboChain: combo.chain || 0,
    comboMomentum,
    comboBroken,
    comboBreakReason: combo.breakReason || null,
    tradeLost,
    targetKnockbackSpeed: combo.targetKnockbackSpeed || 0,
    predictedTargetPosition: combo.predictedTargetPosition || motion.predictedPosition || null,
    aimLeadTicks: combo.aimLeadTicks || motion.leadTicks || 0,
    predictiveAim: Boolean(combo.predictedTargetPosition || motion.predictedPosition),
    enemySpeed: roundMetric(motion.speed || 0, 3),
    enemyAwaySpeed: roundMetric(motion.awaySpeed || 0, 3),
    enemyLateralSpeed: roundMetric(motion.lateralSpeed || 0, 3),
    enemyLookDot: roundMetric(motion.lookDot || 0, 2),
    enemySprinting: Boolean(motion.sprinting),
    enemyMovementPattern: motion.pattern || 'reading',
    distanceTrend: ctx.distanceTrend || 0,
    config: config.pvp || {}
  }
  situation.spacing = tacticalSpacing(baseSpacing, situation, config)
  return situation
}

function tacticalSpacing (base, situation, config = {}) {
  const spacing = { ...base }
  if (situation.pressure) {
    spacing.min = Math.max(spacing.min, config.pvp?.pressureMinSpacing || 3.2)
    spacing.sweet = Math.max(spacing.sweet, config.pvp?.pressureSweetSpacing || 4.15)
    spacing.max = Math.max(spacing.max, config.pvp?.pressureMaxSpacing || 5.2)
  } else if (situation.crystalReady) {
    spacing.min = Math.max(spacing.min, config.pvp?.antiCrystalMinSpacing || 4.2)
    spacing.sweet = Math.max(spacing.sweet, config.pvp?.antiCrystalSweetSpacing || 5.0)
    spacing.max = Math.max(spacing.max, config.pvp?.antiCrystalMaxSpacing || 5.8)
  } else if (situation.finish) {
    spacing.min = Math.min(spacing.min, config.pvp?.finishMinSpacing || 2.15)
    spacing.sweet = Math.min(spacing.sweet, config.pvp?.finishSweetSpacing || 2.55)
    spacing.max = Math.max(spacing.max, config.pvp?.finishMaxSpacing || 4.25)
  } else if (situation.targetShielding || situation.opponentShieldTurtle) {
    spacing.min = Math.max(spacing.min, config.pvp?.shieldBaitMinSpacing || 2.75)
    spacing.sweet = Math.max(spacing.sweet, config.pvp?.shieldBaitSweetSpacing || 3.35)
    spacing.max = Math.max(spacing.max, config.pvp?.shieldBaitMaxSpacing || 4.25)
  } else if (situation.outgeared) {
    spacing.min = Math.max(spacing.min, situation.badlyOutgeared ? (config.pvp?.badlyOutgearedMinSpacing || 3.55) : (config.pvp?.outgearedMinSpacing || 3.15))
    spacing.sweet = Math.max(spacing.sweet, situation.badlyOutgeared ? (config.pvp?.badlyOutgearedSweetSpacing || 4.35) : (config.pvp?.outgearedSweetSpacing || 3.85))
    spacing.max = Math.max(spacing.max, situation.badlyOutgeared ? (config.pvp?.badlyOutgearedMaxSpacing || 5.1) : (config.pvp?.outgearedMaxSpacing || 4.55))
  } else if (situation.normalDuel && situation.enemyAxe) {
    spacing.min = Math.max(spacing.min, config.pvp?.duelAxeMinSpacing || 3.05)
    spacing.sweet = Math.max(spacing.sweet, config.pvp?.duelAxeSweetSpacing || 3.55)
    spacing.max = Math.max(spacing.max, config.pvp?.duelAxeMaxSpacing || 4.15)
  } else if (situation.normalDuel && situation.counterWindow) {
    spacing.min = Math.max(spacing.min, config.pvp?.duelCounterMinSpacing || 2.45)
    spacing.sweet = Math.min(spacing.sweet, config.pvp?.duelCounterSweetSpacing || 2.85)
    spacing.max = Math.max(spacing.max, config.pvp?.duelCounterMaxSpacing || 3.55)
  } else if (situation.normalDuel) {
    spacing.min = Math.max(spacing.min, config.pvp?.duelMinSpacing || 2.55)
    spacing.sweet = Math.max(spacing.sweet, config.pvp?.duelSweetSpacing || 3.1)
    spacing.max = Math.max(spacing.max, config.pvp?.duelMaxSpacing || 3.85)
  } else if (situation.targetHigh || situation.runner) {
    spacing.max = Math.max(spacing.max, config.pvp?.chaseMaxSpacing || 4.6)
  }
  if (situation.hitConfirmed && !situation.crystalReady) {
    spacing.min = Math.min(spacing.min, config.pvp?.hitConfirmMinSpacing || 2.0)
    spacing.sweet = Math.min(spacing.sweet, config.pvp?.hitConfirmSweetSpacing || 2.45)
    spacing.max = Math.min(spacing.max, config.pvp?.hitConfirmMaxSpacing || 3.1)
  }
  if (situation.comboMomentum && !situation.crystalReady) {
    spacing.min = Math.min(spacing.min, config.pvp?.comboMinSpacing || 1.85)
    spacing.sweet = Math.min(spacing.sweet, config.pvp?.comboSweetSpacing || 2.25)
    spacing.max = Math.min(spacing.max, config.pvp?.comboMaxSpacing || 2.95)
  }
  if (situation.opponentComboable && situation.hitConfirmed && !situation.crystalReady) {
    spacing.max = Math.min(spacing.max, config.pvp?.comboableMaxSpacing || 2.85)
  }
  if (situation.tradeLost && !situation.comboMomentum) {
    spacing.min = Math.max(spacing.min, config.pvp?.lostTradeMinSpacing || 2.65)
    spacing.sweet = Math.max(spacing.sweet, config.pvp?.lostTradeSweetSpacing || 3.25)
  }
  if ((situation.opponentRanged || situation.opponentKiter || situation.counterPlan?.pressure === 'hard_chase') && !situation.pressure && !situation.crystalReady) {
    spacing.max = Math.min(spacing.max, config.pvp?.antiKiteMaxSpacing || 3.15)
    spacing.sweet = Math.min(spacing.sweet, config.pvp?.antiKiteSweetSpacing || 2.55)
  }
  if (config.pvp?.highPressureMeleeMode && !situation.pressure && !situation.crystalReady) {
    spacing.sweet = Math.min(spacing.sweet, config.pvp?.highPressureSweetSpacing || 2.25)
    spacing.max = Math.min(spacing.max, config.pvp?.highPressureMaxSpacing || 3.05)
  }
  if (situation.opponentMeleeRusher && !situation.hitConfirmed && !situation.finish) {
    spacing.min = Math.max(spacing.min, config.pvp?.antiRusherMinSpacing || 2.45)
  }
  spacing.hit = base.hit
  return spacing
}

function spacingState (distance, spacing = {}, config = {}) {
  const tooCloseRange = config.pvp?.spacingTooCloseRange ?? Math.max(1.15, (spacing.min || 2.3) - (config.pvp?.spacingTooCloseBuffer ?? 0.28))
  const sweetTolerance = config.pvp?.spacingSweetTolerance ?? 0.28
  const hitRange = spacing.hit || 3.35
  const min = spacing.min || 2.3
  const sweet = spacing.sweet || 3
  const max = spacing.max || 3.8
  let label = 'control'
  if (distance < tooCloseRange) label = 'too_close'
  else if (distance < min) label = 'close'
  else if (Math.abs(distance - sweet) <= sweetTolerance) label = 'sweet'
  else if (distance <= hitRange) label = 'hit_range'
  else if (distance > max) label = 'too_far'
  return {
    label,
    tooClose: label === 'too_close',
    close: label === 'too_close' || label === 'close',
    inHitRange: distance <= hitRange,
    inSweetSpot: label === 'sweet',
    tooFar: label === 'too_far',
    error: roundMetric(distance - sweet, 2)
  }
}

function assessCombatTempo (bot, target, distance = 99, spacing = {}, situation = {}, config = {}, now = Date.now(), ctx = {}) {
  if (config.pvp?.tempoEngineEnabled === false || !situation?.playerFight) return null
  const cooldownMs = attackCooldownMs(bot.heldItem, config)
  const sinceAttack = ctx.lastAttackAt ? now - ctx.lastAttackAt : Infinity
  const sinceTargetHurt = Number.isFinite(ctx.hitConfirmAgeMs) ? ctx.hitConfirmAgeMs : Infinity
  const closeRange = (spacing.hit || 3.35) + (config.pvp?.tempoCloseRangeExtra || 0.55)
  const inTempoRange = distance <= closeRange
  const cooldownRatio = situation.targetTotemPopped
    ? (config.pvp?.tempoExecuteCooldownRatio ?? 0.68)
    : situation.hitConfirmed
      ? (config.pvp?.tempoPunishRecoveryCooldownRatio ?? 0.72)
      : (config.pvp?.tempoGoodEnoughCooldownRatio ?? 0.82)
  const goodEnough = sinceAttack >= cooldownMs * cooldownRatio - combatLatencyAttackLeadMs(bot, config)
  const maxNoSwingMs = situation.targetTotemPopped
    ? (config.pvp?.tempoTargetPopMaxNoSwingMs || 360)
    : situation.comboMomentum
      ? (config.pvp?.tempoComboMaxNoSwingMs || 560)
      : (config.pvp?.tempoMaxNoSwingMs || 760)
  const pressureOverdue = inTempoRange && sinceAttack >= maxNoSwingMs
  const punishRecovery = inTempoRange &&
    sinceTargetHurt <= (config.pvp?.tempoPunishRecoveryMs || 680) &&
    sinceAttack >= cooldownMs * (config.pvp?.tempoPunishRecoveryCooldownRatio ?? 0.72) - combatLatencyAttackLeadMs(bot, config)
  const executeTempo = situation.targetTotemPopped && inTempoRange
  const imperfectTiming = inTempoRange &&
    goodEnough &&
    Math.random() < (situation.targetTotemPopped
      ? (config.pvp?.tempoImperfectExecuteChance ?? 0.55)
      : (config.pvp?.tempoImperfectSwingChance ?? 0.22))
  return {
    sinceAttack,
    sinceTargetHurt,
    cooldownMs,
    closeRange,
    inTempoRange,
    goodEnough,
    pressureOverdue,
    punishRecovery,
    executeTempo,
    imperfectTiming
  }
}

function decideCombatAction (bot, target, situation = {}, distance = 99, spacing = {}, attackReady = false, config = {}, ctx = {}) {
  const state = situation.spacingState || spacingState(distance, spacing, config)
  const health = bot.health || 20
  const action = (action, reason, priority = 1) => ({ action, reason, priority })
  const noTotem = !hasTotem(bot)
  const canEatWindow = findGoldenApple(bot) &&
    shouldUseGoldenApple(bot, target, distance, config, Date.now(), ctx.lastGoldenAppleAt || 0, attackReady, spacing, ctx.recentlyDamaged, situation)
  const lowHpDisengage = health <= (noTotem
    ? (config.pvp?.noTotemLowHpDisengageHealth ?? config.pvp?.lowHpDisengageHealth ?? 6)
    : (config.pvp?.lowHpDisengageHealth || 6))
  const emergencyHealth = health <= (noTotem
    ? (config.pvp?.noTotemGoldenAppleEmergencyHealth ?? config.pvp?.goldenAppleEmergencyHealth ?? 5)
    : (config.pvp?.goldenAppleEmergencyHealth || 5))
  const enemyRanged = ['bow', 'crossbow', 'trident'].includes(ctx.enemyGear?.weaponType)

  if (canEatWindow && (emergencyHealth || distance >= (config.pvp?.decisionHealMinRange || 4.4))) return action('heal_eat', emergencyHealth ? 'emergency_heal_window' : 'safe_heal_window', 100)
  if (situation.botTotemPopped && !situation.finish) return action(canEatWindow ? 'heal_eat' : 'reposition', 'own_totem_pop_survival', 98)
  if (lowHpDisengage && !situation.finish) return action('disengage', noTotem ? 'no_totem_low_hp' : 'low_hp_bad_trade', 95)
  if (noTotem && health <= (config.pvp?.noTotemNoCommitHealth || 11) && !situation.finish && distance <= (spacing.hit || 3.35) + 0.7) return action('back_up', 'no_totem_no_commit', 91)
  if (situation.crystalReady && distance < (spacing.min || 4.2)) return action('back_up', 'anti_crystal_spacing', 92)
  if (situation.targetTotemPopped && distance <= (spacing.hit || 3.35) + (config.pvp?.tempoTargetPopExtraRange || 0.55)) return attackReady || situation.tempo?.goodEnough ? action('attack', 'target_totem_pop_execute', 89) : action('strafe', 'target_totem_pop_hold_angle', 72)
  if (situation.targetTotemPopped && distance <= (config.pvp?.tempoTargetPopChaseRange || 7.5)) return action('chase', 'target_totem_pop_chase', 78)
  if (situation.tempo?.pressureOverdue && distance <= (spacing.hit || 3.35) + (config.pvp?.tempoCloseRangeExtra || 0.55)) return action('attack', 'tempo_pressure_timer', 84)
  if (situation.tempo?.punishRecovery) return action('attack', 'punish_enemy_recovery', 83)
  if (situation.comboed && distance <= (config.pvp?.decisionComboBreakRange || 3.35)) return action('back_up', 'break_enemy_combo', 90)
  if (situation.tradeLost && distance <= (config.pvp?.decisionLostTradeRange || 3.25)) return action('reposition', 'lost_trade_reenter', 88)
  if (situation.comboBroken && distance <= (config.pvp?.decisionComboReentryRange || 4.2)) return action('reposition', situation.comboBreakReason || 'combo_broken', 82)
  if (state.tooClose && situation.hitConfirmed && !situation.finish) return action('back_up', 'too_close_after_hit', 80)
  if (state.tooClose && !attackReady && !situation.finish) return action('back_up', 'too_close_no_cooldown', 78)
  if (situation.pressure && health <= (config.pvp?.shieldDecisionHealth || 12) && hasShield(bot) && !situation.enemyAxe && distance <= 4.6) return action('shield_block', 'pressure_block_window', 76)
  if (enemyRanged && distance > (spacing.hit || 3.35) + 0.5 && hasShield(bot) && targetFacingBot(bot, target, config.pvp?.preShotFacingDot || 0.42)) return action('shield_block', 'ranged_line_block', 72)
  if (situation.targetHigh && distance <= (config.pvp?.buildUpRange || 8.5) && Math.abs(ctx.verticalGap || 0) >= (config.pvp?.buildUpVerticalGap || 3.1)) return action('use_terrain', 'target_height_advantage', 70)
  if ((situation.targetShielding || situation.opponentShieldTurtle || situation.opponentBaiter) && hasAxe(bot) && distance <= (config.pvp?.axePressureRange || 3.65)) return action('switch_weapon', 'shield_axe_punish', 68)

  if (situation.comboMomentum && !situation.crystalReady) {
    const minPress = config.pvp?.comboPressMinRange || Math.max(1.7, (spacing.min || 2.1) - 0.1)
    const maxPress = config.pvp?.comboPressMaxRange || Math.min(3.05, (spacing.max || 3.1) + 0.1)
    if (distance < minPress && !situation.finish) return action('back_up', 'combo_spacing_s_tap', 74)
    if (distance <= maxPress) return attackReady ? action('attack', 'combo_confirmed_swing', 73) : action('strafe', 'combo_hold_sweet_spot', 66)
    return action('chase', 'combo_predicted_intercept', 65)
  }

  if (situation.hitConfirmed && !situation.crystalReady) {
    if (distance <= (spacing.hit || 3.35) && !state.tooClose) return attackReady ? action('attack', 'hit_confirm_rehit', 69) : action('strafe', 'hit_confirm_spacing', 60)
    if (distance <= (config.pvp?.hitConfirmChaseRange || 5.2)) return action('chase', 'hit_confirm_chase', 58)
  }

  if (attackReady && state.inHitRange && !shouldDelayMeleeForTiming(situation, distance, config) && !shouldHoldAntiBait(situation, distance, attackReady, config, bot)) {
    return action('attack', state.tooClose ? 'point_blank_punish_then_reset' : 'good_spacing_attack', 62)
  }
  if (shouldHoldAntiBait(situation, distance, attackReady, config, bot)) return action('reposition', antiBaitReason(situation, distance, config), 57)
  if (state.tooFar) return action('chase', situation.predictedTargetPosition ? 'predicted_intercept' : 'close_distance', 52)
  if (state.close && !situation.finish) return action('back_up', 'restore_optimal_spacing', 48)
  if (situation.runner || situation.opponentKiter || situation.opponentRanged) return action('chase', 'deny_space', 45)
  return action('strafe', state.inSweetSpot ? 'hold_sweet_spot' : 'angle_change', 30)
}

function combatDecisionSignature (decision = {}, situation = {}) {
  return `${decision.action || 'none'}:${decision.reason || 'none'}:${situation.spacingState?.label || 'unknown'}`
}

function shouldRecordCombatDecision (signature, now, lastSignature, lastAt, config = {}) {
  if (config.pvp?.combatDebugDecisions === false) return false
  if (signature !== lastSignature) return true
  return now - lastAt >= (config.pvp?.combatDecisionRecordCooldownMs || 520)
}

function pruneDamageWindow (window, now, config = {}) {
  const maxAge = config.pvp?.comboDamageWindowMs || 2200
  while (window.length && now - window[0].at > maxAge) window.shift()
}

function recentDamageAmount (window) {
  return window.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
}

function distanceTrendFrom (previousDistance, distance) {
  if (!Number.isFinite(previousDistance) || !Number.isFinite(distance)) return 0
  return distance - previousDistance
}

function isTargetRunning (bot, target, distance, trend, config = {}) {
  if (!target?.isValid || distance < (config.pvp?.runnerMinDistance || 4.8)) return false
  if (trend < (config.pvp?.runnerDistanceTrend || 0.45)) return false
  const velocity = target.velocity || new Vec3(0, 0, 0)
  const dx = target.position.x - bot.entity.position.x
  const dz = target.position.z - bot.entity.position.z
  const length = Math.sqrt(dx * dx + dz * dz)
  if (length < 0.001) return false
  const away = (velocity.x * dx + velocity.z * dz) / length
  return away > (config.pvp?.runnerAwayVelocity || 0.06)
}

function shouldTacticalReset (situation, distance, attackReady, now, lastResetAt, config = {}) {
  if (!situation?.playerFight) return false
  if ((situation.hitConfirmed || situation.comboMomentum) && !situation.crystalReady) return false
  const aggression = pvpAggression(config)
  if (attackReady && distance <= (situation.spacing?.hit || 3.35) + (aggression >= 1.25 ? 0.45 : 0)) return false
  if (now - lastResetAt < (config.pvp?.tacticalResetCooldownMs || 650) * aggressionCooldownScale(aggression)) return false
  if (situation.crystalReady && distance < (config.pvp?.antiCrystalResetRange || 4.4)) return true
  if (situation.pressure && distance < (config.pvp?.pressureResetRange || 4.8)) return true
  if (situation.outgeared && !situation.counterWindow && distance < (config.pvp?.outgearedResetRange || 3.25)) return true
  return false
}

function shouldBackpedalFromCombo (situation = {}, distance = 99, spacing = {}, config = {}) {
  if (config.pvp?.backpedalModeEnabled === false) return false
  if (situation.comboMomentum) return false
  const maxRange = config.pvp?.backpedalMaxRange ?? Math.min(spacing?.max || 3.85, 3.45)
  if (distance > maxRange) return false
  const comboHits = situation.comboHits || 0
  const comboDamage = situation.comboDamage || 0
  const minHits = config.pvp?.backpedalMinComboHits ?? 2
  const minDamage = config.pvp?.backpedalMinComboDamage ?? 4.5
  if (situation.comboed && (comboHits >= minHits || comboDamage >= minDamage)) return true
  if (config.pvp?.backpedalOnCrystalReady === true && situation.crystalReady) return true
  if (config.pvp?.backpedalOnPressure === true && situation.pressure && !situation.counterWindow) return true
  return false
}

function shouldBackpedalTacticalReset (situation = {}, config = {}) {
  if (config.pvp?.tacticalResetBackpedal === true) return true
  if (situation.crystalReady) return true
  const comboDamage = situation.comboDamage || 0
  const comboHits = situation.comboHits || 0
  if (situation.badlyOutgeared && situation.botLow) return true
  return comboHits >= (config.pvp?.tacticalResetBackpedalMinHits ?? 3) ||
    comboDamage >= (config.pvp?.tacticalResetBackpedalMinDamage ?? 7)
}

function shouldPressureAtArenaEdge (botArenaDistance, targetArenaDistance, distance, spacing, arenaRadius, arenaMargin, config = {}, options = {}) {
  if (config.pvp?.arenaEdgePressure === false) return false
  if (!options.forceEngage && config.pvp?.arenaEdgePressure !== true) return false
  const botGrace = config.pvp?.arenaBotGraceRadius ?? 6
  const targetGrace = config.pvp?.arenaTargetGraceRadius ?? 8
  const chaseRange = config.pvp?.arenaOutsideChaseRange || Math.max(12, (spacing?.max || 4) + 8)
  if (botArenaDistance > arenaRadius + botGrace) return false
  if (targetArenaDistance > arenaRadius + arenaMargin + targetGrace) return false
  return distance <= chaseRange
}

function resolveArenaCenter (options = {}, config = {}, start) {
  if (options.arenaCenter) return asVec3(options.arenaCenter)
  if (options.forceEngage && config.pvp?.dynamicArenaCenterForForcedFights !== false) return start.clone()
  return asVec3(config.pvp?.arenaCenter || start)
}

async function tacticalReset (bot, target, config = {}, situation = {}) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
  const strafeRight = Math.random() > 0.5
  const backpedal = shouldBackpedalTacticalReset(situation, config) || dangerousCombatFooting(bot)
  bot.setControlState('back', backpedal)
  bot.setControlState('forward', !backpedal && situation.counterWindow && Math.random() < (config.pvp?.lateralResetForwardTapChance ?? 0.35))
  bot.setControlState('sprint', true)
  bot.setControlState('left', !strafeRight)
  bot.setControlState('right', strafeRight)
  if (situation.crystalReady || dangerousCombatFooting(bot)) bot.setControlState('sneak', true)
  await sleep(situation.crystalReady ? (config.pvp?.antiCrystalBackMs || 260) : (config.pvp?.pressureResetMs || 240))
  bot.setControlState('back', false)
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sneak', false)
}

async function nudgeTowardArenaCenter (bot, arenaCenter, target, config = {}) {
  bot.pathfinder?.stop()
  const dx = arenaCenter.x - bot.entity.position.x
  const dz = arenaCenter.z - bot.entity.position.z
  await faceVector(bot, dx, dz).catch(() => {})
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  if (target?.isValid && bot.entity.position.distanceTo(target.position) < 2.6) {
    const strafeRight = Math.random() > 0.5
    bot.setControlState('left', !strafeRight)
    bot.setControlState('right', strafeRight)
  }
  await sleep(config.pvp?.arenaNudgeMs || 260)
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
}

function shouldBaitShield (situation, distance, attackReady, now, lastBaitAt, config = {}) {
  if (!(situation?.targetShielding || situation?.opponentShieldTurtle) || situation.finish || situation.comboMomentum) return false
  if (distance > (config.pvp?.shieldBaitRange || 4.25)) return false
  if (attackReady) return false
  return now - lastBaitAt >= (config.pvp?.shieldBaitCooldownMs || 900)
}

async function baitShield (bot, target, config = {}) {
  bot.pathfinder?.stop()
  await equipBestCombatWeapon(bot, target, { preferAxe: true, playerFight: true }).catch(() => null)
  if (target?.isValid) await bot.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
  bot.setControlState('back', true)
  bot.setControlState('right', true)
  bot.setControlState('sprint', false)
  await sleep(config.pvp?.shieldBaitMs || 210)
  bot.setControlState('back', false)
  bot.setControlState('right', false)
}

function createMovementState (config = {}) {
  return {
    strafe: Math.random() > 0.5 ? 1 : -1,
    nextChangeAt: Date.now() + randomInt(config.pvp?.moveStrafeMinMs || 260, config.pvp?.moveStrafeMaxMs || 920),
    mode: 'circle',
    modeUntil: 0,
    lastMode: null,
    lastRawPosition: null,
    lastRawMoveAt: 0,
    rawStuckSince: 0,
    lastRawCorrectionAt: 0,
    lastRawCorrectionReason: null,
    lastStrafeCancelAt: 0,
    lastParkourAt: 0,
    lastParkourRecordAt: 0,
    recentParkourKinds: [],
    recentModes: [],
    recentDirections: []
  }
}

function updateMovementState (state, situation = {}, distance = 0, now = Date.now(), config = {}) {
  if (now < state.nextChangeAt && now < state.modeUntil) return state
  const previous = state.mode
  if (now >= state.nextChangeAt) {
    if (Math.random() < (config.pvp?.moveDirectionFlipChance ?? 0.72)) state.strafe *= -1
    if (config.pvp?.movementMemoryEnabled !== false) {
      const memory = Math.max(2, config.pvp?.moveRecentDirectionMemory || 3)
      const recent = state.recentDirections.slice(-memory)
      if (recent.length >= memory && recent.every(dir => dir === state.strafe)) state.strafe *= -1
      rememberLimited(state.recentDirections, state.strafe, memory + 1)
    }
    state.nextChangeAt = now + randomInt(config.pvp?.moveStrafeMinMs || 260, config.pvp?.moveStrafeMaxMs || 920)
  }
  if (now >= state.modeUntil) {
    state.mode = chooseMovementMode(situation, distance, config, previous, state)
    state.lastMode = previous
    state.modeUntil = now + randomInt(config.pvp?.moveModeMinMs || 180, config.pvp?.moveModeMaxMs || 620)
    if (state.mode === previous && Math.random() < 0.55) state.strafe *= -1
    if (config.pvp?.movementMemoryEnabled !== false) rememberLimited(state.recentModes, state.mode, Math.max(3, config.pvp?.moveRecentModeMemory || 4) + 1)
  }
  return state
}

function chooseMovementMode (situation = {}, distance = 0, config = {}, previous = null, state = null) {
  const modes = []
  const add = (mode, weight) => {
    if (mode === previous) weight *= 0.35
    if (config.pvp?.movementMemoryEnabled !== false && state?.recentModes?.length) {
      const recentPenalty = movementRecencyPenalty(mode, state.recentModes, config)
      weight *= recentPenalty
    }
    if (weight > 0) modes.push({ mode, weight })
  }
  const backpedal = shouldBackpedalFromCombo(situation, distance, situation.spacing, config)
  const aggression = pvpAggression(config)
  const pressWeight = aggression >= 1.25 && distance > (situation.spacing?.min || 2.4)
    ? (config.pvp?.movePressWeight ?? 3.4) * aggression
    : 0
  const decision = situation.combatDecision?.action || null
  const spacingLabel = situation.spacingState?.label || null
  if (decision === 'heal_eat' || decision === 'disengage' || decision === 'back_up') {
    add('micro_back', decision === 'back_up' && spacingLabel === 'too_close' ? 6.5 : 4.8)
    add('diagonal_back', 4.6)
    add('angle_change', 2.4)
    add('orbit', config.pvp?.movePressureOrbitWeight ?? 2.6)
    add('pause', decision === 'back_up' ? 0.4 : 1.1)
    return weightedChoice(modes) || 'micro_back'
  }
  if (decision === 'reposition' || decision === 'shield_block' || decision === 'use_terrain') {
    add('angle_change', 5.2)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('fakeout', 3.6)
    add('micro_back', distance < (situation.spacing?.sweet || 3.1) ? 2.6 : 0.7)
    add('pause', config.pvp?.movePauseWeight ?? 0.6)
    return weightedChoice(modes) || 'angle_change'
  }
  if (decision === 'chase') {
    add('diagonal_press', (config.pvp?.moveDiagonalPressWeight ?? 4.2) + pressWeight * 0.9)
    add('press', pressWeight * 1.25 + 2)
    add('forward_tap', distance > (situation.spacing?.hit || 3.2) ? 3.6 : 1)
    add('orbit', (config.pvp?.moveOrbitWeight ?? 2.2) * 0.8)
    return weightedChoice(modes) || 'diagonal_press'
  }
  if (decision === 'attack' || decision === 'switch_weapon') {
    add(spacingLabel === 'too_close' ? 'micro_back' : 'diagonal_press', spacingLabel === 'too_close' ? 4.4 : 5.4)
    add('press', pressWeight * 1.2 + 2.2)
    add('forward_tap', 3.8)
    add('angle_change', 1.5)
    return weightedChoice(modes) || 'press'
  }
  if (decision === 'strafe') {
    add('angle_change', 4.8)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 3.2)
    add('pause', config.pvp?.movePauseWeight ?? 0.7)
    add('fakeout', 1.7)
    return weightedChoice(modes) || 'angle_change'
  }
  if (situation.antiBaitHold || (situation.tradeLost && !situation.comboMomentum)) {
    add('fakeout', 4.5)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('diagonal_back', distance < (situation.spacing?.sweet || 3.1) ? 2.5 : 0.8)
    add('circle', 2.2)
    add('press', situation.counterWindow ? pressWeight * 0.55 : 0)
    return weightedChoice(modes) || 'fakeout'
  }
  if (situation.comboMomentum && !situation.crystalReady) {
    if (spacingLabel === 'too_close') {
      add('micro_back', 5.2)
      add('angle_change', 2.5)
    }
    add('diagonal_press', config.pvp?.moveDiagonalPressWeight ?? 4.2)
    add('press', pressWeight * 2 + 3.5)
    add('forward_tap', 5.2)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 0.8)
    add('fakeout', 0.25)
    return weightedChoice(modes) || 'press'
  }
  if (situation.hitConfirmed && !situation.crystalReady) {
    if (spacingLabel === 'too_close') add('micro_back', 4.4)
    add('diagonal_press', config.pvp?.moveDiagonalPressWeight ?? 4.2)
    add('press', pressWeight * 1.7 + 2.5)
    add('forward_tap', 4.2)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 1.2)
    add('fakeout', 0.5)
    return weightedChoice(modes) || 'press'
  }
  if (config.pvp?.highPressureMeleeMode && !situation.pressure && !situation.crystalReady && !situation.antiBaitHold && !situation.tradeLost) {
    add('press', pressWeight * 1.7 + 2.2)
    add('forward_tap', 4.6)
    add('circle', 1.1)
    add('orbit', (config.pvp?.moveOrbitWeight ?? 1) * 0.45)
    add('fakeout', 0.4)
    return weightedChoice(modes) || 'press'
  }
  if ((situation.opponentRanged || situation.opponentKiter) && !situation.pressure && !situation.crystalReady) {
    add('press', pressWeight * 1.45 + 1.8)
    add('forward_tap', distance > (situation.spacing?.hit || 3.2) ? 3.6 : 1.4)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 1.5)
    add('fakeout', 0.8)
    return weightedChoice(modes) || 'press'
  }
  if (situation.outgeared || situation.pressure || situation.comboed) {
    add('diagonal_back', backpedal ? 3.5 : 0)
    add('press', !backpedal && !situation.badlyOutgeared && distance <= (situation.spacing?.max || 4.2) + 0.8 ? pressWeight * 0.65 : 0)
    add('orbit', config.pvp?.movePressureOrbitWeight ?? 3)
    add('fakeout', 4)
    add('circle', 3)
    add('forward_tap', distance > (situation.spacing?.sweet || 3.5) ? 1.8 : 0.45)
  } else if (situation.counterWindow || situation.finish) {
    add('press', pressWeight * 1.25)
    add('forward_tap', 4)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 3)
    add('fakeout', 1.5)
  } else if (situation.enemyAxe || situation.targetShielding) {
    add('press', situation.targetShielding ? pressWeight * 0.9 : pressWeight * 0.55)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 4)
    add('fakeout', 3)
    add('diagonal_back', backpedal ? 1.4 : 0)
  } else {
    add('press', pressWeight)
    add('orbit', config.pvp?.moveOrbitWeight ?? 2.2)
    add('circle', 4)
    add('fakeout', 2.5)
    add('forward_tap', 1.8)
    add('diagonal_back', backpedal ? 0.8 : 0)
  }
  return weightedChoice(modes) || 'circle'
}

function movementRecencyPenalty (mode, recentModes = [], config = {}) {
  const memory = Math.max(2, config.pvp?.moveRecentModeMemory || 4)
  const penalty = clamp(config.pvp?.moveRepeatPenalty ?? 0.45, 0.1, 1)
  const recent = recentModes.slice(-memory)
  let factor = 1
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i] !== mode) continue
    const age = recent.length - i
    factor *= Math.max(penalty, 1 - (memory - age + 1) * 0.18)
  }
  return factor
}

function rememberLimited (items, value, limit) {
  items.push(value)
  while (items.length > limit) items.shift()
}

function movementSignature (movement = {}) {
  return `${movement.mode || 'circle'}:${movement.strafe || 1}`
}

function weightedChoice (items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const item of items) {
    roll -= item.weight
    if (roll <= 0) return item.mode
  }
  return items[items.length - 1]?.mode || null
}

async function sustainCombatMovement (bot, target, movement, situation, spacing, config = {}, durationMs = 90, signal = null, options = {}) {
  const tickMs = Math.max(30, config.pvp?.combatMovementTickMs || 50)
  const endAt = Date.now() + Math.max(0, durationMs)
  while (!signal?.cancelled && target?.isValid && Date.now() < endAt) {
    const distance = bot.entity.position.distanceTo(target.position)
    situation.spacingState = spacingState(distance, spacing, config)
    updateMovementState(movement, situation, distance, Date.now(), config)
    const correction = updateRawMovementCorrection(bot, target, movement, situation, distance, spacing, config)
    if (correction && shouldRecordRawMovementCorrection(movement, correction, config)) {
      recordTraining(options, 'raw_movement_correction', {
        reason: correction,
        mode: movement.mode,
        strafe: movement.strafe,
        distance: roundMetric(distance, 2),
        spacing: situation.spacingState?.label || null,
        enemyPattern: situation.enemyMovementPattern || null
      })
      movement.lastRawCorrectionReason = correction
    }
    await combatLookAt(bot, target, config, situation).catch(() => {})
    const parkour = combatParkourCandidate(bot, target, movement, situation, distance, spacing, config, Date.now())
    if (parkour) {
      const usedParkour = await performCombatParkour(bot, target, movement, parkour, config).catch(() => false)
      if (usedParkour) {
        recordTraining(options, 'combat_parkour', {
          kind: parkour.kind,
          reason: parkour.reason,
          risk: parkour.risky,
          drop: roundMetric(parkour.drop || 0, 2),
          block: parkour.block || null,
          distance: roundMetric(distance, 2),
          enemyFacing: parkour.enemyFacing,
          swingIncoming: parkour.swingIncoming
        })
        continue
      }
    }
    applyTacticalMovement(bot, target, distance, spacing, movement, situation, config)
    await sleep(Math.min(tickMs, Math.max(0, endAt - Date.now())))
  }
}

function shouldRecordRawMovementCorrection (movement = {}, reason, config = {}) {
  const now = Date.now()
  if (movement.lastRawCorrectionReason === reason && now - (movement.lastRawCorrectionRecordAt || 0) < (config.pvp?.rawMovementRecordCooldownMs || 700)) return false
  movement.lastRawCorrectionRecordAt = now
  return true
}

function updateRawMovementCorrection (bot, target, movement, situation = {}, distance = 99, spacing = {}, config = {}) {
  if (!shouldUseRawPvpMovement(distance, spacing, situation, config)) return null
  const now = Date.now()
  const correctionCooldown = config.pvp?.rawMovementCorrectionCooldownMs || 260
  const pos = bot.entity.position.clone()
  const moved = movement.lastRawPosition ? horizontalDistance(pos, movement.lastRawPosition) : Infinity
  const velocity = horizontalSpeed(bot.entity.velocity || new Vec3(0, 0, 0))
  movement.lastRawPosition = pos
  movement.lastRawMoveAt = now

  if (isForwardControlActive(bot) && velocity <= (config.pvp?.rawMovementStuckSpeed || 0.025) && moved <= (config.pvp?.rawMovementStuckDistance || 0.025)) {
    if (!movement.rawStuckSince) movement.rawStuckSince = now
  } else {
    movement.rawStuckSince = 0
  }

  if (
    movement.rawStuckSince &&
    now - movement.rawStuckSince >= (config.pvp?.rawMovementStuckMs || 240) &&
    now - movement.lastRawCorrectionAt >= correctionCooldown
  ) {
    movement.strafe *= -1
    movement.mode = distance < (spacing.min || 2.4) ? 'micro_back' : 'angle_change'
    movement.modeUntil = now + (config.pvp?.rawMovementCorrectionHoldMs || 220)
    movement.lastRawCorrectionAt = now
    movement.rawStuckSince = 0
    return 'collision_unstick'
  }

  if (shouldStrafeCancel(target, movement, situation, distance, spacing, config, now)) {
    movement.strafe *= -1
    movement.mode = distance < (spacing.sweet || 3.1) ? 'angle_change' : 'diagonal_press'
    movement.modeUntil = now + (config.pvp?.strafeCancelHoldMs || 190)
    movement.lastStrafeCancelAt = now
    movement.lastRawCorrectionAt = now
    return 'strafe_cancel'
  }

  return null
}

function isForwardControlActive (bot) {
  try {
    return Boolean(bot.controlState?.forward || bot.controlState?.back)
  } catch {
    return false
  }
}

function shouldStrafeCancel (target, movement = {}, situation = {}, distance = 99, spacing = {}, config = {}, now = Date.now()) {
  if (config.pvp?.strafeCancelEnabled === false) return false
  if (now - (movement.lastStrafeCancelAt || 0) < (config.pvp?.strafeCancelCooldownMs || 280)) return false
  if (distance > (config.pvp?.strafeCancelRange || Math.max(3.4, (spacing.hit || 3.35) + 0.2))) return false
  const lateral = situation.enemyLateralSpeed || 0
  const mirrored = Math.sign(lateral) === Math.sign(movement.strafe || 1) &&
    Math.abs(lateral) >= (config.pvp?.strafeCancelLateralSpeed || 0.055)
  const closing = (situation.distanceTrend || 0) < -(config.pvp?.strafeCancelClosingTrend || 0.06)
  const facePressure = (situation.enemyLookDot || 0) >= (config.pvp?.strafeCancelLookDot || 0.5) || targetLikelyShielding(target)
  return (mirrored && facePressure) || (closing && situation.spacingState?.close)
}

function shouldUseRawPvpMovement (distance = 99, spacing = {}, situation = {}, config = {}) {
  if (!situation?.playerFight) return false
  if (config.pvp?.rawPvpMovementEnabled === false) return false
  if (situation.combatDecision?.action === 'use_terrain') return false
  const range = config.pvp?.rawPvpMovementRange || Math.max(6.8, (spacing.hit || 3.35) + 3.4)
  return distance <= range
}

function applyRawPredictedChase (bot, target, strafe, distance, spacing, situation = {}, config = {}, preferredMode = 'diagonal_press') {
  bot.pathfinder?.stop()
  const pressModes = new Set(['press', 'diagonal_press', 'forward_tap', 'angle_change'])
  const mode = distance < (spacing.min || 2.4)
    ? 'micro_back'
    : pressModes.has(preferredMode)
      ? preferredMode
      : 'diagonal_press'
  applyMovementMode(bot, mode, strafe, distance, spacing, config)
  if (situation.enemyMovementPattern === 'juking' && distance <= (spacing.hit || 3.35) + 0.6) {
    bot.setControlState('forward', false)
    bot.setControlState('back', distance < (spacing.min || 2.4))
  }
}

function applyTacticalMovement (bot, target, distance, spacing, movement, situation, config = {}) {
  const strafe = typeof movement === 'number' ? movement : movement?.strafe || 1
  const mode = typeof movement === 'number' ? 'circle' : movement?.mode || 'circle'
  if (!situation?.playerFight) {
    applyCombatSpacing(bot, target, distance, spacing, strafe, config)
    return
  }

  if (situation.crystalReady && distance < spacing.min) {
    bot.pathfinder.stop()
    applyBackStrafe(bot, strafe)
    return
  }

  const decision = situation.combatDecision?.action || null
  if (decision === 'heal_eat' || decision === 'disengage' || decision === 'back_up') {
    bot.pathfinder?.stop()
    applyMovementMode(bot, decision === 'back_up' ? 'micro_back' : 'diagonal_back', strafe, distance, spacing, config)
    bot.setControlState('sneak', dangerousCombatFooting(bot))
    return
  }

  if (decision === 'reposition' || decision === 'shield_block') {
    bot.pathfinder?.stop()
    applyMovementMode(bot, distance < (spacing?.min || 2.4) ? 'micro_back' : 'angle_change', strafe, distance, spacing, config)
    return
  }

  if (
    decision === 'chase' &&
    situation.predictedTargetPosition &&
    distance > spacing.hit &&
    distance <= (config.pvp?.decisionPredictionChaseRange || 9)
  ) {
    if (shouldUseRawPvpMovement(distance, spacing, situation, config)) {
      applyRawPredictedChase(bot, target, strafe, distance, spacing, situation, config, mode)
      return
    }
    const point = situation.predictedTargetPosition.floored ? situation.predictedTargetPosition.floored() : asVec3(situation.predictedTargetPosition).floored()
    bot.pathfinder.setGoal(new goals.GoalNear(point.x, point.y, point.z, Math.max(1.1, spacing.hit - 0.25)), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    return
  }

  if (situation.outgeared && !situation.counterWindow && distance < spacing.sweet) {
    bot.pathfinder.stop()
    applyMovementMode(bot, mode === 'forward_tap' ? 'fakeout' : mode, strafe, distance, spacing, config)
    bot.setControlState('sneak', dangerousCombatFooting(bot))
    return
  }

  if (shouldBackpedalFromCombo(situation, distance, spacing, config)) {
    bot.pathfinder.stop()
    applyMovementMode(bot, 'diagonal_back', -strafe, distance, spacing, config)
    return
  }

  if (
    situation.comboMomentum &&
    situation.predictedTargetPosition &&
    distance > spacing.hit + (config.pvp?.comboPredictionChaseExtraRange || 0.25) &&
    distance <= (config.pvp?.comboPredictionChaseRange || 6.5)
  ) {
    if (shouldUseRawPvpMovement(distance, spacing, situation, config)) {
      applyRawPredictedChase(bot, target, strafe, distance, spacing, situation, config, mode)
      return
    }
    const point = situation.predictedTargetPosition.floored ? situation.predictedTargetPosition.floored() : asVec3(situation.predictedTargetPosition).floored()
    bot.pathfinder.setGoal(new goals.GoalNear(point.x, point.y, point.z, Math.max(1.1, spacing.hit - 0.35)), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    return
  }

  if (
    situation.arenaEdgePressure &&
    situation.arenaCenter &&
    config.pvp?.arenaCutoffEnabled !== false &&
    distance > spacing.hit
  ) {
    if (shouldUseRawPvpMovement(distance, spacing, situation, config)) {
      applyRawPredictedChase(bot, target, strafe, distance, spacing, situation, config, mode)
      return
    }
    const point = arenaCutoffPoint(target, situation.arenaCenter, spacing, config)
    bot.pathfinder.setGoal(new goals.GoalNear(point.x, point.y, point.z, Math.max(1.2, spacing.hit - 0.2)), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    return
  }

  if (situation.runner && distance <= (config.pvp?.cutoffRange || 13) && distance > spacing.max) {
    if (shouldUseRawPvpMovement(distance, spacing, situation, config)) {
      applyRawPredictedChase(bot, target, strafe, distance, spacing, situation, config, mode)
      return
    }
    const point = predictedCutoffPoint(bot, target, distance, config)
    bot.pathfinder.setGoal(new goals.GoalNear(point.x, point.y, point.z, Math.max(1.5, spacing.sweet)), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    return
  }

  if (situation.finish && distance > spacing.hit && distance <= (config.pvp?.finishChaseRange || 10)) {
    if (shouldUseRawPvpMovement(distance, spacing, situation, config)) {
      applyRawPredictedChase(bot, target, strafe, distance, spacing, situation, config, mode)
      return
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(target, Math.max(1.8, spacing.hit - 0.25)), true)
    bot.setControlState('sprint', true)
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    return
  }

  if (distance <= spacing.max) {
    bot.pathfinder.stop()
    applyMovementMode(bot, mode, strafe, distance, spacing, config)
    return
  }

  applyCombatSpacing(bot, target, distance, spacing, strafe, config)
}

function applyBackStrafe (bot, strafe) {
  bot.setControlState('forward', false)
  bot.setControlState('back', true)
  bot.setControlState('left', strafe < 0)
  bot.setControlState('right', strafe > 0)
  bot.setControlState('sprint', true)
}

function applyMovementMode (bot, mode, strafe, distance, spacing, config = {}) {
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('sprint', true)
  bot.setControlState('jump', false)

  if (mode === 'diagonal_back') {
    bot.setControlState('back', true)
    bot.setControlState(strafe > 0 ? 'right' : 'left', true)
    return
  }
  if (mode === 'micro_back') {
    bot.setControlState('back', true)
    bot.setControlState(strafe > 0 ? 'right' : 'left', true)
    bot.setControlState('sprint', true)
    return
  }
  if (mode === 'pause') {
    bot.setControlState('sprint', false)
    return
  }
  if (mode === 'angle_change') {
    bot.setControlState(strafe > 0 ? 'right' : 'left', true)
    bot.setControlState('forward', distance > (spacing?.sweet || 3.1) + 0.25)
    bot.setControlState('back', distance < (spacing?.min || 2.4) - 0.05)
    bot.setControlState('sprint', distance > (spacing?.min || 2.4) - 0.2)
    return
  }
  if (mode === 'diagonal_press') {
    bot.setControlState('forward', distance > (spacing?.min || 2.4) - 0.05)
    bot.setControlState(strafe > 0 ? 'right' : 'left', distance <= (spacing?.max || 3.6) + 1.1)
    bot.setControlState('back', distance < (spacing?.min || 2.4) - 0.35)
    bot.setControlState('sprint', true)
    return
  }
  if (mode === 'fakeout') {
    bot.setControlState(strafe > 0 ? 'right' : 'left', true)
    if (distance < (spacing?.min || 2.4)) bot.setControlState('back', true)
    return
  }
  if (mode === 'orbit') {
    bot.setControlState(strafe > 0 ? 'right' : 'left', true)
    bot.setControlState('forward', distance > (spacing?.sweet || 3.1) + 0.35)
    bot.setControlState('back', distance < (spacing?.min || 2.4) - 0.1)
    return
  }
  if (mode === 'press') {
    bot.setControlState('forward', distance > (spacing?.min || 2.4) - 0.2)
    bot.setControlState(strafe > 0 ? 'right' : 'left', distance <= (spacing?.max || 3.6) + 0.8)
    bot.setControlState('back', distance < (spacing?.min || 2.4) - 0.45)
    bot.setControlState('sprint', true)
    return
  }
  if (mode === 'forward_tap') {
    bot.setControlState('forward', true)
    bot.setControlState(strafe > 0 ? 'right' : 'left', distance < (spacing?.hit || 3.35))
    bot.setControlState('sprint', distance > (config.pvp?.moveForwardTapSprintRange || 2.7))
    return
  }
  applyStrafe(bot, strafe)
  bot.setControlState('forward', distance > (spacing?.sweet || 3.1) + 0.15)
  bot.setControlState('back', distance < (spacing?.min || 2.4))
}

function combatParkourCandidate (bot, target, movement = {}, situation = {}, distance = 99, spacing = {}, config = {}, now = Date.now()) {
  if (config.pvp?.pvpParkourEnabled === false) return null
  if (!situation?.playerFight || target?.type !== 'player' || !target?.isValid) return null
  if (!bot.entity?.onGround || bot.entity?.elytraFlying) return null
  if (dangerousCombatFooting(bot) || situation.crystalReady) return null
  if (!hasTotem(bot) && (bot.health || 20) < (config.pvp?.noTotemParkourMinHealth ?? config.pvp?.pvpParkourMinHealth ?? 13)) return null
  if ((bot.health || 20) < (config.pvp?.pvpParkourMinHealth || 9) && !hasTotem(bot)) return null

  const minRange = config.pvp?.pvpParkourMinRange || 1.8
  const maxRange = config.pvp?.pvpParkourMaxRange || Math.max(7.5, (spacing?.hit || 3.35) + 4)
  if (distance < minRange || distance > maxRange) return null

  const swingIncoming = typeof situation.opponentSwingAgeMs === 'number' &&
    situation.opponentSwingAgeMs >= 0 &&
    situation.opponentSwingAgeMs <= (config.pvp?.pvpParkourSwingWindowMs || 360)
  const enemyFacing = targetFacingBot(bot, target, config.pvp?.pvpParkourFacingDot || 0.48) ||
    (situation.enemyLookDot || 0) >= (config.pvp?.pvpParkourFacingDot || 0.48)
  const reason = parkourReason(situation, distance, spacing, config, enemyFacing, swingIncoming)
  if (!reason) return null

  const cooldown = (config.pvp?.pvpParkourCooldownMs || 520) * (swingIncoming ? 0.6 : 1)
  if (now - (movement.lastParkourAt || 0) < cooldown) return null

  const candidates = [
    ...parkourSideHopCandidates(bot, target, movement, situation, distance, spacing, config, reason, enemyFacing, swingIncoming),
    ...parkourVaultCandidates(bot, target, movement, situation, distance, spacing, config, reason, enemyFacing, swingIncoming),
    ...parkourCoverCandidates(bot, target, movement, situation, distance, spacing, config, reason, enemyFacing, swingIncoming)
  ].filter(Boolean)

  if (!candidates.length) return null
  for (const candidate of candidates) {
    candidate.score *= parkourRecencyPenalty(candidate.kind, movement.recentParkourKinds, config)
  }
  return weightedParkourChoice(candidates)
}

function parkourReason (situation = {}, distance = 99, spacing = {}, config = {}, enemyFacing = false, swingIncoming = false) {
  if (swingIncoming && distance <= (config.pvp?.pvpParkourSwingRange || Math.max(4.2, (spacing.hit || 3.35) + 0.9))) return 'enemy_swing_juke'
  if (enemyFacing && distance <= (config.pvp?.pvpParkourFacingRange || Math.max(5.8, (spacing.hit || 3.35) + 2.2))) return 'break_crosshair'
  if (situation.combatDecision?.action === 'use_terrain' || situation.targetHigh) return 'vertical_aim_break'
  if ((situation.comboed || situation.tradeLost) && distance <= (spacing.max || 3.8) + 1.2) return 'combo_escape_angle'
  if (situation.comboMomentum && Math.random() < (config.pvp?.pvpParkourComboChance ?? 0.22)) return 'combo_angle_mix'
  if (Math.random() < (config.pvp?.pvpParkourOpportunisticChance ?? 0.08)) return 'unpredictable_terrain_juke'
  return null
}

function parkourSideHopCandidates (bot, target, movement = {}, situation = {}, distance = 99, spacing = {}, config = {}, reason = 'juke', enemyFacing = false, swingIncoming = false) {
  const side = movement.strafe || 1
  return [side, -side].map((direction, index) => {
    const basis = combatHorizontalBasis(bot, target)
    const lateralStep = config.pvp?.pvpParkourSideStep || 1.45
    const forwardBias = reason === 'combo_escape_angle'
      ? -0.25
      : distance > (spacing?.sweet || 3.1)
        ? (config.pvp?.pvpParkourForwardBias ?? 0.5)
        : 0.15
    const pos = bot.entity.position.offset(
      basis.right.x * direction * lateralStep + basis.forward.x * forwardBias,
      0,
      basis.right.z * direction * lateralStep + basis.forward.z * forwardBias
    ).floored()
    const safety = parkourStandSafety(bot, pos, config)
    if (!parkourRiskAllowed(bot, safety, config, situation)) return null
    const targetDistance = horizontalDistance(safety.pos, target.position)
    if (targetDistance < (spacing?.min || 2.4) - 0.55) return null
    return {
      kind: safety.drop > 0 ? 'drop_side_hop' : 'side_hop',
      reason,
      side: direction,
      controls: {
        forward: forwardBias > 0.05,
        back: forwardBias < -0.05,
        side: direction
      },
      jump: true,
      risky: safety.risky,
      drop: safety.drop,
      enemyFacing,
      swingIncoming,
      score: safety.score + (swingIncoming ? 4 : 0) + (enemyFacing ? 2 : 0) + (index === 0 ? 0.6 : 0)
    }
  })
}

function parkourVaultCandidates (bot, target, movement = {}, situation = {}, distance = 99, spacing = {}, config = {}, reason = 'juke', enemyFacing = false, swingIncoming = false) {
  if (Math.random() > (config.pvp?.pvpParkourVaultChance ?? 0.58) && reason !== 'vertical_aim_break') return []
  const basis = combatHorizontalBasis(bot, target)
  const side = movement.strafe || 1
  const directions = [
    { forward: 1, side, weight: 1.2 },
    { forward: 1, side: -side, weight: 0.85 },
    { forward: 0, side, weight: 0.65 },
    { forward: 0, side: -side, weight: 0.45 }
  ]
  const base = bot.entity.position.floored()
  return directions.map(direction => {
    const x = basis.forward.x * direction.forward + basis.right.x * direction.side
    const z = basis.forward.z * direction.forward + basis.right.z * direction.side
    const step = base.offset(Math.sign(x), 0, Math.sign(z))
    const block = bot.blockAt(step)
    if (!block || isPassable(block) || dangerousBlockNear(bot, step)) return null
    const stand = step.offset(0, 1, 0)
    const safety = parkourStandSafety(bot, stand, config)
    if (!parkourRiskAllowed(bot, safety, config, situation)) return null
    if ((safety.pos.y - base.y) > 1) return null
    const targetDistance = horizontalDistance(safety.pos, target.position)
    if (targetDistance < (spacing?.min || 2.4) - 0.4) return null
    return {
      kind: 'block_vault',
      reason,
      block: block.name,
      controls: {
        forward: direction.forward > 0,
        back: false,
        side: direction.side
      },
      jump: true,
      risky: safety.risky,
      drop: safety.drop,
      enemyFacing,
      swingIncoming,
      score: safety.score + direction.weight + (reason === 'vertical_aim_break' ? 3.5 : 0) + (enemyFacing ? 1.3 : 0)
    }
  })
}

function parkourCoverCandidates (bot, target, movement = {}, situation = {}, distance = 99, spacing = {}, config = {}, reason = 'juke', enemyFacing = false, swingIncoming = false) {
  if (!enemyFacing && reason !== 'vertical_aim_break' && Math.random() > (config.pvp?.pvpParkourCoverChance ?? 0.55)) return []
  const radius = Math.max(1, Math.round(config.pvp?.pvpParkourScanRadius || 3))
  const base = bot.entity.position.floored()
  const candidates = []
  for (let y = -1; y <= 1; y++) {
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        if (Math.abs(x) + Math.abs(z) < 1 || Math.sqrt(x * x + z * z) > radius) continue
        const blockPos = base.offset(x, y, z)
        const block = bot.blockAt(blockPos)
        if (!block || isPassable(block) || dangerousBlockNear(bot, blockPos)) continue
        const blockCenter = blockPos.offset(0.5, 0.5, 0.5)
        const away = horizontalUnit(blockCenter, target.position)
        if (!away) continue
        const stand = blockPos.offset(Math.round(away.x), 0, Math.round(away.z))
        const safety = parkourStandSafety(bot, stand, config)
        if (!parkourRiskAllowed(bot, safety, config, situation)) continue
        if (horizontalDistance(safety.pos, bot.entity.position) > radius + 1.2) continue
        const segmentDistance = pointSegmentDistance2D(blockCenter, target.position, safety.pos)
        if (segmentDistance > (config.pvp?.pvpParkourCoverLineDistance || 1.05)) continue
        const controls = controlsTowardParkourPoint(bot, target, safety.pos)
        candidates.push({
          kind: 'cover_juke',
          reason,
          block: block.name,
          controls,
          jump: safety.pos.y > base.y,
          risky: safety.risky,
          drop: safety.drop,
          enemyFacing,
          swingIncoming,
          score: safety.score + Math.max(0, 2.2 - segmentDistance) * 2.2 + (enemyFacing ? 2 : 0) + (reason === 'vertical_aim_break' ? 2.5 : 0)
        })
      }
    }
  }
  return candidates
}

function performParkourControls (bot, controls = {}) {
  bot.setControlState('forward', Boolean(controls.forward))
  bot.setControlState('back', Boolean(controls.back))
  bot.setControlState('left', controls.side < 0)
  bot.setControlState('right', controls.side > 0)
  bot.setControlState('sprint', true)
}

async function performCombatParkour (bot, target, movement = {}, candidate = null, config = {}) {
  if (!candidate || !target?.isValid || !bot.entity?.onGround) return false
  movement.lastParkourAt = Date.now()
  rememberLimited(movement.recentParkourKinds, candidate.kind, Math.max(3, config.pvp?.pvpParkourRecentMemory || 5))
  bot.pathfinder?.stop()
  await combatLookAt(bot, target, config, { pressure: true, predictedTargetPosition: target.position }, { attack: false }).catch(() => {})
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  performParkourControls(bot, candidate.controls)
  if (candidate.jump && bot.entity.onGround) bot.setControlState('jump', true)
  await sleep(candidate.jump ? (config.pvp?.pvpParkourJumpPulseMs || 145) : (config.pvp?.pvpParkourPulseMs || 155))
  bot.setControlState('jump', false)
  await sleep(config.pvp?.pvpParkourFollowThroughMs ?? 45)
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sprint', false)
  return true
}

function combatHorizontalBasis (bot, target) {
  const dx = target.position.x - bot.entity.position.x
  const dz = target.position.z - bot.entity.position.z
  const length = Math.max(0.001, Math.sqrt(dx * dx + dz * dz))
  const forward = { x: dx / length, z: dz / length }
  return {
    forward,
    right: { x: forward.z, z: -forward.x }
  }
}

function controlsTowardParkourPoint (bot, target, point) {
  const basis = combatHorizontalBasis(bot, target)
  const dx = point.x + 0.5 - bot.entity.position.x
  const dz = point.z + 0.5 - bot.entity.position.z
  const forwardDot = dx * basis.forward.x + dz * basis.forward.z
  const rightDot = dx * basis.right.x + dz * basis.right.z
  return {
    forward: forwardDot > 0.2,
    back: forwardDot < -0.2,
    side: Math.abs(rightDot) > 0.2 ? Math.sign(rightDot) : 0
  }
}

function parkourStandSafety (bot, pos, config = {}) {
  const start = pos.floored ? pos.floored() : asVec3(pos).floored()
  const maxDrop = Math.max(0, Math.ceil(config.pvp?.pvpParkourRiskDrop || 3))
  const safeDrop = config.pvp?.pvpParkourSafeDrop ?? 1
  for (let drop = 0; drop <= maxDrop; drop++) {
    const feetPos = start.offset(0, -drop, 0)
    const feet = bot.blockAt(feetPos)
    const head = bot.blockAt(feetPos.offset(0, 1, 0))
    const floorPos = feetPos.offset(0, -1, 0)
    const floor = bot.blockAt(floorPos)
    if (!isPassable(feet) || !isPassable(head) || !isSolidFloor(floor)) continue
    if (dangerousBlockNear(bot, feetPos) || dangerousBlockNear(bot, floorPos)) continue
    return {
      ok: true,
      pos: feetPos,
      drop,
      risky: drop > safeDrop,
      score: 4 - Math.max(0, drop - safeDrop) * 1.4
    }
  }
  return { ok: false, pos: start, drop: Infinity, risky: true, score: -Infinity }
}

function parkourRiskAllowed (bot, safety, config = {}, situation = {}) {
  if (!safety?.ok) return false
  if (!safety.risky) return true
  if (!hasTotem(bot) && config.pvp?.noTotemParkourRiskyDrops !== true) return false
  if (situation.pressure || situation.crystalReady) return false
  if ((bot.health || 20) < (config.pvp?.pvpParkourRiskHealth || 15)) return false
  if (config.pvp?.globalFallRecovery === false) return false
  return hasTotem(bot) || hasFallRecoveryItem(bot)
}

function hasFallRecoveryItem (bot) {
  return Boolean(
    findInventoryItem(bot, item => item.name === 'water_bucket') ||
    findInventoryItem(bot, item => item.name === 'elytra') ||
    equippedItem(bot, 'torso')?.name === 'elytra' ||
    findInventoryItem(bot, item => item.name === 'ender_pearl')
  )
}

function horizontalUnit (from, to) {
  const dx = from.x - to.x
  const dz = from.z - to.z
  const length = Math.sqrt(dx * dx + dz * dz)
  if (length < 0.001) return null
  return { x: dx / length, z: dz / length }
}

function pointSegmentDistance2D (point, a, b) {
  const ax = a.x
  const az = a.z
  const bx = b.x
  const bz = b.z
  const px = point.x
  const pz = point.z
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  if (lengthSq < 0.001) return Math.sqrt((px - ax) * (px - ax) + (pz - az) * (pz - az))
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / lengthSq, 0, 1)
  const cx = ax + dx * t
  const cz = az + dz * t
  return Math.sqrt((px - cx) * (px - cx) + (pz - cz) * (pz - cz))
}

function parkourRecencyPenalty (kind, recent = [], config = {}) {
  if (!recent?.length) return 1
  const memory = Math.max(2, config.pvp?.pvpParkourRecentMemory || 5)
  const penalty = clamp(config.pvp?.pvpParkourRepeatPenalty ?? 0.45, 0.1, 1)
  return recent.slice(-memory).reduce((score, item, index, items) => {
    if (item !== kind) return score
    const age = items.length - index
    return score * Math.max(penalty, 1 - age * 0.14)
  }, 1)
}

function weightedParkourChoice (items = []) {
  const weighted = items.filter(item => item?.score > 0)
  const total = weighted.reduce((sum, item) => sum + item.score, 0)
  if (total <= 0) return null
  let roll = Math.random() * total
  for (const item of weighted) {
    roll -= item.score
    if (roll <= 0) return item
  }
  return weighted[weighted.length - 1] || null
}

function findIncomingProjectile (bot, target, config = {}) {
  const maxRange = config.pvp?.projectileDodgeRange || 8
  return Object.values(bot.entities || {})
    .filter(entity => entity?.isValid)
    .filter(entity => PROJECTILE_DODGE_NAMES.has(String(entity.name || entity.displayName || '').toLowerCase()))
    .filter(entity => entity.position.distanceTo(bot.entity.position) <= maxRange)
    .map(entity => projectileThreat(bot, target, entity, config))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)[0] || null
}

function projectileThreat (bot, target, projectile, config = {}) {
  const velocity = projectile.velocity || new Vec3(0, 0, 0)
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z)
  if (speed < (config.pvp?.projectileMinSpeed || 0.08)) return null
  const body = bot.entity.position.offset(0, config.pvp?.projectileDodgeBodyHeight ?? 0.9, 0)
  const toBot = body.minus(projectile.position)
  const distance = Math.max(0.01, toBot.norm())
  const closingDot = (velocity.x * toBot.x + velocity.y * toBot.y + velocity.z * toBot.z) / (speed * distance)
  if (closingDot < (config.pvp?.projectileDodgeDot || 0.5)) return null

  const speedSq = speed * speed
  const impactTicks = (toBot.x * velocity.x + toBot.y * velocity.y + toBot.z * velocity.z) / speedSq
  const maxTicks = config.pvp?.projectileDodgeMaxTicks || 32
  if (impactTicks < 0 || impactTicks > maxTicks) return null

  const closest = projectile.position.offset(
    velocity.x * impactTicks,
    velocity.y * impactTicks,
    velocity.z * impactTicks
  )
  const closePass = closest.distanceTo(body)
  const passRadius = config.pvp?.projectileDodgePassRadius || 1.65
  if (closePass > passRadius) return null

  const fromTarget = target?.position ? Math.max(0, 6 - projectile.position.distanceTo(target.position)) : 0
  const side = projectileDodgeSide(bot, projectile, closest, config)
  const urgent = Math.max(0, maxTicks - impactTicks) / maxTicks
  const score = closingDot * 12 + urgent * 10 + Math.max(0, passRadius - closePass) * 5 + fromTarget
  return {
    projectile,
    velocity,
    speed,
    distance,
    impactTicks,
    impactMs: impactTicks * 50,
    closePass,
    closest,
    side,
    score
  }
}

function projectileDodgeSide (bot, projectile, closest, config = {}) {
  const velocity = projectile.velocity || new Vec3(0, 0, 0)
  const toBot = bot.entity.position.minus(projectile.position)
  const cross = velocity.x * toBot.z - velocity.z * toBot.x
  const preferred = cross >= 0 ? 1 : -1
  const leftScore = dodgeSideSafety(bot, closest, -1, config)
  const rightScore = dodgeSideSafety(bot, closest, 1, config)
  if (Math.abs(leftScore - rightScore) <= 0.2) return preferred
  return rightScore > leftScore ? 1 : -1
}

function dodgeSideSafety (bot, origin, side, config = {}) {
  const yaw = bot.entity?.yaw || 0
  const rightX = Math.cos(yaw)
  const rightZ = -Math.sin(yaw)
  const step = config.pvp?.projectileDodgeSideStep || 1.35
  const pos = origin.offset(rightX * side * step, 0, rightZ * side * step).floored()
  const feet = bot.blockAt(pos)
  const head = bot.blockAt(pos.offset(0, 1, 0))
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  let score = 1
  if (!isPassable(feet) || !isPassable(head)) score -= 2
  if (!isSolidFloor(floor)) score -= 1.5
  if (dangerousBlockNear(bot, pos)) score -= 3
  return score
}

async function projectileDodge (bot, target, threat, movement, config = {}) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(meleeAimPoint(target, config, { pressure: true }), true).catch(() => {})
  const side = threat.side || 1
  movement.strafe = side
  bot.setControlState('back', false)
  const emergency = threat.impactMs <= (config.pvp?.projectileEmergencyImpactMs || 260) || threat.closePass <= (config.pvp?.projectileEmergencyPassRadius || 0.75)
  bot.setControlState('forward', !emergency && Math.random() < (config.pvp?.projectileForwardJukeChance ?? 0.18))
  bot.setControlState('left', side < 0)
  bot.setControlState('right', side > 0)
  bot.setControlState('sprint', true)
  const shielded = emergency && config.pvp?.projectileEmergencyShield !== false
    ? await raiseShield(bot).catch(() => false)
    : false
  if (bot.entity?.onGround && (emergency || Math.random() < (config.pvp?.projectileJumpDodgeChance ?? 0.2))) bot.setControlState('jump', true)
  await sleep(emergency ? (config.pvp?.projectileEmergencyDodgeMs || 280) : (config.pvp?.projectileDodgeMs || 220))
  if (shielded) lowerShield(bot)
  bot.setControlState('jump', false)
  bot.setControlState('forward', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sprint', false)
}

function shouldPreemptiveProjectileJuke (bot, target, enemyGear = {}, distance = 99, now = Date.now(), lastAt = 0, attackReady = false, spacing = {}, config = {}) {
  if (config.pvp?.preShotDodgeEnabled === false) return false
  if (!['bow', 'crossbow', 'trident'].includes(enemyGear.weaponType)) return false
  if (distance > (config.pvp?.preShotDodgeRange || 18)) return false
  if (attackReady && distance <= (spacing?.hit || 3.35) + (config.pvp?.preShotMeleeOverrideRange || 0.6)) return false
  if (now - lastAt < (config.pvp?.preShotDodgeCooldownMs || 650)) return false
  if (!targetFacingBot(bot, target, config.pvp?.preShotFacingDot || 0.45)) return false
  return true
}

async function preemptiveProjectileJuke (bot, target, movement, config = {}) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(meleeAimPoint(target, config, { pressure: true }), true).catch(() => {})
  const side = choosePreShotJukeSide(bot, target, movement?.strafe || 1, config)
  if (movement) movement.strafe = side
  bot.setControlState('back', false)
  bot.setControlState('forward', Math.random() < (config.pvp?.preShotForwardJukeChance ?? 0.28))
  bot.setControlState('left', side < 0)
  bot.setControlState('right', side > 0)
  bot.setControlState('sprint', true)
  if (bot.entity?.onGround && Math.random() < (config.pvp?.preShotJumpChance ?? 0.18)) bot.setControlState('jump', true)
  await sleep(config.pvp?.preShotDodgeMs || 230)
  bot.setControlState('jump', false)
  bot.setControlState('forward', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sprint', false)
}

function choosePreShotJukeSide (bot, target, fallback = 1, config = {}) {
  if (!target?.position || !bot?.entity?.position) return fallback || 1
  const toBot = bot.entity.position.minus(target.position)
  const targetYaw = target.yaw || 0
  const aim = new Vec3(-Math.sin(targetYaw), 0, -Math.cos(targetYaw))
  const cross = aim.x * toBot.z - aim.z * toBot.x
  const preferred = cross >= 0 ? 1 : -1
  const base = bot.entity.position
  const leftScore = dodgeSideSafety(bot, base, -1, config)
  const rightScore = dodgeSideSafety(bot, base, 1, config)
  if (Math.abs(leftScore - rightScore) <= 0.2) return preferred || fallback || 1
  return rightScore > leftScore ? 1 : -1
}

function targetFacingBot (bot, target, minDot = 0.45) {
  if (!target?.position || !bot?.entity?.position) return false
  const yaw = target.yaw || 0
  const facing = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
  const toBot = bot.entity.position.minus(target.position)
  toBot.y = 0
  const distance = Math.max(0.001, Math.sqrt(toBot.x * toBot.x + toBot.z * toBot.z))
  const dot = (facing.x * toBot.x + facing.z * toBot.z) / distance
  return dot >= minDot
}

function perpendicularDistanceToRay (origin, direction, point) {
  const speed = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z)
  if (speed < 0.001) return Infinity
  const toPoint = point.minus(origin)
  const t = Math.max(0, (toPoint.x * direction.x + toPoint.y * direction.y + toPoint.z * direction.z) / (speed * speed))
  const closest = origin.offset(direction.x * t, direction.y * t, direction.z * t)
  return closest.distanceTo(point)
}

function predictedCutoffPoint (bot, target, distance, config = {}) {
  const velocity = target.velocity || new Vec3(0, 0, 0)
  const ticks = clamp(distance * (config.pvp?.cutoffLeadTicksPerBlock || 1.2), 4, config.pvp?.cutoffMaxLeadTicks || 18)
  const maxLead = config.pvp?.cutoffMaxLeadBlocks || 4.5
  const lead = new Vec3(
    clamp(velocity.x * ticks, -maxLead, maxLead),
    0,
    clamp(velocity.z * ticks, -maxLead, maxLead)
  )
  return target.position.offset(lead.x, lead.y, lead.z).floored()
}

function arenaCutoffPoint (target, center, spacing, config = {}) {
  const dx = center.x - target.position.x
  const dz = center.z - target.position.z
  const length = Math.sqrt(dx * dx + dz * dz)
  if (length < 0.001) return target.position.floored()
  const offset = config.pvp?.arenaCutoffOffset || Math.max(1.4, spacing?.sweet || 2.7)
  return target.position.offset((dx / length) * offset, 0, (dz / length) * offset).floored()
}

function uniqueEntities (entities) {
  const seen = new Set()
  return entities.filter(entity => {
    if (!entity?.isValid || seen.has(entity.id)) return false
    seen.add(entity.id)
    return true
  })
}

function readTargetHealth (bot, target) {
  if (Number.isFinite(target?.health)) return target.health
  const name = targetLabel(target)
  if (name && Number.isFinite(bot.players?.[name]?.health)) return bot.players[name].health
  return null
}

function targetDefeated (bot, target, config = {}) {
  const health = readTargetHealth(bot, target)
  if (!Number.isFinite(health)) return false
  return health <= (config.pvp?.targetDefeatedHealth || 0)
}

function shouldPrioritizeMelee (target, distance, bot, adaptive, attackReady, spacing, situation = null, config = {}) {
  if (!attackReady) return false
  if (!decisionAllowsMelee(situation, distance, spacing)) return false
  const aggression = pvpAggression(config)
  if (distance > spacing.hit + (aggression >= 1.35 ? (config.pvp?.aggressiveMeleeExtraRange || 0.25) : 0)) return false
  if (situation?.crystalReady && distance < (situation.spacing?.min || 4.2)) return false
  if (situation?.outgeared && !situation.counterWindow && !situation.finish && !situation.targetShielding) return false
  if (shouldHoldAntiBait(situation, distance, attackReady, config, bot)) return false
  if (shouldDelayMeleeForTiming(situation, distance, config)) return false
  if (shouldHoldShieldInsteadOfAttack(target, distance, bot, adaptive, attackReady, situation)) return false
  return true
}

function shouldTempoMelee (bot, target, distance, spacing, situation = null, config = {}, attackReady = false, now = Date.now(), lastAttackAt = 0, targetShielding = false) {
  if (config.pvp?.tempoEngineEnabled === false) return false
  if (!situation?.playerFight || !target?.isValid) return false
  if (situation.botTotemPopped && (situation.botTotemPopAgeMs || 0) <= (config.pvp?.tempoOwnPopNoAttackMs || 900)) return false
  if (situation.crystalReady && distance < (spacing?.min || 4.2)) return false
  if (situation.pressure && !situation.targetTotemPopped && (bot.health || 20) <= (config.pvp?.tempoPressureMinAttackHealth || 8.5)) return false
  if (situation.noTotem && !situation.finish && (bot.health || 20) <= (config.pvp?.noTotemNoCommitHealth || 11)) return false
  const tempo = situation.tempo
  if (!tempo?.inTempoRange || !tempo.goodEnough) return false
  if (targetShielding && hasAxe(bot)) return false
  if (shouldHoldShieldInsteadOfAttack(target, distance, bot, null, attackReady, situation) && !situation.targetTotemPopped) return false
  if (situation.targetTotemPopped) return true
  if (tempo.punishRecovery) return true
  if (tempo.pressureOverdue) return true
  if (tempo.imperfectTiming && distance <= (spacing.hit || 3.35)) return true
  if (situation.comboMomentum && distance <= (spacing.hit || 3.35) + 0.25 && tempo.sinceAttack >= (config.pvp?.tempoComboMinSwingMs || 430)) return true
  return false
}

function tempoMeleeReason (situation = {}, config = {}) {
  if (situation.targetTotemPopped) return 'target_totem_pop_execute'
  if (situation.tempo?.punishRecovery) return 'punish_enemy_recovery'
  if (situation.tempo?.pressureOverdue) return 'pressure_timer'
  if (situation.tempo?.imperfectTiming) return 'good_enough_imperfect'
  if (situation.comboMomentum) return 'combo_tempo'
  return 'tempo'
}

function decisionAllowsMelee (situation = null, distance = 99, spacing = {}) {
  const action = situation?.combatDecision?.action
  if (!action) return true
  if (situation?.finish || situation?.counterWindow) return true
  if (action === 'attack' || action === 'switch_weapon') return true
  if (action === 'strafe') return distance <= (spacing?.hit || 3.35)
  if (action === 'chase') return Boolean(situation?.comboMomentum && distance <= (spacing?.hit || 3.35) + 0.15)
  return false
}

function shouldHoldAntiBait (situation = null, distance = 99, attackReady = false, config = {}, bot = null) {
  if (!situation?.playerFight) return false
  if (situation.finish || situation.comboMomentum || situation.counterWindow) return false
  if (situation.targetTotemPopped) return false
  if (situation.tempo?.pressureOverdue || situation.tempo?.punishRecovery) return false
  if (
    situation.tempo?.sinceTargetHurt <= (config.pvp?.tempoAntiBaitBreakAfterHitMs || 520) &&
    distance <= (situation.spacing?.hit || 3.35) + (config.pvp?.tempoCloseRangeExtra || 0.55)
  ) return false
  if (situation.tradeLost && distance <= (config.pvp?.antiBaitLostTradeRange || 3.4)) return true
  const freshSwing = typeof situation.opponentSwingAgeMs === 'number' &&
    situation.opponentSwingAgeMs >= 0 &&
    situation.opponentSwingAgeMs <= (config.pvp?.antiBaitFreshSwingMs || 190)
  if (freshSwing && distance > (config.pvp?.antiBaitFreshSwingMinDistance || 2.25)) return true
  const shieldBait = situation.targetShielding || situation.opponentShieldTurtle || situation.opponentBaiter
  const axeReady = bot ? hasAxe(bot) : false
  const totemReady = bot ? hasTotem(bot) : false
  if (shieldBait && !axeReady && distance <= (config.pvp?.antiBaitShieldRange || 4.2)) return true
  if (shieldBait && !attackReady && distance <= (config.pvp?.antiBaitShieldRange || 4.2)) return true
  if (situation.opponentCrystalUser && distance < (situation.spacing?.min || 4.2) && !totemReady) return true
  return false
}

function antiBaitReason (situation = {}, distance = 99, config = {}) {
  if (situation.tradeLost && distance <= (config.pvp?.antiBaitLostTradeRange || 3.4)) return 'lost_trade'
  if (typeof situation.opponentSwingAgeMs === 'number' && situation.opponentSwingAgeMs <= (config.pvp?.antiBaitFreshSwingMs || 190)) return 'fresh_swing'
  if (situation.targetShielding || situation.opponentShieldTurtle || situation.opponentBaiter) return 'shield_bait'
  if (situation.opponentCrystalUser) return 'crystal_bait'
  return 'spacing'
}

function shouldDelayMeleeForTiming (situation = null, distance = 99, config = {}) {
  if (!situation?.normalDuel || situation.finish || situation.targetShielding) return false
  if (situation.hitConfirmed) return false
  if (situation.counterWindow) return false
  if (situation.targetTotemPopped || situation.tempo?.pressureOverdue || situation.tempo?.punishRecovery || situation.tempo?.imperfectTiming) return false
  const aggression = pvpAggression(config)
  if (aggression >= 1.35 && distance <= (config.pvp?.aggressiveNoDelayRange || 3.05)) return false
  if (distance <= (config.pvp?.duelPanicHitRange || 2.15) && !situation.outgeared) return false
  if (typeof situation.opponentSwingAgeMs !== 'number') return false
  const minAge = (config.pvp?.duelPunishMinSwingAgeMs || 170) / Math.max(1, aggression)
  const maxAge = (config.pvp?.duelPunishMaxSwingAgeMs || 760) * Math.min(1.35, aggression)
  return situation.opponentSwingAgeMs < minAge || situation.opponentSwingAgeMs > maxAge
}

function pvpAggression (config = {}) {
  const value = Number(config.pvp?.aggression ?? config.aggression ?? 1)
  return Number.isFinite(value) ? clamp(value, 0.6, 1.8) : 1
}

function opponentHasStyle (model = {}, label) {
  return Array.isArray(model.labels) &&
    model.labels.includes(label) &&
    (model.confidence == null || model.confidence >= 0.15)
}

function aggressionCooldownScale (aggression) {
  return clamp(1.35 - (aggression - 1) * 0.5, 0.75, 1.35)
}

function shouldAntiComboCounterAttack (bot, target, situation = null, distance = 99, spacing = {}, attackReady = false, config = {}) {
  if (config.pvp?.antiComboCounterEnabled === false) return false
  if (!situation?.playerFight || !target?.isValid || !attackReady) return false
  if (!situation.comboed && !situation.tradeLost && !situation.pressure) return false
  if (situation.crystalReady && distance < (spacing?.min || 2.4)) return false
  const health = bot.health || 20
  if (!hasTotem(bot) && health <= (config.pvp?.noTotemAntiComboCounterMinHealth ?? config.pvp?.antiComboCounterMinHealth ?? 9)) return false
  if (health <= (config.pvp?.antiComboCounterMinHealth || 2.5) && !hasTotem(bot)) return false
  const range = (spacing?.hit || 3.35) + (config.pvp?.antiComboCounterRangeExtra ?? 0.65)
  return distance <= range
}

function shouldAntiComboReset (situation = null, distance = 99, now = Date.now(), lastAt = 0, config = {}) {
  if (!situation?.playerFight) return false
  const comboHits = situation.comboHits || 0
  const comboDamage = situation.comboDamage || 0
  const realCombo = situation.comboed &&
    (comboHits >= (config.pvp?.antiComboMinHits ?? 2) ||
      comboDamage >= (config.pvp?.antiComboMinDamage ?? 4.5))
  const decisionBreak = situation.combatDecision?.action === 'back_up' &&
    ['break_enemy_combo', 'too_close_no_cooldown', 'too_close_after_hit'].includes(situation.combatDecision?.reason)
  const lostTradeBreak = situation.tradeLost && distance <= (config.pvp?.decisionLostTradeRange || 3.25)
  const pressureReset = config.pvp?.antiComboAllowPressureReset === true && situation.pressure
  if (!realCombo && !decisionBreak && !lostTradeBreak && !pressureReset) return false
  if (situation.finish && situation.attackReady && distance <= (situation.spacing?.hit || 3.35)) return false
  if (distance > (config.pvp?.antiComboMaxRange || 5.2)) return false
  return now - lastAt >= (config.pvp?.antiComboCooldownMs || 900)
}

async function antiComboReset (bot, target, strafe, config = {}, situation = {}, distance = 99) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(meleeAimPoint(target, config, { pressure: true }), true).catch(() => {})
  const right = strafe > 0
  const backpedal = config.pvp?.antiComboBackpedal === true && shouldBackpedalFromCombo(situation, distance, situation?.spacing, config)
  const forwardTap = !backpedal && distance > (config.pvp?.antiComboForwardTapRange ?? 3.25)
  bot.setControlState('back', backpedal)
  bot.setControlState('forward', forwardTap)
  bot.setControlState('left', !right)
  bot.setControlState('right', right)
  bot.setControlState('sprint', true)
  bot.setControlState('jump', false)
  await sleep(config.pvp?.antiComboResetMs || 260)
  bot.setControlState('back', false)
  bot.setControlState('forward', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sprint', false)
}

function shouldPreferAxe (bot, target, distance, targetShielding, attackReady, situation = null, config = {}) {
  if (!situation?.playerFight || target?.type !== 'player') return false
  if (!hasAxe(bot)) return false
  if (!targetShielding && !situation.opponentShieldTurtle && !situation.opponentBaiter && situation.counterPlan?.weapon !== 'axe') return false
  if (situation.pressure && !attackReady) return false
  return distance <= (config.pvp?.axePressureRange || 3.65)
}

function shouldUseAxePressure (bot, target, distance, targetShielding, attackReady, situation = null, config = {}, now = Date.now(), lastAttackAt = 0) {
  if (!situation?.normalDuel || target?.type !== 'player') return false
  if (!targetShielding || !attackReady) return false
  if (!hasAxe(bot)) return false
  if (situation.pressure && (bot.health || 20) <= (config.pvp?.totemPressureHealth || 14)) return false
  if (distance > (config.pvp?.axePressureRange || 3.65)) return false
  return now - lastAttackAt >= (config.pvp?.axePressureCooldownMs || 850)
}

function shouldBreakCloseClump (target, distance, attackReady, spacing, config = {}) {
  if (target?.type !== 'player') return false
  if (attackReady) return false
  return distance < (config.pvp?.closeClumpRange || Math.max(1.1, (spacing?.min || 2.35) - 1.1))
}

async function closeRangeReset (bot, target, config = {}) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
  bot.setControlState('back', true)
  bot.setControlState('sprint', true)
  bot.setControlState('left', true)
  bot.setControlState('right', false)
  await sleep(config.pvp?.closeClumpBackMs || 170)
  bot.setControlState('back', false)
  bot.setControlState('sprint', false)
  bot.setControlState('left', false)
}

async function combatUnstick (bot, target, config = {}) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
  const right = Math.random() > 0.5
  bot.setControlState('back', true)
  bot.setControlState('left', !right)
  bot.setControlState('right', right)
  bot.setControlState('sprint', true)
  if (bot.entity?.onGround && hasClimbableBlockAhead(bot)) bot.setControlState('jump', true)
  await sleep(config.pvp?.combatUnstickMs || 360)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sprint', false)
  bot.setControlState('jump', false)
}

function hasClimbableBlockAhead (bot) {
  const yaw = bot.entity?.yaw || 0
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const pos = bot.entity.position.offset(Math.round(dx), 0, Math.round(dz)).floored()
  const feet = bot.blockAt(pos)
  const head = bot.blockAt(pos.offset(0, 1, 0))
  const above = bot.blockAt(pos.offset(0, 2, 0))
  return feet && !isPassable(feet) && isPassable(head) && isPassable(above)
}

function isMaceDiveDanger (target, enemyGear, distance, verticalGap, config = {}) {
  if (target?.type !== 'player') return false
  if (enemyGear?.weaponType !== 'mace') return false
  if (distance > (config.pvp?.maceDangerRange || 5.5)) return false
  return verticalGap >= (config.pvp?.maceDangerVerticalGap || 1.2) || target?.velocity?.y < -0.18
}

async function evadeMaceDive (bot, target, config = {}) {
  bot.pathfinder?.stop()
  if (target?.isValid) await bot.lookAt(target.position.offset(0, target.height || 1.6, 0), true).catch(() => {})
  bot.setControlState('back', true)
  bot.setControlState('right', true)
  bot.setControlState('sprint', true)
  await sleep(config.pvp?.maceDangerEvadeMs || 260)
  bot.setControlState('back', false)
  bot.setControlState('right', false)
  bot.setControlState('sprint', false)
}

function shouldForceCombatHand (bot, distance, spacing) {
  if (distance > (spacing?.max || 3.6) + 1.2) return false
  const held = bot.heldItem
  if (!held) return true
  if (isWeaponCandidate(held.name)) return false
  return !['golden_apple', 'enchanted_golden_apple', 'bow', 'crossbow'].includes(held.name)
}

async function maintainCombatOffhand (bot, target, distance, config, shouldTotem, recentlyDamaged, situation = null) {
  if (shouldTotem || shouldKeepTotemReady(bot, target, distance, config, recentlyDamaged, situation)) {
    const totem = await equipBestTotem(bot).catch(() => null)
    if (totem) return totem
  }
  return equipBestShield(bot).catch(() => null)
}

function shouldKeepTotemReady (bot, target, distance, config, recentlyDamaged, situation = null) {
  if (!hasTotem(bot)) return false
  if (shouldFavorTotemForCrystalKit(bot, target, distance, config)) return true
  if (situation?.crystalReady && bot.health <= (config.pvp?.totemVsCrystalHealth || 16)) return true
  if (situation?.pressure && bot.health <= (config.pvp?.totemPressureHealth || 14)) return true
  if (nearbyCrystalThreat(bot, config) && bot.health <= (config.pvp?.totemVsCrystalHealth || 16)) return true
  const gear = readTargetGear(target)
  if (gear.weaponType === 'mace' && distance <= 5 && bot.health <= (config.pvp?.totemVsMaceHealth || 13)) return true
  return recentlyDamaged && bot.health <= (config.pvp?.totemRecentDamageHealth || 12)
}

async function returnToCombatWeapon (bot, target, preferAxe = false, playerFight = true, situation = null) {
  return equipBestCombatWeapon(bot, target, { preferAxe, playerFight, normalDuel: situation?.normalDuel })
}

function targetLabel (target) {
  return target?.username || target?.name || target?.displayName || null
}

function roundMetric (value, precision = 1) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function shouldUseElytraMace (bot, target, distance, verticalGap, config, now, lastElytraMaceAt, arenaCenter = null, arenaRadius = 18, situation = null) {
  if (config.pvp?.elytraMaceEnabled === false) return false
  if (target?.type !== 'player') return false
  if (!hasElytraMaceLoadout(bot)) return false
  if (situation?.pressure || situation?.crystalReady) return false
  if (!hasTotem(bot) && (bot.health || 20) < (config.pvp?.noTotemElytraMaceMinHealth ?? 16)) return false
  if ((bot.health || 20) < (config.pvp?.elytraMaceMinHealth || 12) && !hasTotem(bot)) return false
  if (now - lastElytraMaceAt < (config.pvp?.elytraMaceCooldownMs || 7000)) return false
  if (dangerousCombatFooting(bot)) return false

  const minRange = config.pvp?.elytraMaceMinRange || 6.5
  const maxRange = config.pvp?.elytraMaceMaxRange || 22
  if (distance > maxRange) return false
  if (config.pvp?.elytraMaceOnlyWhenNeeded !== false) {
    const farEnough = distance >= (config.pvp?.elytraMaceNeededDistance || 9)
    const targetHigh = verticalGap >= (config.pvp?.elytraMaceNeededVerticalGap || 3)
    const finishingHigh = situation?.finish && situation?.targetHigh
    if (!farEnough && !targetHigh && !finishingHigh) return false
  }
  if (distance < minRange) {
    if (config.pvp?.elytraMaceCloseSetup === false) return false
    if (distance < (config.pvp?.elytraMaceCloseSetupMinRange || 2.4)) return false
  }
  if (verticalGap > (config.pvp?.elytraMaceMaxTargetAbove || 5)) return false
  if (!hasLaunchHeadroom(bot, config.pvp?.elytraMaceHeadroom || 4)) return false

  if (arenaCenter) {
    const edgeBuffer = config.pvp?.elytraMaceArenaEdgeBuffer ?? 2.5
    const safeRadius = Math.max(4, arenaRadius - edgeBuffer)
    if (horizontalDistance(bot.entity.position, arenaCenter) > safeRadius) return false
    if (horizontalDistance(target.position, arenaCenter) > arenaRadius + 0.5) return false
    if (distance > Math.max(minRange, Math.min(maxRange, arenaRadius + 1))) return false
  }

  return true
}

async function elytraMaceChain (bot, target, config, signal, arenaCenter = null, arenaRadius = 18, training = null) {
  const attempts = Math.max(1, Math.round(config.pvp?.elytraMaceChainAttempts || 1))
  const minAttempts = Math.min(attempts, Math.max(1, Math.round(config.pvp?.elytraMaceChainMinAttempts || attempts)))
  let attacked = false

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.cancelled || !target?.isValid) break
    if (attempt > 1) {
      await sleep(config.pvp?.elytraMaceChainDelayMs || 260)
      if (!shouldContinueElytraMaceChain(bot, target, config, arenaCenter, arenaRadius, attempt, minAttempts)) break
    }

    const distance = bot.entity.position.distanceTo(target.position)
    const verticalGap = target.position.y - bot.entity.position.y
    recordTraining({ training }, 'elytra_mace_attempt', {
      target: targetLabel(target),
      distance: roundMetric(distance, 2),
      verticalGap: roundMetric(verticalGap, 2),
      chainAttempt: attempt,
      chainTotal: attempts
    })

    const attemptAttacked = await elytraMaceCombo(bot, target, config, signal, arenaCenter, arenaRadius, training).catch(() => false)
    if (attemptAttacked) {
      attacked = true
      recordTraining({ training }, 'elytra_mace_hit', {
        target: targetLabel(target),
        chainAttempt: attempt,
        chainTotal: attempts
      })
      if (config.pvp?.elytraMaceChainStopOnHit !== false && attempt >= minAttempts) break
    } else {
      recordTraining({ training }, 'elytra_mace_failed', {
        target: targetLabel(target),
        chainAttempt: attempt,
        chainTotal: attempts
      })
    }
  }

  return attacked
}

function shouldContinueElytraMaceChain (bot, target, config = {}, arenaCenter = null, arenaRadius = 18, attempt = 1, minAttempts = 1) {
  if (!target?.isValid || !hasElytraMaceLoadout(bot)) return false
  const health = bot.health || 20
  if (!hasTotem(bot) && health <= (config.pvp?.noTotemElytraMaceChainMinHealth ?? 14)) return false
  if (health <= (config.pvp?.elytraMaceChainMinHealth || 4) && !hasTotem(bot)) return false
  const distance = bot.entity.position.distanceTo(target.position)
  if (distance > (config.pvp?.elytraMaceChainMaxRange || 30)) return false
  if (arenaCenter) {
    const edgeBuffer = config.pvp?.elytraMaceArenaEdgeBuffer ?? 2.5
    if (horizontalDistance(bot.entity.position, arenaCenter) > arenaRadius - edgeBuffer + 2) return false
    if (horizontalDistance(target.position, arenaCenter) > arenaRadius + 1.5 && attempt > minAttempts) return false
  }
  return true
}

async function elytraMaceCombo (bot, target, config, signal, arenaCenter = null, arenaRadius = 18, training = null) {
  if (!hasElytraMaceLoadout(bot)) return false
  const restoreChestplate = config.pvp?.elytraMaceRestoreChestplate !== false
  let attacked = false
  let maceSwings = 0

  try {
    clearCombatControls(bot)
    await makeElytraLaunchSpace(bot, target, config, signal, arenaCenter, arenaRadius, training).catch(() => false)
    if (!await equipElytra(bot).catch(() => null)) return false

    const flying = await startElytraMaceFlight(bot, target, config, signal)
    if (!flying || signal?.cancelled || !target?.isValid) return false

    await sleep(config.pvp?.elytraMaceRocketDelayMs ?? 60)
    if (!await useFireworkRocket(bot).catch(() => false)) return false
    await sleep(config.pvp?.elytraMaceWeaponSwapMs ?? 30)
    await equipMace(bot).catch(() => null)

    const endAt = Date.now() + (config.pvp?.elytraMaceDiveMs || 1600)
    const hitRange = config.pvp?.elytraMaceHitRange || 4.2
    const minSmashHeight = config.pvp?.elytraMaceMinSmashHeight || 0.8
    const horizontalHitRange = config.pvp?.elytraMaceHorizontalHitRange || 3.35
    const attackMaxHeight = config.pvp?.elytraMaceAttackMaxHeight ?? 3.0
    const attackMinHeight = config.pvp?.elytraMaceAttackMinHeight ?? -0.9
    const maxSwings = Math.max(1, config.pvp?.elytraMaceSwingsPerAttempt || 1)
    let lastMaceSwingAt = 0
    let peakY = bot.entity.position.y
    let peakHeightAdvantage = bot.entity.position.y - target.position.y
    const recovery = {
      extraRocketUsed: false,
      waterBucketUsed: false,
      lastRocketAt: Date.now()
    }

    while (!signal?.cancelled && target?.isValid && Date.now() < endAt) {
      if (arenaCenter && horizontalDistance(bot.entity.position, arenaCenter) > arenaRadius + 0.75) break

      await steerElytraMace(bot, target, config, arenaCenter, arenaRadius)

      const distance = bot.entity.position.distanceTo(target.position)
      const heightAdvantage = bot.entity.position.y - target.position.y
      peakY = Math.max(peakY, bot.entity.position.y)
      peakHeightAdvantage = Math.max(peakHeightAdvantage, heightAdvantage)
      const droppedFromPeak = peakY - bot.entity.position.y
      const fallDistance = Number(bot.entity.fallDistance || 0)
      const horizontalGap = horizontalDistance(bot.entity.position, target.position)

      if (!recovery.extraRocketUsed && shouldUseSecondMaceRocket(bot, target, distance, config, arenaCenter, arenaRadius)) {
        recovery.extraRocketUsed = await useFireworkRocket(bot).catch(() => false)
        if (recovery.extraRocketUsed) recovery.lastRocketAt = Date.now()
        await sleep(config.pvp?.elytraMaceWeaponSwapMs ?? 30)
        await equipMace(bot).catch(() => null)
      }

      const fallingFast = (bot.entity.velocity?.y || 0) < (config.pvp?.elytraMaceDiveVelocity || -0.08)
      const smashCharged = peakHeightAdvantage >= minSmashHeight ||
        droppedFromPeak >= minSmashHeight ||
        fallDistance >= minSmashHeight
      const inImpactHeight = heightAdvantage <= attackMaxHeight && heightAdvantage >= attackMinHeight
      const inHitWindow = distance <= hitRange || (horizontalGap <= horizontalHitRange && inImpactHeight)
      const descending = fallingFast || (bot.entity.velocity?.y || 0) < 0 || droppedFromPeak >= Math.max(1.4, minSmashHeight * 0.35)
      const eagerPressureSwing = config.pvp?.elytraMaceEagerSwing !== false &&
        inHitWindow &&
        descending &&
        heightAdvantage <= attackMaxHeight + (config.pvp?.elytraMaceEagerHeightBuffer ?? 1.2) &&
        (fallDistance >= (config.pvp?.elytraMaceEagerFallDistance || 1.4) ||
          droppedFromPeak >= (config.pvp?.elytraMaceEagerDrop || Math.max(1.2, minSmashHeight * 0.25)))
      let swungThisTick = false
      if (
        inHitWindow &&
        (smashCharged || eagerPressureSwing) &&
        descending &&
        maceSwings < maxSwings &&
        Date.now() - lastMaceSwingAt >= (config.pvp?.elytraMaceSwingCooldownMs || 220)
      ) {
        await equipMace(bot).catch(() => null)
        await bot.lookAt(target.position.offset(0, (target.height || 1.8) * 0.55, 0), true).catch(() => {})
        bot.attack(target)
        recordTraining({ training }, 'elytra_mace_swing', {
          target: targetLabel(target),
          distance: roundMetric(distance, 2),
          horizontalGap: roundMetric(horizontalGap, 2),
          heightAdvantage: roundMetric(heightAdvantage, 2),
          peakHeightAdvantage: roundMetric(peakHeightAdvantage, 2),
          droppedFromPeak: roundMetric(droppedFromPeak, 2)
        })
        maceSwings += 1
        lastMaceSwingAt = Date.now()
        attacked = true
        swungThisTick = true
        if (config.pvp?.elytraMaceBreakAfterSwing !== false) break
      }

      const fallRecovery = await recoverElytraMaceFall(bot, target, config, signal, recovery, training, swungThisTick).catch(() => ({ recovered: false, abort: false }))
      if (fallRecovery.abort) break
      if (fallRecovery.recovered) await equipMace(bot).catch(() => null)

      await sleep(config.pvp?.elytraMaceSteerMs || 30)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    if (restoreChestplate) await restoreBestChestplate(bot, config).catch(() => {})
  }

  return attacked
}

async function makeElytraLaunchSpace (bot, target, config, signal, arenaCenter = null, arenaRadius = 18, training = null) {
  if (config.pvp?.elytraMaceCloseSetup === false || !target?.isValid) return false
  const desiredRange = config.pvp?.elytraMaceLaunchSetupRange || 5.4
  if (bot.entity.position.distanceTo(target.position) >= desiredRange) return false

  recordTraining({ training }, 'elytra_mace_setup', {
    target: targetLabel(target),
    distance: roundMetric(bot.entity.position.distanceTo(target.position), 2)
  })

  const edgeBuffer = config.pvp?.elytraMaceArenaEdgeBuffer ?? 1.2
  const endAt = Date.now() + (config.pvp?.elytraMaceLaunchSetupMs || 700)
  bot.pathfinder?.stop()

  while (!signal?.cancelled && target?.isValid && Date.now() < endAt) {
    const distance = bot.entity.position.distanceTo(target.position)
    if (distance >= desiredRange) break

    let dx = bot.entity.position.x - target.position.x
    let dz = bot.entity.position.z - target.position.z
    if (arenaCenter && horizontalDistance(bot.entity.position, arenaCenter) > arenaRadius - edgeBuffer - 1) {
      dx = arenaCenter.x - bot.entity.position.x
      dz = arenaCenter.z - bot.entity.position.z
    }

    await faceVector(bot, dx, dz).catch(() => {})
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('jump', false)
    await sleep(100)
  }

  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)
  return true
}

async function startElytraMaceFlight (bot, target, config, signal) {
  if (bot.entity.elytraFlying) return true
  await bot.lookAt(target.position.offset(0, config.pvp?.elytraMaceLaunchAimHeight || 3.5, 0), true).catch(() => {})

  if (bot.entity.onGround) {
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    await sleep(config.pvp?.elytraMaceJumpMs ?? 180)
    bot.setControlState('jump', false)
  }

  const endAt = Date.now() + (config.pvp?.elytraMaceFlightStartMs || 850)
  while (!signal?.cancelled && Date.now() < endAt) {
    if (bot.entity.elytraFlying) return true
    if (!bot.entity.onGround && typeof bot.elytraFly === 'function') {
      await bot.elytraFly().catch(() => {})
      sendStartElytraFlying(bot)
    }
    await sleep(50)
  }
  return Boolean(bot.entity.elytraFlying)
}

function createFallRecoveryState () {
  return {
    lastAttemptAt: 0,
    lastRecordAt: 0,
    lastTotemAt: 0,
    lastBootSwapAt: 0,
    lastElytraAt: 0,
    lastRocketAt: 0,
    lastWaterAt: 0,
    lastPearlAt: 0,
    lastFateAt: 0
  }
}

function fallThreatProfile (bot, config = {}) {
  if (!bot?.entity || bot.entity.onGround) return null
  const fallSpeed = -(bot.entity.velocity?.y || 0)
  const fallDistance = Number(bot.entity.fallDistance || 0)
  const height = heightAboveGround(bot, config.pvp?.fallRecoveryScan || 48)
  const minSpeed = config.pvp?.fallRecoveryMinSpeed ?? 0.22
  const minDistance = config.pvp?.fallRecoveryMinDistance ?? 3.2
  const minHeight = config.pvp?.fallRecoveryMinHeight ?? 4.2
  if (fallSpeed < minSpeed && fallDistance < minDistance && height < minHeight) return null
  return { fallSpeed, fallDistance, height }
}

function shouldRunFallRecovery (threat, state = {}, now = Date.now(), config = {}) {
  if (!threat) return false
  const urgent = threat.height <= (config.pvp?.fallUrgentHeight || 9) || threat.fallSpeed >= (config.pvp?.fallUrgentSpeed || 0.6)
  const cooldown = urgent ? (config.pvp?.fallRecoveryUrgentTickMs || 80) : (config.pvp?.fallRecoveryTickMs || 180)
  return now - (state.lastAttemptAt || 0) >= cooldown
}

async function emergencyFallRecover (bot, target, config = {}, signal = null, state = createFallRecoveryState(), training = null) {
  const now = Date.now()
  const threat = fallThreatProfile(bot, config)
  if (!threat || signal?.cancelled) return { attempted: false, recovered: false }
  state.lastAttemptAt = now

  if (now - (state.lastRecordAt || 0) >= (config.pvp?.fallRecoveryRecordCooldownMs || 600)) {
    recordTraining({ training }, 'fall_recovery', {
      height: roundMetric(threat.height, 2),
      speed: roundMetric(threat.fallSpeed, 3),
      fallDistance: roundMetric(threat.fallDistance, 2),
      source: 'combat'
    })
    state.lastRecordAt = now
  }

  let attempted = false

  if (
    now - (state.lastTotemAt || 0) >= (config.pvp?.fallTotemCooldownMs || 250) &&
    (threat.height >= (config.pvp?.fallTotemHeight || 7) ||
      threat.fallDistance >= (config.pvp?.fallTotemDistance || 6) ||
      (bot.health || 20) <= (config.pvp?.fallTotemHealth || 14))
  ) {
    const totem = await equipBestTotem(bot).catch(() => null)
    attempted = attempted || Boolean(totem)
    state.lastTotemAt = now
    recordTraining({ training }, totem ? 'fall_totem' : 'fall_totem_missing', {
      height: roundMetric(threat.height, 2),
      health: roundMetric(bot.health || 0, 2)
    })
  }

  if (now - (state.lastBootSwapAt || 0) >= (config.pvp?.fallBootSwapCooldownMs || 750)) {
    const boots = await equipBestFallBoots(bot, config).catch(() => null)
    if (boots) {
      attempted = true
      state.lastBootSwapAt = now
      recordTraining({ training }, 'fall_boot_swap', {
        item: boots.name,
        featherFalling: enchantLevel(boots, ['feather_falling', 'feather falling']),
        protection: enchantLevel(boots, ['protection'])
      })
    }
  }

  if (
    now - (state.lastElytraAt || 0) >= (config.pvp?.fallElytraCooldownMs || 280) &&
    threat.height >= (config.pvp?.fallElytraMinHeight || 6)
  ) {
    const recovered = await recoverFallWithElytra(bot, target, config, signal, state).catch(() => false)
    if (recovered) {
      recordTraining({ training }, 'fall_elytra_recovery', {
        height: roundMetric(threat.height, 2),
        speed: roundMetric(threat.fallSpeed, 3)
      })
      return { attempted: true, recovered: true, method: 'elytra' }
    }
  }

  const latestThreat = fallThreatProfile(bot, config) || threat

  if (
    now - (state.lastWaterAt || 0) >= (config.pvp?.fallWaterCooldownMs || 220) &&
    latestThreat.height <= (config.pvp?.fallWaterBucketTriggerHeight || 8.5)
  ) {
    state.lastWaterAt = now
    attempted = true
    const clutched = await clutchWaterBucket(bot, config).catch(() => false)
    if (clutched) {
      recordTraining({ training }, 'water_clutch', { height: roundMetric(latestThreat.height, 2), source: 'fall_recovery' })
      return { attempted: true, recovered: true, method: 'water_bucket' }
    }
  }

  if (
    now - (state.lastPearlAt || 0) >= (config.pvp?.fallPearlCooldownMs || 1400) &&
    latestThreat.height <= (config.pvp?.fallPearlTriggerHeight || 18) &&
    latestThreat.height >= (config.pvp?.fallPearlMinHeight || 4.5)
  ) {
    state.lastPearlAt = now
    attempted = true
    const pearled = await throwEnderPearlAtFallLanding(bot, target, config).catch(() => false)
    if (pearled) {
      recordTraining({ training }, 'fall_ender_pearl', { height: roundMetric(latestThreat.height, 2), speed: roundMetric(latestThreat.fallSpeed, 3) })
      return { attempted: true, recovered: true, method: 'ender_pearl' }
    }
  }

  if (!attempted && now - (state.lastFateAt || 0) >= (config.pvp?.fallFateRecordCooldownMs || 1500)) {
    state.lastFateAt = now
    recordTraining({ training }, 'fall_accept_fate', {
      height: roundMetric(threat.height, 2),
      speed: roundMetric(threat.fallSpeed, 3),
      hasTotem: hasTotem(bot),
      hasElytra: Boolean(findInventoryItem(bot, item => item.name === 'elytra' && durabilityOk(item))),
      hasWater: Boolean(findInventoryItem(bot, item => item.name === 'water_bucket')),
      hasPearl: Boolean(findInventoryItem(bot, item => item.name === 'ender_pearl'))
    })
  }

  return { attempted, recovered: false }
}

async function recoverFallWithElytra (bot, target, config = {}, signal = null, state = {}) {
  const elytra = await equipElytra(bot).catch(() => null)
  if (!elytra || signal?.cancelled) return false
  state.lastElytraAt = Date.now()
  const aim = fallRecoveryAimPoint(bot, target, config)
  await bot.lookAt(aim, true).catch(() => {})

  if (!bot.entity.elytraFlying) await startFallElytraFlight(bot, config, signal).catch(() => false)

  if (bot.entity.elytraFlying) {
    const now = Date.now()
    const height = heightAboveGround(bot, config.pvp?.fallRecoveryScan || 48)
    await steerSafeElytraFall(bot, config, { target, state }).catch(() => {})
    const rocketCooldown = config.pvp?.fallRocketCooldownMs || 450
    if (
      shouldUseFallRecoveryRocket(bot, height, config) &&
      height >= (config.pvp?.fallRocketMinHeight || 5) &&
      findInventoryItem(bot, item => item.name === 'firework_rocket') &&
      now - (state.lastRocketAt || 0) >= rocketCooldown
    ) {
      await bot.lookAt(fallRecoveryAimPoint(bot, target, config), true).catch(() => {})
      await useFireworkRocket(bot).catch(() => false)
      state.lastRocketAt = now
    }
    return true
  }

  return false
}

async function startFallElytraFlight (bot, config = {}, signal = null) {
  const endAt = Date.now() + (config.pvp?.fallElytraStartMs || 360)
  const pulseMs = Math.max(30, config.pvp?.fallElytraStartPulseMs || 30)
  await sleep(config.pvp?.fallElytraEquipDelayMs ?? 30)
  while (!signal?.cancelled && !bot.entity?.onGround && Date.now() < endAt) {
    if (bot.entity.elytraFlying) return true
    bot.setControlState('jump', true)
    if (typeof bot.elytraFly === 'function') await bot.elytraFly().catch(() => {})
    sendStartElytraFlying(bot)
    await sleep(pulseMs)
    bot.setControlState('jump', false)
    await sleep(Math.max(10, Math.floor(pulseMs / 2)))
  }
  bot.setControlState('jump', false)
  return Boolean(bot.entity?.elytraFlying)
}

function fallRecoveryAimPoint (bot, target, config = {}) {
  if (
    config.pvp?.fallElytraAimAtTarget === true &&
    target?.isValid &&
    horizontalDistance(bot.entity.position, target.position) <= (config.pvp?.fallElytraAimTargetRange || 18)
  ) {
    return target.position.offset(0, config.pvp?.fallElytraAimHeight || 4, 0)
  }
  const landing = safeFallLandingAimPoint(bot, config)
  if (landing) return landing
  const velocity = bot.entity.velocity || new Vec3(0, 0, 0)
  return bot.entity.position.offset(
    clamp((velocity.x || 0) * 8, -8, 8),
    -Math.max(1.5, config.pvp?.fallElytraDescentPitch || 4),
    clamp((velocity.z || 0) * 8, -8, 8)
  )
}

function safeFallLandingAimPoint (bot, config = {}) {
  const floor = findFloorBelow(bot, config.pvp?.fallRecoveryScan || 64)
  const height = floor && isSolidFloor(floor)
    ? bot.entity.position.y - (floor.position.y + 1)
    : config.pvp?.fallRecoveryScan || 32
  const swirl = Date.now() / (config.pvp?.fallElytraJukePeriodMs || 180)
  const orbitRadius = clamp(height * 0.08, 2.2, config.pvp?.fallElytraOrbitRadius || 4.5)
  const center = floor && isSolidFloor(floor)
    ? floor.position.offset(0.5, 0, 0.5)
    : bot.entity.position
  const aimHeight = height > (config.pvp?.fallElytraFinalApproachHeight || 9)
    ? (config.pvp?.fallElytraGlideAimHeight ?? -2.4)
    : (config.pvp?.fallElytraFinalAimHeight ?? 0.9)
  return new Vec3(
    center.x + Math.cos(swirl) * orbitRadius,
    bot.entity.position.y + aimHeight,
    center.z + Math.sin(swirl) * orbitRadius
  )
}

async function steerSafeElytraFall (bot, config = {}, options = {}) {
  const ticks = Math.max(1, Math.round(config.pvp?.fallElytraSteerTicks || 2))
  const tickMs = Math.max(30, config.pvp?.fallElytraSteerMs || 30)
  for (let i = 0; i < ticks; i++) {
    if (!bot.entity?.elytraFlying) break
    const aim = fallRecoveryAimPoint(bot, options.target, config)
    await bot.lookAt(aim, true).catch(() => {})
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    const right = Math.floor(Date.now() / (config.pvp?.fallElytraJukePeriodMs || 220)) % 2 === 0
    bot.setControlState('left', !right)
    bot.setControlState('right', right)
    await sleep(tickMs)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
  }
}

function shouldUseFallRecoveryRocket (bot, height, config = {}) {
  if (config.pvp?.fallRocketDuringRecovery === false) return false
  const fallSpeed = -(bot.entity?.velocity?.y || 0)
  return fallSpeed >= (config.pvp?.fallRocketEmergencySpeed || 0.78) ||
    height <= (config.pvp?.fallRocketEmergencyHeight || 4.8)
}

async function recoverDangerousFall (bot, config = {}, signal = null, options = {}) {
  const state = options.state || createFallRecoveryState()
  const threat = fallThreatProfile(bot, config)
  if (!threat || !shouldRunFallRecovery(threat, state, Date.now(), config)) {
    return { attempted: false, recovered: false }
  }
  return emergencyFallRecover(bot, options.target || null, config, signal, state, options.training || null)
}

async function equipBestFallBoots (bot, config = {}) {
  const current = equippedItem(bot, 'feet')
  const candidates = [
    current,
    ...bot.inventory.items().filter(item => item?.name?.endsWith('_boots') && durabilityOk(item))
  ].filter(Boolean)

  const best = candidates
    .sort((a, b) => fallBootScore(b) - fallBootScore(a))[0] || null

  if (!best || best === current) return null
  const currentScore = fallBootScore(current)
  const bestScore = fallBootScore(best)
  const minGain = config.pvp?.fallBootSwapMinGain ?? 8
  const bestFeatherFalling = enchantLevel(best, ['feather_falling', 'feather falling'])
  if (!bestFeatherFalling && current && bestScore <= currentScore + minGain) return null
  if (bestScore <= currentScore + minGain && current?.name?.endsWith('_boots')) return null

  await bot.equip(best, 'feet')
  return best
}

function fallBootScore (item) {
  if (!item?.name?.endsWith('_boots') || !durabilityOk(item)) return -Infinity
  const featherFalling = enchantLevel(item, ['feather_falling', 'feather falling', 'minecraft:feather_falling'])
  const protection = enchantLevel(item, ['protection', 'minecraft:protection'])
  const blastProtection = enchantLevel(item, ['blast_protection', 'fire_protection', 'projectile_protection'])
  return armorItemScore(item) + featherFalling * 140 + protection * 18 + blastProtection * 8 + durabilityRatio(item) * 10
}

function enchantLevel (item, names = []) {
  if (!item) return 0
  const wanted = new Set(names.map(normalizeEnchantName).filter(Boolean))
  if (!wanted.size) return 0
  return Math.max(
    scanEnchantTree(item.enchants, wanted),
    scanEnchantTree(item.enchantments, wanted),
    scanEnchantTree(item.components, wanted),
    scanEnchantTree(item.componentMap, wanted),
    scanEnchantTree(item.nbt, wanted)
  )
}

function scanEnchantTree (node, wanted, depth = 0, seen = new Set()) {
  if (node == null || depth > 12) return 0
  if (typeof node === 'string') return wanted.has(normalizeEnchantName(node)) ? 1 : 0
  if (typeof node === 'number') return 0
  if (typeof node !== 'object') return 0
  if (seen.has(node)) return 0
  seen.add(node)

  if (Array.isArray(node)) {
    return node.reduce((best, value) => Math.max(best, scanEnchantTree(value, wanted, depth + 1, seen)), 0)
  }

  if (node instanceof Map) {
    let best = 0
    for (const [key, value] of node.entries()) {
      best = Math.max(best, scanEnchantKeyValue(key, value, wanted), scanEnchantTree(value, wanted, depth + 1, seen))
    }
    return best
  }

  const directName = firstStringLike(
    node.id,
    node.name,
    node.enchant,
    node.enchantment,
    node.key,
    node.value?.id,
    node.value?.name,
    node.value?.enchant,
    node.value?.enchantment,
    node.value?.value?.id,
    node.value?.value?.name
  )
  let best = directName && wanted.has(normalizeEnchantName(directName))
    ? (readEnchantLevelFromNode(node) || 1)
    : 0

  for (const [key, value] of Object.entries(node)) {
    best = Math.max(
      best,
      scanEnchantKeyValue(key, value, wanted),
      scanEnchantTree(value, wanted, depth + 1, seen)
    )
  }
  return best
}

function scanEnchantKeyValue (key, value, wanted) {
  if (wanted.has(normalizeEnchantName(key))) {
    return readNumericLike(value) || readEnchantLevelFromNode(value) || 1
  }
  const valueString = readStringLike(value)
  if (valueString && wanted.has(normalizeEnchantName(valueString))) {
    return 1
  }
  return 0
}

function readEnchantLevelFromNode (node) {
  const bags = [
    node,
    node?.value,
    node?.value?.value
  ].filter(value => value && typeof value === 'object')
  for (const bag of bags) {
    for (const key of ['lvl', 'Lvl', 'level', 'Level']) {
      const level = readNumericLike(bag[key])
      if (level > 0) return level
    }
  }
  return 0
}

function firstStringLike (...values) {
  for (const value of values) {
    const text = readStringLike(value)
    if (text) return text
  }
  return ''
}

function readStringLike (value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return ''
  if (typeof value.value === 'string') return value.value
  if (typeof value.value?.value === 'string') return value.value.value
  return ''
}

function readNumericLike (value) {
  if (Number.isFinite(value)) return Number(value)
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value)
  if (!value || typeof value !== 'object') return 0
  if (Number.isFinite(value.value)) return Number(value.value)
  if (typeof value.value === 'string' && Number.isFinite(Number(value.value))) return Number(value.value)
  if (value.value && typeof value.value === 'object') return readNumericLike(value.value)
  return 0
}

function normalizeEnchantName (name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_')
}

function shouldUseCombatPearl (bot, target, distance, config = {}, now = Date.now(), lastCombatPearlAt = 0, situation = {}, arenaCenter = null, arenaRadius = 18) {
  if (config.pvp?.finalBossMode !== true || config.pvp?.combatPearlEnabled === false) return null
  if (target?.type !== 'player' || !Number.isFinite(distance)) return null
  if (!findInventoryItem(bot, item => item.name === 'ender_pearl')) return null
  if (!hasTotem(bot) && (bot.health || 20) < (config.pvp?.noTotemCombatPearlMinHealth ?? 15)) return null
  if ((bot.health || 20) < (config.pvp?.combatPearlMinHealth || 12) && !hasTotem(bot)) return null
  if (now - lastCombatPearlAt < (config.pvp?.combatPearlCooldownMs || 2600)) return null
  if (dangerousCombatFooting(bot)) return null
  if (situation?.pressure || situation?.crystalReady) return null

  const minRange = config.pvp?.combatPearlMinRange || 5.8
  const maxRange = config.pvp?.combatPearlMaxRange || 18
  if (distance < minRange || distance > maxRange) return null
  if (arenaCenter && horizontalDistance(target.position, arenaCenter) > arenaRadius - 0.5) return null

  return combatPearlReason(distance, situation, config)
}

function combatPearlReason (distance, situation = {}, config = {}) {
  if (situation.finish && distance >= (config.pvp?.combatPearlFinishRange || 5.2)) return 'execute_blink'
  if (situation.targetTotemPopped && distance >= (config.pvp?.tempoTargetPopPearlRange || 6.0)) return 'totem_pop_blink'
  if (situation.tempo?.pressureOverdue && distance >= (config.pvp?.tempoPressurePearlRange || 7.5)) return 'tempo_reentry'
  if ((situation.runner || situation.opponentKiter) && distance >= (config.pvp?.combatPearlRunnerRange || 7.2)) return 'runner_cutoff'
  if (situation.opponentRanged && distance >= (config.pvp?.combatPearlAntiBowRange || 6.6)) return 'anti_bow_blink'
  if ((situation.comboBroken || situation.tradeLost) && distance >= (config.pvp?.combatPearlComboRange || 6.2)) return 'combo_reentry'
  if (situation.targetHigh && distance >= (config.pvp?.combatPearlHighGroundRange || 7.5)) return 'high_ground_blink'
  if (situation.combatDecision?.action === 'chase' && distance >= (config.pvp?.combatPearlChaseRange || 8.2)) return 'chase_blink'
  return null
}

function combatPearlAimPoint (bot, target, config = {}, situation = {}, arenaCenter = null, arenaRadius = 18) {
  const distance = bot.entity.position.distanceTo(target.position)
  const base = situation?.predictedTargetPosition
    ? asVec3(situation.predictedTargetPosition)
    : target.position.clone()
  const velocity = target.velocity || new Vec3(0, 0, 0)
  const maxLead = config.pvp?.combatPearlMaxLead || 4
  const leadTicks = clamp(distance * (config.pvp?.combatPearlLeadScale || 0.22), 0.8, maxLead)
  let aim = base.offset(
    clamp(velocity.x * leadTicks, -maxLead, maxLead),
    situation.targetHigh ? 1.45 : 1.1,
    clamp(velocity.z * leadTicks, -maxLead, maxLead)
  )

  if (situation.finish || situation.runner || situation.opponentKiter || situation.opponentRanged) {
    const dx = base.x - bot.entity.position.x
    const dz = base.z - bot.entity.position.z
    const length = Math.sqrt(dx * dx + dz * dz)
    if (length > 0.001) {
      const extra = config.pvp?.combatPearlForwardCutoff || 0.85
      aim = aim.offset((dx / length) * extra, 0, (dz / length) * extra)
    }
  }

  if (arenaCenter) {
    aim = clampPointToArena(aim, arenaCenter, Math.max(2, arenaRadius - (config.pvp?.combatPearlArenaBuffer ?? 1.5)))
  }
  return aim
}

function clampPointToArena (point, center, radius) {
  const dx = point.x - center.x
  const dz = point.z - center.z
  const length = Math.sqrt(dx * dx + dz * dz)
  if (length <= radius || length < 0.001) return point
  return new Vec3(
    center.x + (dx / length) * radius,
    point.y,
    center.z + (dz / length) * radius
  )
}

async function throwCombatEnderPearl (bot, target, config = {}, situation = {}, arenaCenter = null, arenaRadius = 18) {
  const pearl = findInventoryItem(bot, item => item.name === 'ender_pearl')
  if (!pearl || !target?.isValid) return false

  const aim = combatPearlAimPoint(bot, target, config, situation, arenaCenter, arenaRadius)
  bot.pathfinder?.stop()
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  bot.setControlState('back', false)
  await bot.equip(pearl, 'hand')
  await bot.lookAt(aim, true).catch(() => {})
  await sleep(config.pvp?.combatPearlWindupMs ?? 30)
  bot.activateItem()
  await sleep(config.pvp?.combatPearlAfterThrowMs ?? 90)
  return true
}

async function throwEnderPearlAtFallLanding (bot, target, config = {}) {
  const pearl = findInventoryItem(bot, item => item.name === 'ender_pearl')
  if (!pearl) return false

  const velocity = bot.entity.velocity || new Vec3(0, 0, 0)
  const floor = findFloorBelow(bot, config.pvp?.fallPearlReach || 32)
  let aim
  if (floor && isSolidFloor(floor)) {
    aim = floor.position.offset(
      0.5 + clamp((velocity.x || 0) * 5, -3.5, 3.5),
      1.05,
      0.5 + clamp((velocity.z || 0) * 5, -3.5, 3.5)
    )
  } else if (target?.isValid) {
    aim = target.position.offset(0, 1.2, 0)
  } else {
    aim = bot.entity.position.offset(
      clamp((velocity.x || 0) * 10, -8, 8),
      -4,
      clamp((velocity.z || 0) * 10, -8, 8)
    )
  }

  await bot.equip(pearl, 'hand')
  await bot.lookAt(aim, true).catch(() => {})
  await sleep(config.pvp?.fallPearlWindupMs ?? 35)
  bot.activateItem()
  await sleep(config.pvp?.fallPearlAfterThrowMs ?? 120)
  return true
}

async function recoverElytraMaceFall (bot, target, config, signal, recovery, training = null, swungThisTick = false) {
  if (signal?.cancelled || bot.entity?.onGround) return { recovered: false, abort: false }
  const fallSpeed = -(bot.entity?.velocity?.y || 0)
  const fallHeight = heightAboveGround(bot, config.pvp?.elytraMaceFallScan || 24)
  const minHeight = config.pvp?.elytraMaceFallSaveMinHeight || 4
  if (fallSpeed < (config.pvp?.elytraMaceFallSpeed || 0.18) || fallHeight < minHeight) {
    return { recovered: false, abort: false }
  }
  if (!recovery.fallRecoveryLogged) {
    recordTraining({ training }, 'fall_recovery', { height: roundMetric(fallHeight, 2), speed: roundMetric(fallSpeed, 3) })
    recovery.fallRecoveryLogged = true
  }

  if (fallHeight >= (config.pvp?.elytraMaceTotemFallHeight || 10)) {
    await equipBestTotem(bot).catch(() => null)
  }

  if (bot.entity.elytraFlying) {
    const rocketCooldown = config.pvp?.elytraMaceRecoveryRocketCooldownMs || 700
    await steerSafeElytraFall(bot, config, { target }).catch(() => {})
    if (
      !swungThisTick &&
      shouldUseFallRecoveryRocket(bot, fallHeight, config) &&
      findInventoryItem(bot, item => item.name === 'firework_rocket') &&
      Date.now() - recovery.lastRocketAt > rocketCooldown
    ) {
      await bot.lookAt(fallRecoveryAimPoint(bot, target, config), true).catch(() => {})
      await useFireworkRocket(bot).catch(() => false)
      recovery.lastRocketAt = Date.now()
      await sleep(config.pvp?.elytraMaceWeaponSwapMs ?? 30)
      return { recovered: true, abort: false }
    }
  }

  if (!bot.entity.elytraFlying && equippedItem(bot, 'torso')?.name === 'elytra' && typeof bot.elytraFly === 'function') {
    await bot.lookAt((target?.isValid ? target.position : bot.entity.position).offset(0, config.pvp?.elytraMaceRecoveryAimHeight || 2.5, 0), true).catch(() => {})
    await bot.elytraFly().catch(() => {})
    sendStartElytraFlying(bot)
    await sleep(config.pvp?.elytraMaceRecoveryCheckMs ?? 80)
    if (bot.entity.elytraFlying) {
      const rocketCooldown = config.pvp?.elytraMaceRecoveryRocketCooldownMs || 700
      await steerSafeElytraFall(bot, config, { target }).catch(() => {})
      if (
        !swungThisTick &&
        shouldUseFallRecoveryRocket(bot, fallHeight, config) &&
        findInventoryItem(bot, item => item.name === 'firework_rocket') &&
        Date.now() - recovery.lastRocketAt > rocketCooldown
      ) {
        await useFireworkRocket(bot).catch(() => false)
        recovery.lastRocketAt = Date.now()
        await sleep(config.pvp?.elytraMaceWeaponSwapMs ?? 30)
      }
      return { recovered: true, abort: false }
    }
  }

  if (!recovery.waterBucketUsed && fallHeight <= (config.pvp?.elytraMaceWaterBucketTriggerHeight || 5.5)) {
    recovery.waterBucketUsed = true
    const clutched = await clutchWaterBucket(bot, config).catch(() => false)
    if (clutched) {
      recordTraining({ training }, 'water_clutch', { height: roundMetric(fallHeight, 2) })
      return { recovered: true, abort: true }
    }
  }

  return { recovered: false, abort: false }
}

async function clutchWaterBucket (bot, config) {
  const bucket = findInventoryItem(bot, item => item.name === 'water_bucket')
  if (!bucket) return false
  const floor = findFloorBelow(bot, config.pvp?.fallWaterBucketReach || config.pvp?.elytraMaceWaterBucketReach || 6)
  if (!floor || !isSolidFloor(floor)) return false
  const landing = bot.blockAt(floor.position.offset(0, 1, 0))
  if (!isPassable(landing)) return false

  await bot.equip(bucket, 'hand')
  await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true).catch(() => {})
  let placed = false
  if (typeof bot.activateBlock === 'function') {
    placed = await bot.activateBlock(floor, new Vec3(0, 1, 0))
      .then(() => true)
      .catch(() => false)
  }
  await sleep(config.pvp?.fallWaterBucketWaitMs ?? config.pvp?.elytraMaceWaterBucketWaitMs ?? 120)
  return placed
}

async function steerElytraMace (bot, target, config, arenaCenter = null, arenaRadius = 18) {
  const edgeBuffer = config.pvp?.elytraMaceArenaEdgeBuffer ?? 2.5
  const distance = bot.entity.position.distanceTo(target.position)
  const heightAdvantage = bot.entity.position.y - target.position.y
  const aimTarget = predictedElytraMacePosition(target, distance, config)
  let aimPoint

  if (arenaCenter && horizontalDistance(bot.entity.position, arenaCenter) > arenaRadius - edgeBuffer) {
    aimPoint = arenaCenter.offset(0, Math.max(1.5, target.position.y - arenaCenter.y + 1.5), 0)
  } else if (heightAdvantage < (config.pvp?.elytraMaceDiveHeight || 2.4) && distance > 5) {
    aimPoint = aimTarget.offset(0, config.pvp?.elytraMaceClimbAimHeight || 5, 0)
  } else {
    aimPoint = aimTarget.offset(0, config.pvp?.elytraMaceStrikeAimHeight || 0.75, 0)
  }

  await bot.lookAt(aimPoint, true).catch(() => {})
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  bot.setControlState('jump', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
}

function sendStartElytraFlying (bot) {
  if (!bot?._client || bot.entity?.id == null) return false
  const entityId = bot.entity.id
  try {
    bot._client.write('entity_action', { entityId, actionId: 'start_elytra_flying', jumpBoost: 0 })
    return true
  } catch {
    try {
      bot._client.write('entity_action', { entityId, actionId: 6, jumpBoost: 0 })
      return true
    } catch {
      return false
    }
  }
}

function predictedElytraMacePosition (target, distance = 0, config = {}) {
  const velocity = target?.velocity || new Vec3(0, 0, 0)
  const leadTicks = clamp(
    (config.pvp?.elytraMaceLeadTicks || 7) + Math.max(0, distance - 6) * (config.pvp?.elytraMaceLeadTicksPerBlock || 0.18),
    0,
    config.pvp?.elytraMaceMaxLeadTicks || 11
  )
  const maxLead = config.pvp?.elytraMaceMaxLeadBlocks || 4.5
  return target.position.offset(
    clamp((velocity.x || 0) * leadTicks, -maxLead, maxLead),
    0,
    clamp((velocity.z || 0) * leadTicks, -maxLead, maxLead)
  )
}

function shouldUseSecondMaceRocket (bot, target, distance, config, arenaCenter = null, arenaRadius = 18) {
  if (config.pvp?.elytraMaceSecondRocket === false) return false
  if (!bot.entity.elytraFlying) return false
  if (distance < (config.pvp?.elytraMaceSecondRocketRange || 12)) return false
  if (!findInventoryItem(bot, item => item.name === 'firework_rocket')) return false
  if (arenaCenter && horizontalDistance(bot.entity.position, arenaCenter) > arenaRadius - (config.pvp?.elytraMaceArenaEdgeBuffer ?? 2.5) - 1) return false
  if (target?.position && arenaCenter && horizontalDistance(target.position, arenaCenter) > arenaRadius - (config.pvp?.elytraMaceArenaEdgeBuffer ?? 2.5) - 1) return false
  return true
}

async function equipElytra (bot) {
  const torso = equippedItem(bot, 'torso')
  if (torso?.name === 'elytra' && durabilityOk(torso)) return torso
  const elytra = findInventoryItem(bot, item => item.name === 'elytra' && durabilityOk(item))
  if (!elytra) return null
  await bot.equip(elytra, 'torso')
  return elytra
}

async function equipMace (bot) {
  if (bot.heldItem?.name === 'mace') return bot.heldItem
  const mace = findInventoryItem(bot, item => item.name === 'mace')
  if (!mace) return null
  await bot.equip(mace, 'hand')
  return mace
}

async function useFireworkRocket (bot) {
  const rocket = findInventoryItem(bot, item => item.name === 'firework_rocket')
  if (!rocket) return false
  await bot.equip(rocket, 'hand')
  await sleep(25)
  bot.activateItem()
  return true
}

async function restoreBestChestplate (bot, config = {}) {
  const torso = equippedItem(bot, 'torso')
  if (torso?.name !== 'elytra') return true

  const waitUntil = Date.now() + (config.pvp?.elytraMaceChestplateBackMs ?? 650)
  const safeHeight = config.pvp?.elytraMaceChestplateSafeHeight ?? 2.5
  while (Date.now() < waitUntil && !bot.entity?.onGround && heightAboveGround(bot) > safeHeight) {
    await sleep(50)
  }
  if (!bot.entity?.onGround && heightAboveGround(bot) > safeHeight) return false

  const chestplate = bestChestplate(bot)
  if (!chestplate) return false
  await bot.equip(chestplate, 'torso')
  return true
}

function hasElytraMaceLoadout (bot) {
  const hasElytra = equippedItem(bot, 'torso')?.name === 'elytra' ||
    Boolean(findInventoryItem(bot, item => item.name === 'elytra' && durabilityOk(item)))
  const hasMace = bot.heldItem?.name === 'mace' || Boolean(findInventoryItem(bot, item => item.name === 'mace'))
  const hasRocket = Boolean(findInventoryItem(bot, item => item.name === 'firework_rocket'))
  return hasElytra && hasMace && hasRocket
}

function bestChestplate (bot) {
  return bot.inventory.items()
    .filter(item => item.name.endsWith('_chestplate') && durabilityOk(item))
    .sort((a, b) => armorScore(b) - armorScore(a))[0] || null
}

function heightAboveGround (bot, maxScan = 10) {
  const pos = bot.entity.position.floored()
  for (let y = 1; y <= maxScan; y++) {
    const floor = bot.blockAt(pos.offset(0, -y, 0))
    if (isSolidFloor(floor)) return bot.entity.position.y - (floor.position.y + 1)
  }
  return maxScan + 1
}

function hasLaunchHeadroom (bot, height = 4) {
  const pos = bot.entity.position.floored()
  for (let y = 1; y <= height; y++) {
    if (!isPassable(bot.blockAt(pos.offset(0, y, 0)))) return false
  }
  return true
}

function findFloorBelow (bot, maxScan = 6) {
  const pos = bot.entity.position.floored()
  for (let y = 1; y <= maxScan; y++) {
    const floor = bot.blockAt(pos.offset(0, -y, 0))
    if (isSolidFloor(floor)) return floor
  }
  return null
}

function shouldUseBow (bot, target, distance, verticalGap, playerFight, config, now, lastBowAt, enemyGear = {}, situation = null) {
  if (!playerFight && !['creeper', 'witch'].includes(target?.name)) return false
  if (!hasBowLoadout(bot)) return false
  if (config.pvp?.highPressureMeleeMode && target?.type === 'player') {
    const forcedRanged = situation?.targetHigh || situation?.runner || situation?.opponentRanged
    if (!forcedRanged || distance < (config.pvp?.highPressureBowMinRange || 14)) return false
  }
  if (situation?.pressure && distance < (config.pvp?.pressureBowMinRange || 8.5)) return false
  if (situation?.finish && distance < (config.pvp?.finishBowMinRange || 11)) return false
  if (enemyGear.shield && target?.type === 'player' && !situation?.runner && !situation?.targetHigh) return false
  if (enemyGear.weaponType === 'bow' || enemyGear.weaponType === 'crossbow') return false
  const minRange = situation?.runner || situation?.targetHigh
    ? Math.max(4.8, (config.pvp?.bowMinRange || 6.2) - 1.2)
    : config.pvp?.bowMinRange || 6.2
  const maxRange = config.pvp?.bowMaxRange || 24
  if (distance < minRange || distance > maxRange) return false
  const maxVertical = situation?.targetHigh ? (config.pvp?.highGroundBowVerticalGap || 14) : (config.pvp?.bowMaxVerticalGap || 8)
  if (Math.abs(verticalGap) > maxVertical) return false
  if (now - lastBowAt < (config.pvp?.bowCooldownMs || 1450)) return false
  if (bot.health <= Math.max(config.pvp?.retreatHealth || 0, 8)) return false
  return true
}

async function shootBowAtTarget (bot, target, config, signal) {
  const bow = bot.inventory.items().find(item => item.name === 'bow' && durabilityOk(item))
  if (!bow || !hasArrow(bot)) return false
  await bot.equip(bow, 'hand')
  const chargeMs = config.pvp?.bowChargeMs || 950
  await aimBowAtTarget(bot, target, config, chargeMs).catch(() => {})
  let activated = false
  try {
    bot.activateItem()
    activated = true
    const started = Date.now()
    const correctionMs = config.pvp?.bowAimCorrectionMs || 65
    while (!signal?.cancelled && target?.isValid && Date.now() - started < chargeMs) {
      await aimBowAtTarget(bot, target, config, chargeMs).catch(() => {})
      await sleep(Math.min(correctionMs, Math.max(0, chargeMs - (Date.now() - started))))
    }
    if (signal?.cancelled || !target?.isValid) return false
    await aimBowAtTarget(bot, target, config, chargeMs).catch(() => {})
    bot.deactivateItem()
    activated = false
    return true
  } finally {
    if (activated) lowerShield(bot)
  }
}

async function aimBowAtTarget (bot, target, config, chargeMs) {
  const aim = predictedBowAim(bot, target, config, chargeMs)
  if (aim.yaw != null && aim.pitch != null) {
    await bot.look(aim.yaw, aim.pitch, true)
    return aim
  }
  await bot.lookAt(aim.point, true)
  return aim
}

function predictedBowAim (bot, target, config = {}, chargeMs = 950) {
  const origin = bowEyePosition(bot)
  const speed = bowArrowSpeed(chargeMs, config)
  const gravity = config.pvp?.bowGravity ?? 0.05
  const leadScale = config.pvp?.bowLeadScale ?? 1
  const maxLead = config.pvp?.bowMaxLeadBlocks ?? 4.5
  let aimTarget = targetBowPoint(target, config)
  let solution = null

  for (let i = 0; i < (config.pvp?.bowAimIterations || 4); i++) {
    solution = solveBowArc(origin, aimTarget, speed, gravity)
    const flightTicks = solution?.flightTicks || estimateArrowFlightTicks(origin, aimTarget, speed)
    const velocity = target.velocity || new Vec3(0, 0, 0)
    aimTarget = targetBowPoint(target, config).offset(
      clamp(velocity.x * flightTicks * leadScale, -maxLead, maxLead),
      clamp(velocity.y * flightTicks * leadScale, -maxLead * 0.4, maxLead * 0.4),
      clamp(velocity.z * flightTicks * leadScale, -maxLead, maxLead)
    )
  }

  solution = solveBowArc(origin, aimTarget, speed, gravity)
  if (solution) return solution

  const fallback = heuristicBowAim(origin, aimTarget, config)
  return {
    point: fallback,
    yaw: null,
    pitch: null,
    flightTicks: estimateArrowFlightTicks(origin, aimTarget, speed)
  }
}

function solveBowArc (origin, target, speed, gravity) {
  const dx = target.x - origin.x
  const dz = target.z - origin.z
  const dy = target.y - origin.y
  const horizontal = Math.sqrt(dx * dx + dz * dz)
  if (horizontal < 0.001) return null

  const v2 = speed * speed
  const root = v2 * v2 - gravity * (gravity * horizontal * horizontal + 2 * dy * v2)
  if (root < 0) return null

  const theta = Math.atan((v2 - Math.sqrt(root)) / (gravity * horizontal))
  const yaw = Math.atan2(-dx, -dz)
  const pitch = -theta
  const flightTicks = horizontal / Math.max(0.01, speed * Math.cos(theta))
  const aimY = origin.y + Math.tan(theta) * horizontal
  return {
    point: new Vec3(target.x, aimY, target.z),
    yaw,
    pitch,
    flightTicks
  }
}

function bowEyePosition (bot) {
  const height = bot.entity?.height || 1.8
  return bot.entity.position.offset(0, height * 0.9, 0)
}

function targetBowPoint (target, config) {
  const height = target.height || 1.8
  const ratio = config.pvp?.bowTargetHeightRatio ?? 0.68
  return target.position.offset(0, height * ratio, 0)
}

function bowArrowSpeed (chargeMs, config) {
  const chargeTicks = clamp(chargeMs / 50, 1, 20)
  let power = chargeTicks / 20
  power = (power * power + power * 2) / 3
  power = clamp(power, 0.1, 1)
  return (config.pvp?.bowArrowSpeed || 3.0) * power
}

function estimateArrowFlightTicks (origin, target, speed) {
  const dx = target.x - origin.x
  const dz = target.z - origin.z
  return Math.sqrt(dx * dx + dz * dz) / Math.max(speed * 0.82, 0.1)
}

function heuristicBowAim (origin, target, config) {
  const horizontal = horizontalDistance(origin, target)
  const arc = clamp(horizontal * horizontal * (config.pvp?.bowFallbackArcScale ?? 0.0026), 0, config.pvp?.bowFallbackMaxArc ?? 3.2)
  return target.offset(0, arc, 0)
}

function applyRangedStrafe (bot, strafe) {
  bot.pathfinder.stop()
  bot.setControlState('left', strafe < 0)
  bot.setControlState('right', strafe > 0)
  bot.setControlState('back', false)
  bot.setControlState('forward', false)
  bot.setControlState('sprint', true)
}

function shouldUseCrystal (bot, target, distance, config, now, lastCrystalAt, attackReady = false, spacing = null, targetShielding = false, crystalBlockedUntil = 0, situation = null) {
  if (config.pvp?.crystalsEnabled === false) return false
  if (target?.type !== 'player') return false
  if (!hasCrystalLoadout(bot)) return false
  if (config.pvp?.highPressureMeleeMode && (situation?.comboMomentum || situation?.hitConfirmed)) return false
  const health = bot.health || 20
  const equippedTotem = hasEquippedTotem(bot)
  const anyTotem = hasTotem(bot)
  if (!anyTotem && config.pvp?.noTotemCrystalsEnabled === false) return false
  if (!anyTotem && health <= (config.pvp?.noTotemCrystalMinHealth ?? config.pvp?.crystalNoTotemMinHealth ?? 17)) return false
  if (health <= (config.pvp?.crystalMinHealth || 8) && !equippedTotem) return false
  if (!equippedTotem && health <= (config.pvp?.crystalNoTotemMinHealth || 15)) return false
  if (situation?.pressure && health <= (config.pvp?.crystalPressureMinHealth || 14)) return false
  if (now - lastCrystalAt < (config.pvp?.crystalCooldownMs || 1200)) return false
  if (now < crystalBlockedUntil) return false
  if (distance < (config.pvp?.crystalMinRange || 2.4)) return false
  if (config.pvp?.highPressureMeleeMode && distance < (config.pvp?.crystalHighPressureMinRange || 4.2) && !targetShielding) return false
  if (distance > (config.pvp?.crystalMaxRange || 5.8)) return false
  if (situation?.pressure && distance < (config.pvp?.pressureCrystalMinRange || 3.4)) return false
  if (Math.abs(target.position.y - bot.entity.position.y) > (config.pvp?.crystalMaxVerticalGap || 2.2)) return false
  if (config.pvp?.crystalRequireOpportunity !== false) {
    const meleePriorityRange = config.pvp?.crystalMeleePriorityRange || spacing?.hit || 3.35
    if (distance <= meleePriorityRange && attackReady && !targetShielding && !situation?.outnumbered) return false
  }
  return true
}

async function crystalBurst (bot, target, config, signal, nearbyTargets = null, deadlineAt = null, training = null) {
  const count = config.pvp?.crystalBurstCount || 2
  const delay = config.pvp?.crystalBurstDelayMs ?? 65
  let used = 0
  for (let i = 0; i < count; i++) {
    if (signal?.cancelled || !target?.isValid || deadlineExpired(deadlineAt)) break
    const ok = await crystalCombo(bot, bestCrystalTarget(bot, target, nearbyTargets, config), config, signal, nearbyTargets, deadlineAt, training).catch(() => false)
    if (!ok) break
    if (deadlineExpired(deadlineAt)) break
    used++
    if (i < count - 1) await sleep(delay)
  }
  return used > 0
}

async function crystalCombo (bot, target, config, signal, nearbyTargets = null, deadlineAt = null, training = null) {
  if (deadlineExpired(deadlineAt)) return false
  if (await detonateNearbyCrystal(bot, target, config, nearbyTargets, null, training, 'combo_existing').catch(() => false)) return true

  const placement = findCrystalPlacement(bot, target, config)
  if (!placement) {
    recordTraining({ training }, 'crystal_risk_skip', {
      target: targetLabel(target),
      reason: 'no_safe_placement',
      distance: target?.position && bot.entity ? roundMetric(target.position.distanceTo(bot.entity.position), 2) : null
    })
    return false
  }
  recordTraining({ training }, 'crystal_exposure_check', {
    target: targetLabel(target),
    enemyDamage: placement.profile?.enemyDamage,
    selfDamage: placement.profile?.selfDamage,
    enemyExposure: placement.profile?.enemyExposure,
    selfExposure: placement.profile?.selfExposure,
    score: placement.profile?.score
  })
  const obsidian = bot.inventory.items().find(item => item.name === 'obsidian')
  const crystal = bot.inventory.items().find(item => item.name === 'end_crystal')
  if (!obsidian || !crystal) return false

  const reach = config.pvp?.crystalPlaceReach || 4.2
  if (bot.entity.position.distanceTo(placement.pos.offset(0.5, 0.5, 0.5)) > reach) {
    const moveMs = Math.min(config.pvp?.crystalMoveTimeoutMs || 450, timeLeft(deadlineAt, config.pvp?.crystalMoveTimeoutMs || 450))
    await withTimeout(goNear(bot, placement.pos, 2.8, signal, moveMs), moveMs + 80, 'crystal move').catch(() => {})
  }
  if (signal?.cancelled || deadlineExpired(deadlineAt)) return false

  let baseBlock = bot.blockAt(placement.pos)
  if (!baseBlock || !['obsidian', 'bedrock'].includes(baseBlock.name)) {
    const floor = bot.blockAt(placement.pos.offset(0, -1, 0))
    if (!isPassable(baseBlock) || !isSolidFloor(floor)) return false
    if (deadlineExpired(deadlineAt)) return false
    await bot.equip(obsidian, 'hand')
    await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true).catch(() => {})
    await withTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)), Math.min(config.pvp?.crystalPlaceTimeoutMs || 260, timeLeft(deadlineAt, 260)), 'obsidian place')
    await sleep(config.pvp?.crystalBasePlaceDelayMs ?? 55)
    if (deadlineExpired(deadlineAt)) return false
    baseBlock = bot.blockAt(placement.pos)
  }

  if (!baseBlock || !['obsidian', 'bedrock'].includes(baseBlock.name)) return false
  if (!crystalSpaceClear(bot, placement.pos)) return false
  if (deadlineExpired(deadlineAt)) return false

  await bot.equip(crystal, 'hand')
  await bot.lookAt(baseBlock.position.offset(0.5, 1, 0.5), true).catch(() => {})
  const placed = await withTimeout(bot.placeBlock(baseBlock, new Vec3(0, 1, 0)), Math.min(config.pvp?.crystalPlaceTimeoutMs || 260, timeLeft(deadlineAt, 260)), 'crystal place')
    .then(() => true)
    .catch(async () => {
      if (typeof bot.activateBlock !== 'function') return false
      return withTimeout(bot.activateBlock(baseBlock), Math.min(config.pvp?.crystalPlaceTimeoutMs || 260, timeLeft(deadlineAt, 260)), 'crystal activate')
        .then(() => true)
        .catch(() => false)
    })
  if (!placed && !nearestCrystalAt(bot, placement.pos, 2.2)) return false
  await sleep(config.pvp?.crystalDetonateDelayMs ?? 35)
  if (deadlineExpired(deadlineAt)) return false
  return detonateCrystalUntil(bot, target, config, nearbyTargets, placement.pos, deadlineAt, training).catch(() => false)
}

function deadlineExpired (deadlineAt) {
  return Number.isFinite(deadlineAt) && Date.now() > deadlineAt
}

function timeLeft (deadlineAt, fallbackMs) {
  if (!Number.isFinite(deadlineAt)) return fallbackMs
  return Math.max(1, deadlineAt - Date.now())
}

function withTimeout (promise, timeoutMs, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, timeoutMs)))
  ])
}

async function detonateCrystalUntil (bot, target, config, nearbyTargets = null, placedPos = null, deadlineAt = null, training = null) {
  const endAt = Math.min(
    Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + (config.pvp?.crystalDetonateRetryMs || 320),
    Date.now() + (config.pvp?.crystalDetonateRetryMs || 320)
  )
  while (Date.now() <= endAt && target?.isValid) {
    if (await detonateNearbyCrystal(bot, target, config, nearbyTargets, placedPos, training, 'placed').catch(() => false)) return true
    await sleep(config.pvp?.crystalDetonateRetryDelayMs ?? 35)
  }
  return false
}

async function detonateNearbyCrystal (bot, target, config, nearbyTargets = null, placedPos = null, training = null, source = 'loose') {
  const targetRange = config.pvp?.crystalTargetBlastRange || 4.5
  const targets = crystalTargets(target, nearbyTargets)
  const skipped = []
  const candidates = Object.values(bot.entities || {})
    .filter(entity => isCrystalEntity(entity))
    .map(entity => {
      const profile = crystalDamageProfile(entity.position, targets, bot, config, placedPos)
      const selfDistance = entity.position.distanceTo(bot.entity.position)
      return { entity, profile, selfDistance }
    })
    .filter(item => {
      const { entity, profile } = item
      if (placedPos && entity.position.distanceTo(placedPos.offset(0.5, 1, 0.5)) <= (config.pvp?.placedCrystalFindRange || 2.4)) return true
      return profile.enemyDamage > 0 && targets.some(enemy => enemy?.isValid && entity.position.distanceTo(enemy.position) <= targetRange)
    })
  const crystal = candidates
    .filter(item => {
      const safe = crystalProfileSafe(item.profile, bot, config, Boolean(placedPos), item.selfDistance)
      if (!safe) skipped.push(item)
      return safe
    })
    .sort((a, b) => b.profile.score - a.profile.score)[0]?.entity
  if (!crystal && skipped.length) {
    const riskiest = skipped.sort((a, b) => b.profile.selfDamage - a.profile.selfDamage)[0]
    recordTraining({ training }, 'crystal_risk_skip', {
      target: targetLabel(target),
      source,
      reason: 'self_damage',
      selfDistance: roundMetric(riskiest.selfDistance, 2),
      selfDamage: riskiest.profile.selfDamage,
      enemyDamage: riskiest.profile.enemyDamage,
      health: roundMetric(bot.health || 0, 2)
    })
  }
  if (!crystal) return false
  await bot.lookAt(crystal.position.offset(0, 0.5, 0), true).catch(() => {})
  bot.attack(crystal)
  return crystal.id || true
}

function nearbyPlayerTargets (options, fallbackTarget) {
  if (typeof options.nearbyPlayers !== 'function') return [fallbackTarget].filter(Boolean)
  const players = options.nearbyPlayers() || []
  return crystalTargets(fallbackTarget, players)
}

function bestCrystalTarget (bot, target, nearbyTargets, config) {
  const targets = crystalTargets(target, nearbyTargets)
    .filter(enemy => enemy?.isValid && enemy.position.distanceTo(bot.entity.position) <= (config.pvp?.crystalMaxRange || 6.2) + 2)
  if (!targets.length) return target
  const clusterRadius = config.pvp?.targetClusterRadius || 4.2
  return targets
    .map(enemy => ({
      enemy,
      score: targets.filter(other => other.id !== enemy.id && other.position.distanceTo(enemy.position) <= clusterRadius).length * 4 -
        enemy.position.distanceTo(bot.entity.position) * 0.4
    }))
    .sort((a, b) => b.score - a.score)[0].enemy
}

function crystalTargets (target, nearbyTargets = null) {
  const targets = [target, ...(Array.isArray(nearbyTargets) ? nearbyTargets : [])]
  const seen = new Set()
  return targets.filter(enemy => {
    if (!enemy?.isValid || seen.has(enemy.id)) return false
    seen.add(enemy.id)
    return true
  })
}

function nearestCrystalAt (bot, pos, range = 2.4) {
  if (!pos) return null
  const center = pos.offset(0.5, 1, 0.5)
  return Object.values(bot.entities || {})
    .filter(entity => isCrystalEntity(entity))
    .filter(entity => entity.position.distanceTo(center) <= range)
    .sort((a, b) => a.position.distanceTo(center) - b.position.distanceTo(center))[0] || null
}

function crystalDamageProfile (position, targets, bot, config = {}, placedPos = null) {
  const blastRadius = config.pvp?.crystalBlastRadius || 6
  const enemyProfiles = targets
    .filter(enemy => enemy?.isValid)
    .map(enemy => {
      const body = enemy.position.offset(0, Math.min(enemy.height || 1.8, 1.4) * 0.45, 0)
      const exposure = crystalExposure(bot, position, enemy, config)
      const damage = crystalBlastEstimate(position.distanceTo(body), blastRadius, config) * exposure * crystalTargetModifier(enemy)
      return { damage, exposure }
    })
  const enemyDamages = enemyProfiles.map(profile => profile.damage)
  const enemyDamage = enemyDamages.length ? Math.max(...enemyDamages) : 0
  const clusteredDamage = enemyDamages.reduce((sum, damage) => sum + damage, 0)
  const clusteredEnemies = enemyDamages.filter(damage => damage > 0).length
  const selfExposure = crystalExposure(bot, position, bot.entity, config)
  const selfDamage = crystalBlastEstimate(position.distanceTo(bot.entity.position.offset(0, 0.9, 0)), blastRadius, config) * selfExposure
  const enemyExposure = enemyProfiles.length
    ? enemyProfiles.reduce((sum, profile) => sum + profile.exposure, 0) / enemyProfiles.length
    : 0
  const placedBonus = placedPos ? Math.max(0, 2.4 - position.distanceTo(placedPos.offset(0.5, 1, 0.5))) * (config.pvp?.crystalPlacedBonus || 2.8) : 0
  const selfPenalty = config.pvp?.crystalSelfDamagePenalty ?? 0.9
  const clusterWeight = config.pvp?.crystalClusterDamageWeight ?? 0.45
  const score = enemyDamage * 2.1 + clusteredDamage * clusterWeight + clusteredEnemies * 0.65 + placedBonus - selfDamage * selfPenalty
  return {
    enemyDamage: roundMetric(enemyDamage, 2),
    clusteredDamage: roundMetric(clusteredDamage, 2),
    selfDamage: roundMetric(selfDamage, 2),
    enemyExposure: roundMetric(enemyExposure, 2),
    selfExposure: roundMetric(selfExposure, 2),
    clusteredEnemies,
    score: roundMetric(score, 2)
  }
}

function crystalBlastEstimate (distance, radius, config = {}) {
  if (!Number.isFinite(distance) || distance >= radius) return 0
  const exposure = clamp(1 - distance / radius, 0, 1)
  return (exposure * exposure + exposure) * (config.pvp?.crystalDamageScale || 6)
}

function crystalExposure (bot, origin, entity, config = {}) {
  if (config.pvp?.crystalExposureEnabled === false) return 1
  const samples = crystalExposurePoints(entity, config)
  if (!samples.length) return 1
  const clear = samples.filter(point => rayPassable(bot, origin, point, config)).length
  return clamp(clear / samples.length, config.pvp?.crystalMinExposureFloor ?? 0.08, 1)
}

function crystalExposurePoints (entity, config = {}) {
  if (!entity?.position) return []
  const height = entity.height || 1.8
  const shoulder = Math.min(height * 0.72, height - 0.2)
  const center = Math.min(height * 0.45, 1.0)
  const side = config.pvp?.crystalExposureSideOffset ?? 0.32
  return [
    entity.position.offset(0, 0.15, 0),
    entity.position.offset(0, center, 0),
    entity.position.offset(0, shoulder, 0),
    entity.position.offset(side, center, 0),
    entity.position.offset(-side, center, 0),
    entity.position.offset(0, center, side),
    entity.position.offset(0, center, -side)
  ]
}

function rayPassable (bot, from, to, config = {}) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (distance < 0.001) return true
  const step = config.pvp?.crystalExposureStep || 0.45
  const steps = Math.min(config.pvp?.crystalExposureMaxSteps || 18, Math.max(2, Math.ceil(distance / step)))
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const pos = new Vec3(from.x + dx * t, from.y + dy * t, from.z + dz * t).floored()
    const block = bot.blockAt(pos)
    if (!isPassable(block)) return false
  }
  return true
}

function crystalTargetModifier (target) {
  if (!target || target.type !== 'player') return 1
  const gear = readTargetGear(target)
  const armor = targetPvpGearScore(target)
  const armorFactor = clamp(1.12 - armor / 1050, 0.72, 1.12)
  const totemFactor = gear.totem ? 0.92 : 1
  return armorFactor * totemFactor
}

function crystalProfileSafe (profile, bot, config = {}, forcedPlaced = false, selfDistance = Infinity) {
  const minEnemy = forcedPlaced
    ? (config.pvp?.crystalPlacedMinEnemyDamage ?? Math.min(0.8, config.pvp?.crystalMinEnemyDamage ?? 1.2))
    : (config.pvp?.crystalMinEnemyDamage ?? 1.2)
  if ((profile?.enemyDamage || 0) < minEnemy) return false
  const health = bot.health || 20
  const equippedTotem = hasEquippedTotem(bot)
  const anyTotem = hasTotem(bot)
  const noTotem = !anyTotem
  const hardMin = equippedTotem
    ? (config.pvp?.crystalTotemSelfHardMinRange ?? 2.9)
    : noTotem
      ? (config.pvp?.noTotemCrystalSelfHardMinRange ?? config.pvp?.crystalSelfHardMinRange ?? 4.4)
      : (config.pvp?.crystalSelfHardMinRange ?? 3.6)
  const lowHealthMin = health <= (config.pvp?.crystalLowHealthHardMinHealth ?? 14)
    ? (config.pvp?.crystalLowHealthSelfHardMinRange ?? 4.4)
    : hardMin
  if (selfDistance < Math.max(hardMin, lowHealthMin)) return false
  const safetyMultiplier = noTotem
    ? (config.pvp?.noTotemCrystalSelfDamageSafetyMultiplier ?? config.pvp?.crystalSelfDamageSafetyMultiplier ?? 2.8)
    : (config.pvp?.crystalSelfDamageSafetyMultiplier ?? 2.2)
  const estimatedSelf = (profile?.selfDamage || 0) * safetyMultiplier
  const lethalMargin = noTotem
    ? (config.pvp?.noTotemCrystalLethalMargin ?? config.pvp?.crystalLethalMargin ?? 8)
    : (config.pvp?.crystalLethalMargin ?? 5)
  if (estimatedSelf >= Math.max(0, health - lethalMargin)) return false
  const maxSelf = equippedTotem
    ? (config.pvp?.crystalTotemSelfDamageLimit ?? 14)
    : noTotem
      ? (config.pvp?.noTotemCrystalMaxSelfDamage ?? config.pvp?.crystalMaxSelfDamage ?? 4.2)
      : (config.pvp?.crystalMaxSelfDamage ?? 8)
  if (estimatedSelf > maxSelf) return false
  const ratio = noTotem
    ? (config.pvp?.noTotemCrystalMinEnemySelfRatio ?? config.pvp?.crystalMinEnemySelfRatio ?? 1.25)
    : (config.pvp?.crystalMinEnemySelfRatio ?? 0.45)
  const flatEnemyBonus = noTotem ? (config.pvp?.noTotemCrystalFlatEnemyBonus ?? 3) : 1.5
  return equippedTotem || (profile.enemyDamage >= estimatedSelf * ratio) || profile.enemyDamage >= minEnemy + flatEnemyBonus
}

function findCrystalPlacement (bot, target, config) {
  const base = target.position.floored()
  const offsets = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2]
  ]
  return offsets
    .map(([x, z]) => ({ pos: base.offset(x, 0, z), x, z }))
    .filter(candidate => canUseCrystalBase(bot, candidate.pos, target, config))
    .map(candidate => {
      const profile = crystalDamageProfile(candidate.pos.offset(0.5, 1, 0.5), [target], bot, config, candidate.pos)
      const selfDistance = candidate.pos.offset(0.5, 1, 0.5).distanceTo(bot.entity.position)
      return {
        ...candidate,
        profile,
        selfDistance,
        score: crystalPlacementScore(candidate.pos, bot, target, config, profile)
      }
    })
    .filter(candidate => crystalProfileSafe(candidate.profile, bot, config, false, candidate.selfDistance))
    .sort((a, b) => b.score - a.score)[0] || null
}

function canUseCrystalBase (bot, pos, target, config) {
  const center = pos.offset(0.5, 0, 0.5)
  const crystalCenter = pos.offset(0.5, 1, 0.5)
  if (horizontalDistance(center, target.position) < 0.75) return false
  if (crystalCenter.distanceTo(bot.entity.position) < (config.pvp?.crystalPlacementSelfMinRange || config.pvp?.crystalSelfHardMinRange || 3.4)) return false
  const base = bot.blockAt(pos)
  if (base && ['obsidian', 'bedrock'].includes(base.name)) return crystalSpaceClear(bot, pos)
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  return isPassable(base) && isSolidFloor(floor) && crystalSpaceClear(bot, pos)
}

function crystalSpaceClear (bot, pos) {
  return isPassable(bot.blockAt(pos.offset(0, 1, 0))) && isPassable(bot.blockAt(pos.offset(0, 2, 0)))
}

function crystalPlacementScore (pos, bot, target, config = {}, profile = null) {
  const center = pos.offset(0.5, 0, 0.5)
  const placementProfile = profile || crystalDamageProfile(pos.offset(0.5, 1, 0.5), [target], bot, config, pos)
  const reach = config.pvp?.crystalPlaceReach || 4.2
  const reachPenalty = Math.max(0, bot.entity.position.distanceTo(center) - reach) * (config.pvp?.crystalReachPenalty || 0.8)
  const targetDistancePenalty = horizontalDistance(center, target.position) * (config.pvp?.crystalTargetDistancePenalty || 0.18)
  return placementProfile.score - reachPenalty - targetDistancePenalty
}

function isCrystalEntity (entity) {
  if (!entity?.isValid) return false
  const name = String(entity.name || entity.displayName || '').toLowerCase()
  return name === 'end_crystal' || name === 'ender_crystal' || name.includes('end crystal')
}

function hasCrystalLoadout (bot) {
  return bot.inventory.items().some(item => item.name === 'end_crystal') &&
    bot.inventory.items().some(item => item.name === 'obsidian')
}

function nearbyCrystalThreat (bot, config = {}) {
  const range = config.pvp?.totemCrystalThreatRange || 5.5
  return Object.values(bot.entities || {})
    .some(entity => isCrystalEntity(entity) && entity.position.distanceTo(bot.entity.position) <= range)
}

async function shouldUseTotem (bot, target, distance, config, recentlyDamaged = false, verticalGap = 0, situation = null) {
  if (!hasTotem(bot)) return false
  if (shouldFavorTotemForCrystalKit(bot, target, distance, config)) return true
  if ((bot.health || 20) <= (config.pvp?.totemHealth || 7)) return true
  const gear = readTargetGear(target)
  if (situation?.pressure && bot.health <= (config.pvp?.totemPressureHealth || 14)) return true
  if (situation?.crystalReady && bot.health <= (config.pvp?.totemVsCrystalHealth || 16)) return true
  if (target?.type === 'player' && distance <= 3.4 && gear.weaponType === 'axe' && bot.health <= (config.pvp?.totemVsAxeHealth || 10)) return true
  if (target?.type === 'player' && distance <= 4.4 && gear.weaponType === 'mace' && bot.health <= (config.pvp?.totemVsMaceHealth || 13)) return true
  if (target?.type === 'player' && isMaceDiveDanger(target, gear, distance, verticalGap, config) && bot.health <= (config.pvp?.maceDangerHealth || 17)) return true
  if (nearbyCrystalThreat(bot, config) && bot.health <= (config.pvp?.totemVsCrystalHealth || 16)) return true
  if (recentlyDamaged && bot.health <= (config.pvp?.totemRecentDamageHealth || 12)) return true
  if (!hasShield(bot) && bot.health <= 12) return true
  return false
}

function shouldFavorTotemForCrystalKit (bot, target, distance, config = {}) {
  if (config.pvp?.crystalKitTotemOffhand === false) return false
  if (config.pvp?.crystalsEnabled === false) return false
  if (target?.type !== 'player') return false
  if (!hasCrystalLoadout(bot)) return false
  if (distance > (config.pvp?.crystalKitTotemRange || 7.5)) return false
  if (config.pvp?.totemInsuranceMode === true && !nearbyCrystalThreat(bot, config)) {
    return (bot.health || 20) <= (config.pvp?.totemInsuranceHealth || 13.5)
  }
  return (bot.health || 20) <= (config.pvp?.crystalKitTotemHealth || 18)
}

function shouldStartFightWithTotem (bot, target, config = {}) {
  if (config.pvp?.totemInsuranceMode === true) return false
  if (config.pvp?.crystalKitTotemOffhand === false) return false
  if (config.pvp?.crystalsEnabled === false) return false
  if (target?.type !== 'player') return false
  return hasTotem(bot) && hasCrystalLoadout(bot)
}

async function equipBestTotem (bot) {
  const current = offhandItem(bot)
  if (current?.name === 'totem_of_undying') return current
  const totem = bot.inventory.items().find(item => item.name === 'totem_of_undying')
  if (!totem) return null
  const offhandSlot = bot.getEquipmentDestSlot('off-hand')
  const equipped = bot.inventory.slots[offhandSlot]
  if (equipped?.name !== 'totem_of_undying') await bot.equip(totem, 'off-hand')
  return totem
}

function targetLikelyShielding (target) {
  return readTargetGear(target).shield
}

function dangerousCombatFooting (bot) {
  if (!bot?.entity) return false
  const pos = bot.entity.position.floored()
  if (dangerousBlockNear(bot, pos)) return true
  const feet = bot.blockAt(pos)
  if (feet && (feet.name.includes('lava') || feet.name.includes('water'))) return true
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  if (!floor) return true
  const name = floor.name || ''
  return name === 'air' || name === 'cave_air' || name === 'void_air' || name.includes('lava') || name.includes('water')
}

function hasBowLoadout (bot) {
  return bot.inventory.items().some(item => item.name === 'bow' && durabilityOk(item)) && hasArrow(bot)
}

function hasArrow (bot) {
  return bot.inventory.items().some(item => ARROWS.includes(item.name))
}

function hasTotem (bot) {
  return offhandItem(bot)?.name === 'totem_of_undying' || bot.inventory.items().some(item => item.name === 'totem_of_undying')
}

function hasEquippedTotem (bot) {
  return offhandItem(bot)?.name === 'totem_of_undying'
}

function hasShield (bot) {
  const current = offhandItem(bot)
  return (current?.name === 'shield' && durabilityOk(current)) || bot.inventory.items().some(item => item.name === 'shield' && durabilityOk(item))
}

function hasAxe (bot) {
  return bot.inventory.items().some(item => item.name.endsWith('_axe') && durabilityOk(item)) ||
    Boolean(bot.heldItem?.name?.endsWith('_axe') && durabilityOk(bot.heldItem))
}

function offhandItem (bot) {
  return equippedItem(bot, 'off-hand')
}

function equippedItem (bot, slot) {
  try {
    return bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null
  } catch {
    return null
  }
}

function findInventoryItem (bot, predicate) {
  return bot.inventory.items().find(predicate) || null
}

function findBuildUpBlock (bot) {
  return bot.inventory.items().find(item => BUILD_UP_BLOCKS.includes(item.name))
}

function horizontalDirection (from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) > Math.abs(dz)) return { x: Math.sign(dx || 1), z: 0 }
  return { x: 0, z: Math.sign(dz || 1) }
}

function horizontalDistance (a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

function asVec3 (pos) {
  if (pos instanceof Vec3) return pos.clone()
  return new Vec3(pos.x, pos.y || 0, pos.z)
}

function isPassable (block) {
  return !block || ['air', 'cave_air', 'void_air'].includes(block.name) || block.boundingBox === 'empty'
}

function isSolidFloor (block) {
  if (!block || isPassable(block)) return false
  const name = block.name || ''
  return !name.includes('water') && !name.includes('lava') && block.boundingBox !== 'empty'
}

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function randomInt (min, max) {
  const lo = Math.ceil(Math.min(min, max))
  const hi = Math.floor(Math.max(min, max))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function readTargetGear (target) {
  if (!target || target.type !== 'player') {
    return { weapon: null, weaponType: null, shield: false, totem: false, crystalReady: false, visibleItems: [] }
  }
  const equipment = Object.values(target.equipment || {}).filter(Boolean)
  const candidates = [
    target.heldItem,
    ...equipment
  ].filter(Boolean)
  const weapon = candidates.find(item => item?.name && isWeaponCandidate(item.name)) || null
  const visibleItems = candidates.map(item => item?.name).filter(Boolean)
  return {
    weapon,
    weaponType: weapon ? weaponType(weapon.name) : null,
    shield: visibleItems.includes('shield'),
    totem: visibleItems.includes('totem_of_undying'),
    crystalReady: visibleItems.includes('end_crystal') || visibleItems.includes('obsidian'),
    visibleItems
  }
}

function comparePvpGear (bot, target) {
  const botScore = botPvpGearScore(bot)
  const targetScore = targetPvpGearScore(target)
  return {
    bot: botScore,
    target: targetScore,
    gap: Math.max(0, targetScore - botScore)
  }
}

function botPvpGearScore (bot) {
  const armor = ['head', 'torso', 'legs', 'feet']
    .map(slot => equippedItem(bot, slot))
    .filter(Boolean)
    .reduce((sum, item) => sum + armorItemScore(item), 0)
  const weapon = bot.heldItem && isWeaponCandidate(bot.heldItem.name)
    ? weaponScore(bot.heldItem)
    : weaponScore(bestInventoryWeapon(bot) || { name: 'wooden_sword' })
  const shield = hasShield(bot) ? 55 : 0
  const totem = hasTotem(bot) ? 45 : 0
  return armor + weapon * 0.55 + shield + totem
}

function targetPvpGearScore (target) {
  if (!target || target.type !== 'player') return 0
  const gear = readTargetGear(target)
  const equipment = Object.values(target.equipment || {}).filter(Boolean)
  const armor = equipment
    .filter(item => isArmorName(item?.name))
    .reduce((sum, item) => sum + armorItemScore(item), 0)
  const weapon = gear.weapon ? weaponScore(gear.weapon) * 0.55 : 0
  const shield = gear.shield ? 55 : 0
  const crystal = gear.crystalReady ? 80 : 0
  return armor + weapon + shield + crystal
}

function armorItemScore (item) {
  if (!item?.name || !isArmorName(item.name)) return 0
  const typeScore = item.name.endsWith('_helmet') ? 42
    : item.name.endsWith('_chestplate') ? 72
      : item.name.endsWith('_leggings') ? 62
        : item.name.endsWith('_boots') ? 38
          : 0
  const materialScore = {
    leather: 1,
    chainmail: 2,
    golden: 2.3,
    gold: 2.3,
    iron: 3,
    diamond: 4.4,
    netherite: 5
  }[weaponMaterial(item.name)] || 1
  return typeScore * materialScore + durabilityRatio(item) * 8
}

function isArmorName (name = '') {
  return /_(helmet|chestplate|leggings|boots)$/.test(name)
}

function bestInventoryWeapon (bot) {
  return bot.inventory.items()
    .filter(item => isWeaponCandidate(item.name) && durabilityOk(item))
    .sort((a, b) => weaponScore(b) - weaponScore(a))[0] || null
}

function shouldBuildUpToTarget (bot, target, verticalGap, distance, config, arenaCenter = null, arenaRadius = 18) {
  if (!bot.entity?.onGround) return false
  if (verticalGap < (config.pvp?.buildUpVerticalGap || 3.1)) return false
  if (distance > (config.pvp?.buildUpRange || 8.5)) return false
  if (!findBuildUpBlock(bot)) return false
  if (dangerousCombatFooting(bot)) return false
  if (arenaCenter && config.pvp?.arenaAllowBuildUp !== true) {
    if (config.pvp?.arenaAllowSafeBuildUp === false) return false
    const buffer = config.pvp?.buildUpArenaEdgeBuffer ?? 2
    const safeRadius = Math.max(3, arenaRadius - buffer)
    if (horizontalDistance(bot.entity.position, arenaCenter) > safeRadius) return false
    if (horizontalDistance(target.position, arenaCenter) > safeRadius + 1) return false
  }
  return true
}

async function buildUpTowardTarget (bot, target, signal, arenaCenter = null, arenaRadius = 18, config = {}) {
  const blockItem = findBuildUpBlock(bot)
  if (!blockItem) return false
  const base = bot.entity.position.floored()
  const dir = horizontalDirection(bot.entity.position, target.position)
  const front = base.offset(dir.x, 0, dir.z)
  const placedStep = await placeCombatBlock(bot, blockItem, front, signal, arenaCenter, arenaRadius, config).catch(() => false)
  if (placedStep) {
    await bot.look(Math.atan2(-dir.x, -dir.z), 0, true).catch(() => {})
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    await sleep(450)
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
    return true
  }
  return towerUpOne(bot, blockItem, signal, arenaCenter, arenaRadius, config).catch(() => false)
}

async function placeCombatBlock (bot, item, pos, signal, arenaCenter = null, arenaRadius = 18, config = {}) {
  if (signal?.cancelled) return false
  if (!positionInsideBuildArena(pos, arenaCenter, arenaRadius, config)) return false
  const at = bot.blockAt(pos)
  const head = bot.blockAt(pos.offset(0, 1, 0))
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  if (!isPassable(at) || !isPassable(head) || !isSolidFloor(floor)) return false
  await bot.equip(item, 'hand')
  await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true).catch(() => {})
  await bot.placeBlock(floor, new Vec3(0, 1, 0))
  return true
}

async function towerUpOne (bot, item, signal, arenaCenter = null, arenaRadius = 18, config = {}) {
  if (signal?.cancelled || !bot.entity?.onGround) return false
  if (!positionInsideBuildArena(bot.entity.position, arenaCenter, arenaRadius, config)) return false
  const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!isSolidFloor(floor)) return false
  await bot.equip(item, 'hand')
  bot.setControlState('jump', true)
  await sleep(220)
  await bot.placeBlock(floor, new Vec3(0, 1, 0)).catch(() => {})
  await sleep(220)
  bot.setControlState('jump', false)
  return true
}

function positionInsideBuildArena (pos, arenaCenter = null, arenaRadius = 18, config = {}) {
  if (!arenaCenter || config.pvp?.arenaAllowBuildUp === true) return true
  const buffer = config.pvp?.buildUpArenaEdgeBuffer ?? 2
  return horizontalDistance(pos, arenaCenter) <= Math.max(3, arenaRadius - buffer)
}

function durabilityOk (item) {
  return durabilityRatio(item) > 0.05
}

function durabilityRatio (item) {
  if (!item?.maxDurability) return 1
  const used = item.nbt?.value?.Damage?.value || 0
  return Math.max(0, (item.maxDurability - used) / item.maxDurability)
}

function isWeaponCandidate (name) {
  return Boolean(weaponType(name))
}

function hasStoneOrBetterWeapon (bot) {
  return bot.inventory.items().some(item => /^(stone|iron|diamond|netherite)_(sword|axe)$/.test(item.name))
}

function weaponType (name) {
  if (name === 'mace') return 'mace'
  if (name === 'trident') return 'trident'
  if (name === 'bow') return 'bow'
  if (name === 'crossbow') return 'crossbow'
  return WEAPON_TYPES.find(type => name.endsWith(`_${type}`)) || null
}

function weaponMaterial (name) {
  if (name === 'mace' || name === 'trident') return 'special'
  return name.split('_')[0]
}

module.exports = {
  HOSTILE_PRIORITY,
  fightEntitySmart,
  findBestHostileThreat,
  eatIfSafe,
  equipBestWeapon,
  equipBestShield,
  equipBestTotem,
  recoverDangerousFall,
  createFallRecoveryState,
  weaponScore
}

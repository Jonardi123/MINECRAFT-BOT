const fs = require('fs')
const path = require('path')

const VERSION = 1
const DEFAULT_DIR = 'training-logs'
const SUMMARY_WINDOW = 5

const TUNABLES = {
  bowLeadScale: { min: 0.85, max: 1.3, precision: 2 },
  bowAimIterations: { min: 3, max: 6, precision: 0 },
  bowChargeMs: { min: 900, max: 1200, precision: 0 },
  crystalMaxRange: { min: 5.2, max: 6.6, precision: 1 },
  crystalCooldownMs: { min: 180, max: 420, precision: 0 },
  shieldMaxHoldMs: { min: 250, max: 350, precision: 0 },
  sweetSpacing: { min: 2.65, max: 3.3, precision: 2 },
  maxSpacing: { min: 3.25, max: 4.0, precision: 2 },
  elytraMaceCooldownMs: { min: 5000, max: 11000, precision: 0 },
  movePressWeight: { min: 2.4, max: 6.2, precision: 1 },
  meleeLeadTicks: { min: 1.2, max: 4.2, precision: 1 },
  meleeComboLeadTicks: { min: 2.0, max: 5.0, precision: 1 },
  comboMomentumMs: { min: 650, max: 1400, precision: 0 },
  antiBaitFreshSwingMs: { min: 120, max: 280, precision: 0 },
  crystalSelfDamagePenalty: { min: 0.65, max: 1.35, precision: 2 }
}

function createPvpTraining (bot, config = {}, speaker = null) {
  const dir = path.resolve(process.cwd(), config.pvp?.trainingDir || DEFAULT_DIR)
  const aggregatePath = path.join(dir, 'pvp-training.json')
  const roundsPath = path.join(dir, 'pvp-rounds.jsonl')
  const data = loadTrainingData(aggregatePath)
  let session = null

  applyTuning(config, data.tuning)

  function startFight (targetName, metadata = {}) {
    if (config.pvp?.trainingEnabled === false) return null
    if (session) endFight({ reason: 'restarted' })

    session = {
      id: `pvp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      targetName: targetName || 'player',
      startedAt: Date.now(),
      endedAt: null,
      reason: null,
      metadata: safeDetails(metadata),
      metrics: emptyMetrics(),
      events: [],
      actions: [],
      adjustments: []
    }
    recordEvent('fight_start', { target: session.targetName })
    return session.id
  }

  function endFight ({ reason = 'stopped' } = {}) {
    if (!session) return null
    session.endedAt = Date.now()
    session.reason = reason || 'stopped'
    session.durationMs = session.endedAt - session.startedAt
    recordEvent('fight_end', { reason: session.reason, durationMs: session.durationMs })

    const summary = summarizeSession(session)
    const adjustments = tuneFromRecent(summary)
    summary.adjustments = adjustments
    session.adjustments = adjustments

    rollup(summary)
    appendRound(session)
    saveTrainingData(aggregatePath, data)

    const chat = summaryChat(summary)
    const finished = session
    session = null
    return { session: finished, summary, chat }
  }

  function recordEvent (type, details = {}) {
    if (config.pvp?.trainingEnabled === false || !session) return
    const event = {
      at: Date.now(),
      t: Date.now() - session.startedAt,
      type,
      details: safeDetails(details)
    }
    session.events.push(event)
    const maxEvents = config.pvp?.trainingMaxEvents || 140
    while (session.events.length > maxEvents) session.events.shift()
    updateMetrics(session, event)
  }

  function recordDamageTaken (amount, details = {}) {
    recordEvent('damage_taken', { amount: round(amount, 2), health: bot.health, ...details })
  }

  function recordTargetHurt (target, details = {}) {
    recordEvent('target_hurt', {
      target: entityName(target),
      distance: target?.position && bot.entity ? round(target.position.distanceTo(bot.entity.position), 2) : null,
      ...details
    })
  }

  function recordTargetSwitch (fromTarget, toTarget, details = {}) {
    const from = entityName(fromTarget)
    const to = entityName(toTarget)
    if (from && to && from === to) return
    recordEvent('target_switch', { from, to, ...details })
  }

  function status () {
    return {
      enabled: config.pvp?.trainingEnabled !== false,
      active: Boolean(session),
      current: session ? {
        id: session.id,
        target: session.targetName,
        durationMs: Date.now() - session.startedAt,
        metrics: session.metrics,
        style: buildStyleModel(session.metrics, Date.now() - session.startedAt)
      } : null,
      totals: data.totals,
      tuning: data.tuning,
      last: data.recent[data.recent.length - 1] || null,
      opponents: data.opponents,
      logFile: roundsPath
    }
  }

  function opponentModel (targetName) {
    const key = opponentKey(targetName)
    const stored = key ? data.opponents[key] : null
    const current = session && opponentKey(session.targetName) === key
      ? buildStyleModel(session.metrics, Date.now() - session.startedAt)
      : null
    return mergeOpponentModel(stored, current)
  }

  return {
    startFight,
    endFight,
    recordEvent,
    recordDamageTaken,
    recordTargetHurt,
    recordTargetSwitch,
    opponentModel,
    status
  }

  function tuneFromRecent (summary) {
    if (config.pvp?.trainingAutoTune === false) return []
    const windowSize = config.pvp?.trainingWindow || SUMMARY_WINDOW
    const sample = combineSummaries([...data.recent.slice(-(windowSize - 1)), summary])
    const adjustments = []

    if (sample.bowShots >= 5) {
      const bowRate = safeRate(sample.bowHits, sample.bowShots)
      if (bowRate < 0.35) {
        adjust('bowLeadScale', 0.04, 'bow hit rate low', adjustments)
        adjust('bowAimIterations', 1, 'more bow aim correction', adjustments)
        adjust('bowChargeMs', 50, 'stronger bow charge', adjustments)
      } else if (bowRate > 0.58) {
        adjust('bowChargeMs', -25, 'bow shots landing reliably', adjustments)
      }
    }

    if (sample.crystalAttempts >= 4) {
      const crystalUseRate = safeRate(sample.crystalSuccesses, sample.crystalAttempts)
      const crystalHitRate = safeRate(sample.crystalHits, Math.max(1, sample.crystalSuccesses))
      if (crystalUseRate < 0.4) {
        adjust('crystalMaxRange', -0.2, 'crystal attempts too far away', adjustments)
      } else if (crystalHitRate > 0.45) {
        adjust('crystalCooldownMs', -20, 'crystals are connecting', adjustments)
      }
    }

    if (sample.opponentSwings >= 4 && sample.damageTaken >= 8) {
      const shieldUse = safeRate(sample.shieldRaises, sample.opponentSwings)
      if (shieldUse < 0.35) {
        adjust('shieldMaxHoldMs', 75, 'more shield coverage under pressure', adjustments)
      } else if (sample.meleeAttacks < sample.shieldRaises * 0.45) {
        adjust('shieldMaxHoldMs', -50, 'shield holding is blocking offense', adjustments)
      }
    }

    if (sample.meleeAttacks >= 5) {
      const meleeRate = safeRate(sample.meleeHits, sample.meleeAttacks)
      if (meleeRate < 0.28 && sample.damageTaken >= 6) {
        adjust('sweetSpacing', 0.08, 'melee spacing losing trades', adjustments)
        adjust('maxSpacing', 0.1, 'more room for sprint resets', adjustments)
      }
    }

    if (sample.elytraMaceAttempts >= 2 && sample.elytraMaceHits === 0) {
      adjust('elytraMaceCooldownMs', 1000, 'elytra mace attempts not landing', adjustments)
    }

    if (sample.meleeAttacks >= 8) {
      const missRate = safeRate(sample.meleeMisses, sample.meleeAttacks)
      const comboRate = safeRate(sample.comboChains, Math.max(1, sample.meleeHits))
      if (missRate > 0.45) {
        adjust('meleeLeadTicks', -0.2, 'melee whiffs high', adjustments)
        adjust('movePressWeight', -0.2, 'overpressing into misses', adjustments)
      } else if (comboRate > 0.65 && missRate < 0.25) {
        adjust('comboMomentumMs', 50, 'combo pressure is working', adjustments)
        adjust('movePressWeight', 0.2, 'successful combo pressure', adjustments)
      }
    }

    if (sample.comboTradeLosses >= 3) {
      adjust('antiBaitFreshSwingMs', 20, 'lost trades after fresh swings', adjustments)
    }

    if (sample.crystalRiskSkips >= 3 && sample.crystalAttempts >= 3) {
      adjust('crystalSelfDamagePenalty', 0.05, 'crystals often too risky', adjustments)
    }

    return adjustments
  }

  function adjust (key, delta, reason, adjustments) {
    const spec = TUNABLES[key]
    if (!spec) return
    const current = Number(config.pvp?.[key])
    if (!Number.isFinite(current)) return
    const next = round(clamp(current + delta, spec.min, spec.max), spec.precision)
    if (next === current) return
    config.pvp[key] = next
    data.tuning[key] = next
    adjustments.push({ key, from: current, to: next, reason })
  }

  function appendRound (roundData) {
    ensureDir(dir)
    const safeRound = {
      ...roundData,
      actions: undefined
    }
    fs.appendFileSync(roundsPath, `${JSON.stringify(safeRound)}\n`)
  }

  function rollup (summary) {
    data.totals.sessions += 1
    data.totals.durationMs += summary.durationMs
    for (const [key, value] of Object.entries(summary.metrics)) {
      if (typeof value !== 'number') continue
      if (key === 'maxComboChain') {
        data.totals[key] = Math.max(data.totals[key] || 0, value)
        continue
      }
      data.totals[key] = (data.totals[key] || 0) + value
    }
    data.recent.push(summary)
    while (data.recent.length > 16) data.recent.shift()
    updateOpponentMemory(data, summary)
    data.updatedAt = Date.now()
  }
}

function updateMetrics (session, event) {
  const metrics = session.metrics
  const details = event.details || {}
  switch (event.type) {
    case 'damage_taken':
      metrics.damageTaken += Number(details.amount || 0)
      metrics.damageEvents += 1
      break
    case 'target_hurt':
      metrics.targetHurtEvents += 1
      attributeHit(session, event)
      break
    case 'tactic_shift':
      if (details.to === 'chase') metrics.runnerTactics += 1
      if (details.to === 'shield_break') metrics.opponentShielding += 1
      if (details.to === 'anti_crystal') metrics.antiCrystalTactics += 1
      break
    case 'opponent_swing':
      metrics.opponentSwings += 1
      break
    case 'target_switch':
      metrics.targetSwitches += 1
      break
    case 'melee_attack':
      metrics.meleeAttacks += 1
      if (details.tactic === 'counter') metrics.counterAttacks += 1
      if (details.tactic === 'outgeared_duel') metrics.outgearedAttacks += 1
      if (details.axePressure) metrics.axePressureAttacks += 1
      if (details.tempoAttack) metrics.tempoMeleeAttacks += 1
      if (details.comboCounter) metrics.comboCounterAttacks += 1
      if (details.targetShielding) metrics.opponentShielding += 1
      if (details.hitConfirm) metrics.hitConfirmPressures += 1
      if (details.comboMomentum) metrics.comboPressureAttacks += 1
      rememberAction(session, 'melee', event)
      break
    case 'bow_shot':
      metrics.bowShots += 1
      rememberAction(session, 'bow', event)
      break
    case 'crystal_attempt':
      metrics.crystalAttempts += 1
      break
    case 'crystal_success':
      metrics.crystalSuccesses += 1
      rememberAction(session, 'crystal', event)
      break
    case 'shield_raise':
      metrics.shieldRaises += 1
      break
    case 'shield_lower':
      metrics.shieldLowers += 1
      break
    case 'totem_equip':
      metrics.totems += 1
      break
    case 'totem_missing':
      metrics.totemMissing += 1
      break
    case 'bot_totem_pop':
      metrics.botTotemPops += 1
      break
    case 'target_totem_pop':
      metrics.targetTotemPops += 1
      break
    case 'tempo_attack':
      metrics.tempoAttacks += 1
      if (details.reason === 'pressure_timer') metrics.tempoPressureAttacks += 1
      if (details.reason === 'target_totem_pop_execute') metrics.tempoExecuteAttacks += 1
      if (details.reason === 'punish_enemy_recovery') metrics.tempoPunishAttacks += 1
      if (details.goodEnough) metrics.goodEnoughAttacks += 1
      break
    case 'elytra_mace_attempt':
      metrics.elytraMaceAttempts += 1
      rememberAction(session, 'elytra_mace', event)
      break
    case 'elytra_mace_hit':
      metrics.elytraMaceHits += 1
      markLatestActionHit(session, 'elytra_mace')
      break
    case 'build_up':
      metrics.buildUps += 1
      break
    case 'stuck_recovery':
      metrics.stuckRecoveries += 1
      break
    case 'anti_combo_reset':
      metrics.antiComboResets += 1
      break
    case 'projectile_dodge':
      metrics.projectileDodges += 1
      metrics.opponentRangedThreats += 1
      break
    case 'projectile_pre_dodge':
      metrics.projectilePreDodges += 1
      metrics.opponentRangedThreats += 1
      break
    case 'movement_mode':
      metrics.movementModeChanges += 1
      if (details.mode === 'orbit') metrics.orbitMoves += 1
      if (details.mode === 'press') metrics.pressMoves += 1
      if (details.mode === 'diagonal_press') metrics.diagonalPressMoves += 1
      if (details.mode === 'micro_back') metrics.microBackMoves += 1
      if (details.mode === 'angle_change') metrics.angleChangeMoves += 1
      if (details.mode === 'pause') metrics.pauseMoves += 1
      break
    case 'eat':
      metrics.eats += 1
      break
    case 'golden_apple':
      metrics.goldenApples += 1
      break
    case 'hit_confirm_pressure':
      metrics.hitConfirmPressures += 1
      break
    case 'combo_chain':
      metrics.comboChains += 1
      metrics.maxComboChain = Math.max(metrics.maxComboChain || 0, Number(details.chain || 0))
      break
    case 'combo_break':
      metrics.comboBreaks += 1
      break
    case 'combat_decision':
      metrics.combatDecisions += 1
      incrementDecisionMetric(metrics, details.action)
      if (details.spacing === 'too_close') metrics.spacingTooCloseDecisions += 1
      break
    case 'raw_movement_correction':
      metrics.rawMovementCorrections += 1
      if (details.reason === 'strafe_cancel') metrics.strafeCancels += 1
      if (details.reason === 'collision_unstick') metrics.collisionCorrections += 1
      break
    case 'combat_parkour':
      metrics.combatParkourMoves += 1
      if (details.kind === 'side_hop' || details.kind === 'drop_side_hop') metrics.parkourSideHops += 1
      if (details.kind === 'block_vault') metrics.parkourVaults += 1
      if (details.kind === 'cover_juke') metrics.parkourCoverJukes += 1
      if (details.risk) metrics.parkourRiskyMoves += 1
      break
    case 'combo_trade_lost':
      metrics.comboTradeLosses += 1
      break
    case 'melee_miss':
      metrics.meleeMisses += 1
      break
    case 'knockback_read':
      metrics.knockbackReads += 1
      break
    case 'predictive_aim':
      metrics.predictiveAims += 1
      break
    case 'anti_bait_hold':
      metrics.antiBaitHolds += 1
      break
    case 'shield_bait':
      metrics.shieldBaits += 1
      metrics.opponentShielding += 1
      break
    case 'arena_cutoff':
      metrics.arenaCutoffs += 1
      break
    case 'crystal_risk_skip':
      metrics.crystalRiskSkips += 1
      metrics.crystalUnsafeSkips += 1
      break
    case 'crystal_exposure_check':
      metrics.crystalExposureChecks += 1
      break
    case 'arena_return':
      metrics.arenaReturns += 1
      break
    case 'combat_pearl':
      metrics.combatPearls += 1
      break
    case 'fall_recovery':
      metrics.fallRecoveries += 1
      break
    case 'fall_totem':
      metrics.fallTotems += 1
      break
    case 'fall_boot_swap':
      metrics.fallBootSwaps += 1
      break
    case 'fall_elytra_recovery':
      metrics.fallElytraRecoveries += 1
      break
    case 'fall_ender_pearl':
      metrics.fallPearls += 1
      break
    case 'fall_accept_fate':
      metrics.fallFateAccepts += 1
      break
    case 'water_clutch':
      metrics.waterClutches += 1
      break
  }
}

function incrementDecisionMetric (metrics, action) {
  const key = {
    attack: 'decisionAttack',
    chase: 'decisionChase',
    strafe: 'decisionStrafe',
    back_up: 'decisionBackUp',
    disengage: 'decisionDisengage',
    heal_eat: 'decisionHealEat',
    shield_block: 'decisionShieldBlock',
    reposition: 'decisionReposition',
    use_terrain: 'decisionUseTerrain',
    switch_weapon: 'decisionSwitchWeapon'
  }[action]
  if (key) metrics[key] += 1
}

function rememberAction (session, kind, event) {
  session.actions.push({ kind, at: event.at, hit: false })
  while (session.actions.length > 40) session.actions.shift()
}

function attributeHit (session, event) {
  const windowMs = 1700
  const action = session.actions
    .slice()
    .reverse()
    .find(action => !action.hit && event.at - action.at >= 0 && event.at - action.at <= windowMs)
  if (!action) return
  action.hit = true
  if (action.kind === 'melee') session.metrics.meleeHits += 1
  else if (action.kind === 'bow') session.metrics.bowHits += 1
  else if (action.kind === 'crystal') session.metrics.crystalHits += 1
}

function markLatestActionHit (session, kind) {
  const action = session.actions
    .slice()
    .reverse()
    .find(action => action.kind === kind && !action.hit)
  if (action) action.hit = true
}

function summarizeSession (session) {
  const summary = {
    id: session.id,
    targetName: session.targetName,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    reason: session.reason,
    metrics: { ...session.metrics }
  }
  summary.style = buildStyleModel(summary.metrics, summary.durationMs)
  summary.coach = coachSummary(summary)
  return summary
}

function combineSummaries (summaries) {
  const total = emptyMetrics()
  total.sessions = summaries.length
  for (const summary of summaries) {
    const metrics = summary.metrics || {}
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value !== 'number') continue
      if (key === 'maxComboChain') total[key] = Math.max(total[key] || 0, value)
      else total[key] = (total[key] || 0) + value
    }
  }
  return total
}

function emptyMetrics () {
  return {
    damageTaken: 0,
    damageEvents: 0,
    targetHurtEvents: 0,
    opponentSwings: 0,
    targetSwitches: 0,
    meleeAttacks: 0,
    meleeHits: 0,
    meleeMisses: 0,
    counterAttacks: 0,
    comboCounterAttacks: 0,
    outgearedAttacks: 0,
    axePressureAttacks: 0,
    tempoAttacks: 0,
    tempoMeleeAttacks: 0,
    tempoPressureAttacks: 0,
    tempoExecuteAttacks: 0,
    tempoPunishAttacks: 0,
    goodEnoughAttacks: 0,
    comboPressureAttacks: 0,
    comboChains: 0,
    maxComboChain: 0,
    comboTradeLosses: 0,
    knockbackReads: 0,
    predictiveAims: 0,
    antiBaitHolds: 0,
    combatDecisions: 0,
    decisionAttack: 0,
    decisionChase: 0,
    decisionStrafe: 0,
    decisionBackUp: 0,
    decisionDisengage: 0,
    decisionHealEat: 0,
    decisionShieldBlock: 0,
    decisionReposition: 0,
    decisionUseTerrain: 0,
    decisionSwitchWeapon: 0,
    spacingTooCloseDecisions: 0,
    comboBreaks: 0,
    rawMovementCorrections: 0,
    strafeCancels: 0,
    collisionCorrections: 0,
    combatParkourMoves: 0,
    parkourSideHops: 0,
    parkourVaults: 0,
    parkourCoverJukes: 0,
    parkourRiskyMoves: 0,
    bowShots: 0,
    bowHits: 0,
    crystalAttempts: 0,
    crystalSuccesses: 0,
    crystalHits: 0,
    shieldRaises: 0,
    shieldLowers: 0,
    totems: 0,
    totemMissing: 0,
    botTotemPops: 0,
    targetTotemPops: 0,
    elytraMaceAttempts: 0,
    elytraMaceHits: 0,
    buildUps: 0,
    stuckRecoveries: 0,
    antiComboResets: 0,
    projectileDodges: 0,
    projectilePreDodges: 0,
    movementModeChanges: 0,
    orbitMoves: 0,
    pressMoves: 0,
    diagonalPressMoves: 0,
    microBackMoves: 0,
    angleChangeMoves: 0,
    pauseMoves: 0,
    opponentRangedThreats: 0,
    opponentShielding: 0,
    runnerTactics: 0,
    antiCrystalTactics: 0,
    hitConfirmPressures: 0,
    shieldBaits: 0,
    arenaCutoffs: 0,
    crystalRiskSkips: 0,
    crystalUnsafeSkips: 0,
    crystalExposureChecks: 0,
    eats: 0,
    goldenApples: 0,
    arenaReturns: 0,
    combatPearls: 0,
    fallRecoveries: 0,
    fallTotems: 0,
    fallBootSwaps: 0,
    fallElytraRecoveries: 0,
    fallPearls: 0,
    fallFateAccepts: 0,
    waterClutches: 0
  }
}

function summaryChat (summary) {
  const metrics = summary.metrics || {}
  const seconds = Math.max(1, Math.round((summary.durationMs || 0) / 1000))
  const bow = metrics.bowShots ? `bow ${metrics.bowHits}/${metrics.bowShots}` : 'bow 0'
  const crystals = metrics.crystalAttempts ? `crystals ${metrics.crystalHits}/${metrics.crystalAttempts}` : 'crystals 0'
  const melee = metrics.meleeAttacks ? `melee ${metrics.meleeHits}/${metrics.meleeAttacks}` : 'melee 0'
  const defense = [
    metrics.maxComboChain ? `combo x${metrics.maxComboChain}` : null,
    metrics.comboCounterAttacks ? `counter-hits ${metrics.comboCounterAttacks}` : null,
    metrics.meleeMisses ? `misses ${metrics.meleeMisses}` : null,
    metrics.antiComboResets ? `resets ${metrics.antiComboResets}` : null,
    metrics.comboBreaks ? `combo breaks ${metrics.comboBreaks}` : null,
    metrics.antiBaitHolds ? `anti-bait ${metrics.antiBaitHolds}` : null,
    metrics.projectileDodges ? `dodges ${metrics.projectileDodges}` : null,
    metrics.projectilePreDodges ? `pre-dodges ${metrics.projectilePreDodges}` : null,
    metrics.pressMoves ? `press ${metrics.pressMoves}` : null,
    metrics.microBackMoves ? `micro-back ${metrics.microBackMoves}` : null,
    metrics.strafeCancels ? `strafe-cancel ${metrics.strafeCancels}` : null,
    metrics.tempoAttacks ? `tempo ${metrics.tempoAttacks}` : null,
    metrics.targetTotemPops ? `target-pops ${metrics.targetTotemPops}` : null,
    metrics.botTotemPops ? `bot-pops ${metrics.botTotemPops}` : null,
    metrics.combatParkourMoves ? `parkour ${metrics.combatParkourMoves}` : null,
    metrics.combatPearls ? `pearls ${metrics.combatPearls}` : null,
    metrics.fallRecoveries ? `fall-save ${metrics.fallRecoveries}` : null,
    metrics.fallTotems ? `fall-totem ${metrics.fallTotems}` : null,
    metrics.fallBootSwaps ? `ff-boots ${metrics.fallBootSwaps}` : null,
    metrics.fallElytraRecoveries ? `fall-elytra ${metrics.fallElytraRecoveries}` : null,
    metrics.fallPearls ? `fall-pearl ${metrics.fallPearls}` : null,
    metrics.waterClutches ? `water ${metrics.waterClutches}` : null
  ].filter(Boolean)
  const defenseText = defense.length ? `, ${defense.join(', ')}` : ''
  const coach = summary.coach?.short ? ` ${summary.coach.short}` : ''
  const tuned = summary.adjustments?.length
    ? ` Tuned ${summary.adjustments.map(item => `${item.key} ${item.from}->${item.to}`).join(', ')}.`
    : ''
  return `PVP training: ${seconds}s, dmg ${round(metrics.damageTaken, 1)}, ${melee}, ${bow}, ${crystals}${defenseText}.${coach}${tuned}`
}

function applyTuning (config, tuning = {}) {
  if (!config.pvp) config.pvp = {}
  for (const [key, value] of Object.entries(tuning)) {
    if (!TUNABLES[key]) continue
    const number = Number(value)
    if (!Number.isFinite(number)) continue
    const spec = TUNABLES[key]
    config.pvp[key] = round(clamp(number, spec.min, spec.max), spec.precision)
  }
}

function loadTrainingData (filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return normalizeData(parsed)
  } catch {
    return normalizeData({})
  }
}

function saveTrainingData (filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(normalizeData(data), null, 2)}\n`)
}

function normalizeData (data) {
  return {
    version: VERSION,
    updatedAt: data.updatedAt || Date.now(),
    tuning: typeof data.tuning === 'object' && data.tuning ? data.tuning : {},
    opponents: normalizeOpponents(data.opponents),
    totals: {
      sessions: Number(data.totals?.sessions || 0),
      durationMs: Number(data.totals?.durationMs || 0),
      ...emptyMetrics(),
      ...(typeof data.totals === 'object' && data.totals ? data.totals : {})
    },
    recent: Array.isArray(data.recent) ? data.recent.slice(-16) : []
  }
}

function updateOpponentMemory (data, summary) {
  const key = opponentKey(summary.targetName)
  if (!key) return
  const previous = data.opponents[key] || {
    name: summary.targetName,
    sessions: 0,
    durationMs: 0,
    metrics: emptyMetrics(),
    labels: [],
    confidence: 0,
    updatedAt: 0
  }
  previous.name = summary.targetName || previous.name
  previous.sessions += 1
  previous.durationMs += summary.durationMs || 0
  for (const [metric, value] of Object.entries(summary.metrics || {})) {
    if (typeof value !== 'number') continue
    if (metric === 'maxComboChain') previous.metrics[metric] = Math.max(previous.metrics[metric] || 0, value)
    else previous.metrics[metric] = (previous.metrics[metric] || 0) + value
  }
  const style = buildStyleModel(previous.metrics, previous.durationMs)
  previous.labels = style.labels
  previous.confidence = style.confidence
  previous.style = style
  previous.updatedAt = Date.now()
  data.opponents[key] = previous
}

function normalizeOpponents (opponents) {
  const normalized = {}
  if (!opponents || typeof opponents !== 'object') return normalized
  for (const [key, value] of Object.entries(opponents)) {
    if (!value || typeof value !== 'object') continue
    const metrics = { ...emptyMetrics(), ...(value.metrics || {}) }
    const style = value.style || buildStyleModel(metrics, value.durationMs || 0)
    normalized[key] = {
      name: value.name || key,
      sessions: Number(value.sessions || 0),
      durationMs: Number(value.durationMs || 0),
      metrics,
      labels: Array.isArray(value.labels) ? value.labels : style.labels,
      confidence: Number(value.confidence || style.confidence || 0),
      style,
      updatedAt: Number(value.updatedAt || Date.now())
    }
  }
  return normalized
}

function opponentKey (name) {
  const key = String(name || '').trim().toLowerCase()
  return key || null
}

function mergeOpponentModel (stored, current) {
  if (!stored && !current) return buildStyleModel(emptyMetrics(), 0)
  if (!stored) return current
  if (!current) return stored.style || buildStyleModel(stored.metrics || {}, stored.durationMs || 0)
  const metrics = { ...emptyMetrics(), ...(stored.metrics || {}) }
  for (const [key, value] of Object.entries(current.metrics || {})) {
    if (typeof value === 'number') metrics[key] = (metrics[key] || 0) + value
  }
  return buildStyleModel(metrics, (stored.durationMs || 0) + (current.durationMs || 0))
}

function buildStyleModel (metrics = {}, durationMs = 0) {
  const seconds = Math.max(1, (durationMs || 0) / 1000)
  const meleeRate = metrics.opponentSwings / seconds
  const botMeleeRate = metrics.meleeAttacks / seconds
  const meleeHitRate = safeRate(metrics.meleeHits, metrics.meleeAttacks)
  const bowRate = metrics.opponentRangedThreats / seconds
  const shieldRate = safeRate(metrics.opponentShielding + metrics.shieldBaits, Math.max(1, metrics.meleeAttacks + metrics.shieldBaits))
  const crystalRate = (metrics.antiCrystalTactics + metrics.crystalAttempts + metrics.crystalSuccesses) / seconds
  const runnerRate = metrics.runnerTactics / seconds
  const pressureTaken = metrics.damageTaken / seconds
  const labels = []
  if (meleeRate >= 0.75 || pressureTaken >= 0.55) labels.push('melee_rusher')
  if (bowRate >= 0.04 || metrics.projectileDodges + metrics.projectilePreDodges >= 2) labels.push('ranged')
  if (shieldRate >= 0.3 || metrics.opponentShielding >= 3) labels.push('shield_turtle')
  if (crystalRate >= 0.08 || metrics.antiCrystalTactics >= 2) labels.push('crystal_user')
  if (runnerRate >= 0.05 || metrics.arenaCutoffs >= 2) labels.push('kiter')
  if (metrics.antiBaitHolds >= 2 || (metrics.opponentShielding >= 3 && metrics.meleeMisses >= 2)) labels.push('baiter')
  if (metrics.maxComboChain >= 3 || metrics.comboChains >= 4) labels.push('comboable')
  if (!labels.length) labels.push('balanced')
  return {
    labels,
    confidence: round(clamp((metrics.opponentSwings + metrics.damageEvents + metrics.targetHurtEvents + metrics.meleeAttacks) / 55, 0, 1), 2),
    meleeRate: round(meleeRate, 2),
    botMeleeRate: round(botMeleeRate, 2),
    meleeHitRate: round(meleeHitRate, 2),
    bowRate: round(bowRate, 2),
    shieldRate: round(shieldRate, 2),
    crystalRate: round(crystalRate, 2),
    runnerRate: round(runnerRate, 2),
    pressureTaken: round(pressureTaken, 2),
    counterPlan: counterPlanForLabels(labels, metrics),
    metrics: { ...metrics },
    durationMs
  }
}

function counterPlanForLabels (labels = [], metrics = {}) {
  const plan = {
    pressure: 'balanced',
    spacing: 'normal',
    weapon: 'best',
    notes: []
  }
  if (labels.includes('ranged') || labels.includes('kiter')) {
    plan.pressure = 'hard_chase'
    plan.spacing = 'tight'
    plan.notes.push('cut off ranged/kiting space')
  }
  if (labels.includes('shield_turtle') || labels.includes('baiter')) {
    plan.weapon = 'axe'
    plan.notes.push('bait shield, punish with axe, avoid low-value swings')
  }
  if (labels.includes('crystal_user')) {
    plan.spacing = 'anti_crystal'
    plan.notes.push('keep blast spacing and totem ready')
  }
  if (labels.includes('comboable') && safeRate(metrics.meleeMisses, Math.max(1, metrics.meleeAttacks)) < 0.35) {
    plan.pressure = 'combo_press'
    plan.notes.push('extend hit-confirm pressure')
  }
  return plan
}

function coachSummary (summary) {
  const metrics = summary.metrics || {}
  const notes = []
  const meleeRate = safeRate(metrics.meleeHits, metrics.meleeAttacks)
  const tookHeavyDamage = metrics.damageTaken >= 35
  if (metrics.meleeAttacks < 10 && (summary.durationMs || 0) > 45000) notes.push('too few melee commits')
  if (metrics.pressMoves < Math.max(3, metrics.orbitMoves * 0.35) && metrics.meleeAttacks < 18) notes.push('increase press movement')
  if (metrics.goldenApples >= 4) notes.push('apples slowed pressure')
  if (metrics.totems >= 18) notes.push('totem cycling under pressure')
  if (metrics.totemMissing > 0) notes.push('totems missing when requested')
  if (metrics.bowShots >= 5 && safeRate(metrics.bowHits, metrics.bowShots) < 0.25) notes.push('bow aim underperformed')
  if (metrics.meleeMisses >= Math.max(4, metrics.meleeAttacks * 0.35)) notes.push('melee whiffs high')
  if (metrics.maxComboChain >= 3) notes.push(`best combo x${metrics.maxComboChain}`)
  if (metrics.comboTradeLosses >= 2) notes.push('lost trades after combo contact')
  if (metrics.spacingTooCloseDecisions >= 4) notes.push('spacing got too close often')
  if (metrics.decisionBackUp >= 3) notes.push('spacing backup decisions active')
  if (metrics.strafeCancels >= 2) notes.push('strafe cancel reads active')
  if (metrics.collisionCorrections >= 2) notes.push('raw movement unstuck itself')
  if (metrics.antiBaitHolds >= 2) notes.push('anti-bait reads active')
  if (metrics.crystalExposureChecks > 0) notes.push('crystal exposure scoring active')
  if (metrics.projectilePreDodges + metrics.projectileDodges > 0) notes.push('projectile reads active')
  if (metrics.crystalRiskSkips > 0) notes.push('skipped risky crystals')
  if (metrics.arenaCutoffs > 0) notes.push('used arena cutoff pressure')
  if (metrics.meleeAttacks >= 8 && meleeRate >= 0.75 && !tookHeavyDamage) notes.push('melee trades were strong')
  const short = notes.length ? `Coach: ${notes.slice(0, 3).join('; ')}.` : 'Coach: no major weakness spotted.'
  return { short, notes }
}

function safeDetails (details) {
  const out = {}
  for (const [key, value] of Object.entries(details || {})) {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (value?.x != null && value?.y != null && value?.z != null) {
      out[key] = { x: round(value.x, 2), y: round(value.y, 2), z: round(value.z, 2) }
    } else {
      out[key] = String(value).slice(0, 80)
    }
  }
  return out
}

function entityName (entity) {
  return entity?.username || entity?.name || entity?.displayName || null
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeRate (part, total) {
  return total > 0 ? part / total : 0
}

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round (value, precision = 0) {
  const factor = 10 ** precision
  return Math.round(Number(value || 0) * factor) / factor
}

module.exports = { createPvpTraining }

const { countInventory } = require('./inventory')
const { rewardSummary } = require('./rewardSystem')
const { adaptiveThreatSummary } = require('./modThreat')

const FOOD = [
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
  'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton',
  'potato', 'rotten_flesh', 'spider_eye'
]

const WOOD = ['_log', '_stem', '_planks', 'planks']
const BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'oak_planks', 'spruce_planks', 'netherrack']

function createSelfModel (bot, memory, config, tasks, controls = {}) {
  function snapshot () {
    return buildSelfSnapshot(bot, memory, config, tasks, controls)
  }

  function line () {
    return selfLine(snapshot())
  }

  function reflection () {
    return reflectionLines(snapshot()).join(' ')
  }

  function promptContext () {
    const self = snapshot()
    return [
      'Self-model:',
      JSON.stringify({
        identity: self.identity,
        embodiment: self.embodiment,
        intention: self.intention,
        needs: self.needs,
        risks: self.risks.slice(0, 5),
        confidence: self.confidence,
        nextBestAction: self.nextBestAction,
        boundaries: self.boundaries
      })
    ].join('\n')
  }

  function rememberReflection (reason = 'periodic') {
    memory.ai = memory.ai || {}
    memory.ai.selfModel = memory.ai.selfModel || {}
    const entry = {
      at: new Date().toISOString(),
      reason,
      line: line(),
      nextBestAction: snapshot().nextBestAction
    }
    memory.ai.selfModel.reflections = memory.ai.selfModel.reflections || []
    memory.ai.selfModel.reflections.push(entry)
    memory.ai.selfModel.reflections = memory.ai.selfModel.reflections.slice(-40)
    return entry
  }

  return { snapshot, line, reflection, promptContext, rememberReflection }
}

function buildSelfSnapshot (bot, memory, config, tasks, controls = {}) {
  const counts = safeCounts(bot)
  const pos = bot.entity?.position?.floored()
  const rewards = rewardSummary(memory)
  const adaptiveThreats = adaptiveThreatSummary(bot, config, memory, config.modded?.threatScanRange || 24)
  const risks = assessRisks(bot, memory, config, counts)
  const needs = assessNeeds(bot, memory, counts)
  const task = normalizeTask(tasks?.currentTask)
  const director = memory.ai?.director || {}
  const intention = {
    task,
    goal: controls.ai?.goal || memory.ai?.currentGoal || null,
    directorStage: director.currentStage || null,
    directorStep: director.currentStep || null,
    blockedReason: director.blockedReason || null
  }

  return {
    identity: {
      name: config.bot?.username || bot.username || 'TeammateBot',
      role: 'private-server Minecraft teammate',
      truth: 'I am a Mineflayer bot with memory and tools, not a conscious person.'
    },
    embodiment: {
      health: bot.health ?? null,
      food: bot.food ?? null,
      position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      dimension: bot.game?.dimension || bot.game?.dimensionName || 'unknown',
      heldItem: bot.heldItem?.name || 'empty',
      inventoryUsed: bot.inventory ? 36 - bot.inventory.emptySlotCount() : null,
      armorPieces: armorPieces(bot)
    },
    intention,
    needs,
    risks,
    adaptiveThreats,
    confidence: confidenceFrom(risks, needs, intention),
    nextBestAction: chooseNextBestAction(risks, needs, intention),
    memorySignals: {
      notes: (memory.notes || []).slice(-3),
      recentReflections: (memory.ai?.selfModel?.reflections || []).slice(-3).map(item => item.line),
      rewardPriorities: rewards.priorities,
      repeatedFailures: rewards.repeatedFailures || []
    },
    boundaries: [
      'private/permitted servers only',
      'no xray, dupes, exploits, stealth botting, or account/proxy scaling',
      'explain uncertainty instead of pretending'
    ]
  }
}

function assessNeeds (bot, memory, counts) {
  return {
    food: sumNames(counts, FOOD),
    wood: sumIncludes(counts, WOOD),
    blocks: sumNames(counts, BLOCKS),
    hasPickaxe: hasSuffix(counts, '_pickaxe'),
    hasWeapon: hasSuffix(counts, '_sword') || hasSuffix(counts, '_axe'),
    hasShield: Boolean(counts.shield),
    hasStorage: Boolean(memory.chests?.botStorage || memory.chests?.storage),
    rememberedHome: Boolean(memory.home || memory.botBase)
  }
}

function assessRisks (bot, memory, config, counts) {
  const risks = []
  const food = bot.food ?? 20
  const health = bot.health ?? 20
  const tracker = memory.ai?.progressTracker || {}
  const rewardMovement = memory.ai?.rewards?.movement || {}
  const failures = memory.ai?.rewards?.failurePatterns || {}
  const adaptiveThreats = adaptiveThreatSummary(bot, config, memory, config.modded?.threatScanRange || 24)

  if (health <= (config.behavior?.criticalHealth ?? 6)) risks.push({ level: 'critical', name: 'low_health', detail: `HP ${health}` })
  else if (health <= (config.behavior?.lowHealth ?? 10)) risks.push({ level: 'watch', name: 'hurt', detail: `HP ${health}` })

  if (food <= (config.rewardSystem?.criticalFoodLevel ?? 6)) risks.push({ level: 'critical', name: 'starvation', detail: `food ${food}` })
  else if (food <= (config.rewardSystem?.safeFoodLevel ?? 10)) risks.push({ level: 'watch', name: 'hungry', detail: `food ${food}` })

  if (!hasSuffix(counts, '_pickaxe')) risks.push({ level: 'watch', name: 'no_pickaxe', detail: 'mining blocked' })
  if (!hasSuffix(counts, '_sword') && !hasSuffix(counts, '_axe')) risks.push({ level: 'watch', name: 'weak_weapon', detail: 'combat unsafe' })
  if (bot.inventory && bot.inventory.emptySlotCount() <= 2) risks.push({ level: 'watch', name: 'inventory_full', detail: `${bot.inventory.emptySlotCount()} slots free` })
  if ((rewardMovement.stuckEvents || 0) >= 10) risks.push({ level: 'watch', name: 'stuck_pattern', detail: `${rewardMovement.stuckEvents} stuck events` })
  if ((tracker.pathTimeouts || []).length >= 3) risks.push({ level: 'watch', name: 'path_timeout_pattern', detail: `${tracker.pathTimeouts.length} recent timeouts` })

  const repeated = Object.entries(failures).sort((a, b) => b[1] - a[1])[0]
  if (repeated && repeated[1] >= 5) risks.push({ level: 'watch', name: 'repeated_failure', detail: `${repeated[0]} x${repeated[1]}` })
  if (memory.ai?.director?.blockedReason) risks.push({ level: 'watch', name: 'blocked_director', detail: memory.ai.director.blockedReason })
  for (const threat of adaptiveThreats.slice(0, 3)) {
    if (threat.level === 'critical' || threat.level === 'high') {
      risks.push({ level: threat.level === 'critical' ? 'critical' : 'watch', name: 'modded_threat', detail: `${threat.name} ${threat.score}/${threat.recommendation}` })
    }
  }
  return risks
}

function chooseNextBestAction (risks, needs, intention) {
  if (risks.some(risk => risk.name === 'starvation')) return 'eat or gather food before anything else'
  if (risks.some(risk => risk.name === 'low_health')) return 'retreat, eat, and avoid combat'
  if (risks.some(risk => risk.name === 'modded_threat')) return 'create distance or take cover before mining or fighting'
  if (!needs.hasPickaxe) return 'craft or gather supplies for a pickaxe'
  if (!needs.hasStorage && needs.blocks + needs.wood > 20) return 'make or find storage'
  if (risks.some(risk => risk.name === 'stuck_pattern' || risk.name === 'path_timeout_pattern')) return 'recover from stuck movement and choose shorter paths'
  if (intention.blockedReason) return `clear blocked director state: ${intention.blockedReason}`
  if (intention.goal) return `work toward goal: ${String(intention.goal).slice(0, 60)}`
  return 'improve survival baseline: food, tools, storage, safe mining'
}

function confidenceFrom (risks, needs, intention) {
  let score = 80
  score -= risks.filter(risk => risk.level === 'critical').length * 30
  score -= risks.filter(risk => risk.level === 'watch').length * 10
  if (!needs.rememberedHome) score -= 8
  if (!needs.hasStorage) score -= 6
  if (intention.blockedReason) score -= 15
  return Math.max(5, Math.min(95, score))
}

function selfLine (self) {
  const pos = self.embodiment.position
  const where = pos ? `${pos.x} ${pos.y} ${pos.z}` : 'unknown coords'
  const risk = self.risks[0] ? `${self.risks[0].name} (${self.risks[0].detail})` : 'stable'
  return `I know I am ${self.identity.name}, a Minecraft bot in ${self.embodiment.dimension} at ${where}. HP ${self.embodiment.health}, food ${self.embodiment.food}. Task ${self.intention.task}. Risk ${risk}. Next: ${self.nextBestAction}.`
}

function reflectionLines (self) {
  const lines = [
    selfLine(self),
    `Confidence ${self.confidence}/100.`
  ]
  if (self.intention.goal) lines.push(`Goal: ${String(self.intention.goal).slice(0, 80)}.`)
  if (self.risks.length) lines.push(`I should respect these risks: ${self.risks.slice(0, 3).map(risk => `${risk.name}:${risk.detail}`).join(', ')}.`)
  lines.push('I should not pretend to be conscious; I should report what my sensors, memory, and planner say.')
  return lines
}

function safeCounts (bot) {
  try {
    return countInventory(bot)
  } catch {
    return {}
  }
}

function armorPieces (bot) {
  if (!bot.inventory || !bot.getEquipmentDestSlot) return 0
  return ['head', 'torso', 'legs', 'feet'].filter(slot => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]).length
}

function sumNames (counts, names) {
  return names.reduce((sum, name) => sum + (counts[name] || 0), 0)
}

function sumIncludes (counts, needles) {
  return Object.entries(counts).reduce((sum, [name, value]) => {
    return needles.some(needle => name.includes(needle)) ? sum + value : sum
  }, 0)
}

function hasSuffix (counts, suffix) {
  return Object.keys(counts).some(name => name.endsWith(suffix) && counts[name] > 0)
}

function normalizeTask (task) {
  if (!task) return 'idle'
  if (typeof task === 'string') return task
  return task.name || 'busy'
}

module.exports = {
  createSelfModel,
  buildSelfSnapshot,
  selfLine,
  reflectionLines
}

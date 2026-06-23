const { saveMemory, positionToJson } = require('./memory')

const DEFAULT_PRIORITIES = {
  foodPriority: 50,
  combatPreparedness: 40,
  miningPriority: 50,
  safetyPriority: 45,
  avoidStuckBehavior: 50
}

const REWARDS = {
  eating_food: 10,
  gathering_food: 8,
  prevented_starvation: 15,
  gathering_wood: 6,
  mining: 5,
  crafting_tools: 6,
  fighting: 4,
  fleeing: -2,
  idling: -1,
  getting_stuck: -12,
  taking_damage: -6,
  dying: -50,
  completing_objectives: 20,
  protected_player: 10,
  repeated_failed_action: -10,
  idle_too_long: -8,
  failed_to_eat_while_hungry: -20
}

function ensureRewardMemory (memory) {
  memory.ai = memory.ai || {}
  memory.ai.rewards = memory.ai.rewards || {}
  const rewards = memory.ai.rewards
  rewards.scores = rewards.scores || {}
  rewards.priorities = { ...DEFAULT_PRIORITIES, ...(rewards.priorities || {}) }
  rewards.history = rewards.history || []
  rewards.lessons = rewards.lessons || []
  rewards.failurePatterns = rewards.failurePatterns || {}
  rewards.movement = rewards.movement || {
    stuckEvents: 0,
    jumpAttempts: 0,
    failedJumps: 0,
    lastPosition: null,
    lastMovedAt: null
  }
  return rewards
}

function addReward (memory, behavior, points, details = {}) {
  const rewards = ensureRewardMemory(memory)
  const key = String(behavior || 'unknown')
  const value = Number(points ?? REWARDS[key] ?? 0)
  rewards.scores[key] = (rewards.scores[key] || 0) + value
  rewards.history.push({
    at: new Date().toISOString(),
    behavior: key,
    points: value,
    details: compactDetails(details)
  })
  rewards.history = rewards.history.slice(-80)
  adjustPriorities(rewards, key, value, details)
  saveMemory(memory)
}

function rewardAction (memory, action, result = {}) {
  const name = String(action || '').toLowerCase()
  if (name === 'eat_food') return addReward(memory, 'eating_food', REWARDS.eating_food, result)
  if (name === 'gather_food') return addReward(memory, 'gathering_food', REWARDS.gathering_food, result)
  if (name === 'gather_wood') return addReward(memory, 'gathering_wood', REWARDS.gathering_wood, result)
  if (name.includes('mine') || name === 'prospect_resource') return addReward(memory, 'mining', REWARDS.mining, result)
  if (name === 'craft_item') return addReward(memory, 'crafting_tools', REWARDS.crafting_tools, result)
  if (name === 'fight' || name === 'attack_entity') return addReward(memory, 'fighting', REWARDS.fighting, result)
  if (name === 'flee') return addReward(memory, 'fleeing', REWARDS.fleeing, result)
  if (name === 'idle') return addReward(memory, 'idling', REWARDS.idling, result)
}

function recordFailureReward (memory, action, error) {
  const rewards = ensureRewardMemory(memory)
  const key = `${String(action || 'unknown').toLowerCase()}:${String(error?.message || error || 'failed').slice(0, 60)}`
  rewards.failurePatterns[key] = (rewards.failurePatterns[key] || 0) + 1
  addReward(memory, 'repeated_failed_action', REWARDS.repeated_failed_action, { action, error: String(error?.message || error || 'failed') })
}

function recordDamage (memory, bot, oldHealth, newHealth) {
  if (!Number.isFinite(oldHealth) || !Number.isFinite(newHealth) || newHealth >= oldHealth) return
  const noNearbyEnemy = !hasNearbyHostile(bot)
  const likelyHunger = noNearbyEnemy && (bot.food ?? 20) <= 6
  addReward(memory, likelyHunger ? 'failed_to_eat_while_hungry' : 'taking_damage', likelyHunger ? REWARDS.failed_to_eat_while_hungry : REWARDS.taking_damage, {
    oldHealth,
    newHealth,
    food: bot.food,
    likelyCause: likelyHunger ? 'hunger' : 'damage'
  })
}

function recordDeath (memory, bot, tasks, cause = 'unknown') {
  const rewards = ensureRewardMemory(memory)
  const currentSkill = memory.ai?.autopilot?.activeSkill || memory.ai?.shortTermTask || tasks?.currentTask || null
  const entry = {
    at: new Date().toISOString(),
    goal: memory.ai?.currentGoal || null,
    skill: currentSkill,
    health: bot?.health ?? null,
    food: bot?.food ?? null,
    cause,
    position: bot?.entity?.position ? positionToJson(bot.entity.position) : null
  }
  addReward(memory, 'dying', REWARDS.dying, entry)
  rewards.lessons.push({
    at: entry.at,
    type: 'death',
    cause,
    lesson: deathLesson(cause)
  })
  rewards.lessons = rewards.lessons.slice(-30)
  saveMemory(memory)
}

function recordMovementDiagnostic (memory, bot, event, details = {}) {
  const rewards = ensureRewardMemory(memory)
  const movement = rewards.movement
  const pos = bot?.entity?.position ? positionToJson(bot.entity.position) : null
  if (event === 'stuck') {
    movement.stuckEvents++
    addReward(memory, 'getting_stuck', REWARDS.getting_stuck, { position: pos, ...details })
  }
  if (event === 'jump_attempt') movement.jumpAttempts++
  if (event === 'jump_failed') {
    movement.failedJumps++
    addReward(memory, 'getting_stuck', -4, { jumpFailed: true, position: pos, ...details })
  }
  movement.lastPosition = pos
  movement.lastMovedAt = new Date().toISOString()
  saveMemory(memory)
}

function shouldPrioritizeFood (memory, bot, config) {
  const rewards = ensureRewardMemory(memory)
  const safeFood = config.rewardSystem?.safeFoodLevel ?? 10
  const criticalFood = config.rewardSystem?.criticalFoodLevel ?? 6
  const food = bot.food ?? 20
  if (food <= criticalFood) return true
  if (food <= safeFood && rewards.priorities.foodPriority >= 65) return true
  return false
}

function rewardSummary (memory) {
  const rewards = ensureRewardMemory(memory)
  const scoreEntries = Object.entries(rewards.scores || {})
  const best = scoreEntries.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`)
  const worst = [...scoreEntries].sort((a, b) => a[1] - b[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`)
  const repeatedFailures = Object.entries(rewards.failurePatterns || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `${key} x${count}`)
  return {
    priorities: rewards.priorities,
    bestBehaviors: best,
    worstBehaviors: worst,
    repeatedFailures,
    recentLessons: (rewards.lessons || []).slice(-3).map(item => `${item.cause || item.type}: ${item.lesson}`)
  }
}

function adjustPriorities (rewards, behavior, points, details) {
  const p = rewards.priorities
  if (behavior === 'gathering_food' || behavior === 'eating_food' || behavior === 'prevented_starvation') p.foodPriority = clamp(p.foodPriority - 3, 30, 100)
  if (behavior === 'failed_to_eat_while_hungry') p.foodPriority = clamp(p.foodPriority + 20, 0, 100)
  if (behavior === 'dying' && details?.cause === 'starvation') p.foodPriority = clamp(p.foodPriority + 30, 0, 100)
  if (behavior === 'dying' && details?.cause === 'mob') p.combatPreparedness = clamp(p.combatPreparedness + 20, 0, 100)
  if (behavior === 'dying' && ['fall', 'lava', 'drowning', 'suffocation'].includes(details?.cause)) p.safetyPriority = clamp(p.safetyPriority + 20, 0, 100)
  if (behavior === 'getting_stuck' || behavior === 'repeated_failed_action') p.avoidStuckBehavior = clamp(p.avoidStuckBehavior + 8, 0, 100)
  if (behavior === 'mining' && points > 0) p.miningPriority = clamp(p.miningPriority - 1, 20, 100)
}

function deathLesson (cause) {
  if (cause === 'starvation') return 'Get food before mining or combat next run.'
  if (cause === 'mob') return 'Bring food, weapon, shield, armor, and torches before risky areas.'
  if (cause === 'lava') return 'Avoid lava, carry blocks or water, and reroute tunnels.'
  if (cause === 'fall') return 'Use staircase mining and avoid cliffs or unsafe drops.'
  if (cause === 'drowning') return 'Avoid water paths and surface earlier.'
  if (cause === 'suffocation') return 'Avoid gravel, sand, and cramped digging.'
  return 'Retry with a safer strategy and avoid repeating the same failed action.'
}

function hasNearbyHostile (bot) {
  const pos = bot?.entity?.position
  if (!pos) return false
  return Object.values(bot.entities || {}).some(entity => {
    if (!entity?.position || entity.type !== 'mob') return false
    const name = String(entity.name || '').toLowerCase()
    const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'slime', 'phantom'].some(item => name.includes(item))
    return hostile && entity.position.distanceTo(pos) < 12
  })
}

function compactDetails (details) {
  if (!details || typeof details !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(details).slice(0, 8)) {
    out[key] = typeof value === 'string' ? value.slice(0, 120) : value
  }
  return out
}

function clamp (value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

module.exports = {
  ensureRewardMemory,
  addReward,
  rewardAction,
  recordFailureReward,
  recordDamage,
  recordDeath,
  recordMovementDiagnostic,
  shouldPrioritizeFood,
  rewardSummary
}

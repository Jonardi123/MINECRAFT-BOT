const { countInventory } = require('./inventory')
const { saveMemory, positionToJson } = require('./memory')

function snapshotProgress (bot) {
  const pos = bot.entity?.position
  return {
    at: Date.now(),
    position: pos ? positionToJson(pos) : null,
    inventory: countInventory(bot),
    food: bot.food ?? null,
    health: bot.health ?? null,
    heldItem: bot.heldItem?.name || null,
    armor: armorSignature(bot)
  }
}

function evaluateProgress (before, after, options = {}) {
  const watched = options.watchItems || []
  const gainedItems = {}
  let gained = 0
  for (const name of watched) {
    const diff = (after.inventory[name] || 0) - (before.inventory[name] || 0)
    if (diff > 0) {
      gainedItems[name] = diff
      gained += diff
    }
  }

  const moved = before.position && after.position
    ? distance(before.position, after.position)
    : 0
  const inventoryChanged = JSON.stringify(before.inventory) !== JSON.stringify(after.inventory)
  const equipmentChanged = before.heldItem !== after.heldItem || before.armor !== after.armor
  const foodImproved = Number(after.food) > Number(before.food)
  const madeProgress = gained > 0 || inventoryChanged || equipmentChanged || foodImproved || moved >= (options.minMove || 1.25)

  return {
    madeProgress,
    gainedItems,
    moved: Math.round(moved * 10) / 10,
    inventoryChanged,
    equipmentChanged,
    foodImproved
  }
}

function startStep (memory, step) {
  const director = ensureDirectorMemory(memory)
  director.currentStep = step
  director.stepStartedAt = new Date().toISOString()
  director.stepAttempts[step] = (director.stepAttempts[step] || 0) + 1
  saveMemory(memory)
}

function finishStep (memory, step, result) {
  const director = ensureDirectorMemory(memory)
  director.lastStep = step
  director.lastProgressAt = result?.madeProgress ? new Date().toISOString() : director.lastProgressAt
  director.lastStepResult = result || null
  director.blockedReason = result?.madeProgress ? null : director.blockedReason
  saveMemory(memory)
}

function markBlocked (memory, step, reason) {
  const director = ensureDirectorMemory(memory)
  director.blockedReason = String(reason || 'blocked').slice(0, 160)
  director.blockedStep = step
  director.blockedAt = new Date().toISOString()
  recordProgressEvent(memory, 'blocked', { step, reason: director.blockedReason })
  saveMemory(memory)
}

function recordProgressEvent (memory, type, details = {}) {
  memory.ai = memory.ai || {}
  memory.ai.progressTracker = memory.ai.progressTracker || {}
  const tracker = memory.ai.progressTracker
  tracker.events = tracker.events || []
  tracker.events.push({
    at: new Date().toISOString(),
    type,
    details: compact(details)
  })
  tracker.events = tracker.events.slice(-80)

  if (type === 'path_timeout') pushLimited(tracker, 'pathTimeouts', details)
  if (type === 'block_target_failed') pushLimited(tracker, 'blockTargetFailures', details)
  if (type === 'missing_ingredient') pushLimited(tracker, 'missingIngredients', details)
  if (type === 'damage_guess') pushLimited(tracker, 'damageSourceGuesses', details)
  if (type === 'stuck_position') pushLimited(tracker, 'stuckPositions', details)
  saveMemory(memory)
}

function ensureDirectorMemory (memory) {
  memory.ai = memory.ai || {}
  memory.ai.director = memory.ai.director || {}
  const director = memory.ai.director
  director.mode = director.mode || 'idle'
  director.currentObjective = director.currentObjective || null
  director.currentStage = director.currentStage || null
  director.currentStep = director.currentStep || null
  director.stepAttempts = director.stepAttempts || {}
  director.lastProgressAt = director.lastProgressAt || null
  director.blockedReason = director.blockedReason || null
  director.resumeAfterInterrupt = director.resumeAfterInterrupt || null
  memory.ai.progressTracker = memory.ai.progressTracker || {}
  const tracker = memory.ai.progressTracker
  tracker.events = tracker.events || []
  tracker.pathTimeouts = tracker.pathTimeouts || []
  tracker.blockTargetFailures = tracker.blockTargetFailures || []
  tracker.missingIngredients = tracker.missingIngredients || []
  tracker.damageSourceGuesses = tracker.damageSourceGuesses || []
  tracker.stuckPositions = tracker.stuckPositions || []
  return director
}

function armorSignature (bot) {
  if (!bot.inventory || !bot.getEquipmentDestSlot) return ''
  return ['head', 'torso', 'legs', 'feet'].map(slot => {
    const item = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
    return item?.name || 'empty'
  }).join(',')
}

function distance (a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function pushLimited (tracker, key, details) {
  tracker[key] = tracker[key] || []
  tracker[key].push({ at: new Date().toISOString(), ...compact(details) })
  tracker[key] = tracker[key].slice(-20)
}

function compact (details) {
  const out = {}
  for (const [key, value] of Object.entries(details || {}).slice(0, 8)) {
    out[key] = typeof value === 'string' ? value.slice(0, 120) : value
  }
  return out
}

module.exports = {
  snapshotProgress,
  evaluateProgress,
  startStep,
  finishStep,
  markBlocked,
  recordProgressEvent,
  ensureDirectorMemory
}

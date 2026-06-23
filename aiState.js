const { saveMemory, positionToJson } = require('./memory')

function createAiState (memory) {
  memory.ai = memory.ai || {}
  memory.ai.enabled = memory.ai.enabled ?? true
  memory.ai.paused = memory.ai.paused ?? false
  memory.ai.currentGoal = memory.ai.currentGoal || null
  memory.ai.shortTermTask = memory.ai.shortTermTask || null
  memory.ai.targets = memory.ai.targets || {}
  memory.ai.progress = memory.ai.progress || {}
  memory.ai.failedActions = memory.ai.failedActions || []
  memory.ai.recentDecisions = memory.ai.recentDecisions || []
  memory.ai.retryCounts = memory.ai.retryCounts || {}

  function save () {
    saveMemory(memory)
  }

  function setGoal (goal) {
    memory.ai.currentGoal = String(goal || '').slice(0, 240) || null
    memory.ai.shortTermTask = null
    memory.ai.failedActions = []
    memory.ai.recentDecisions = []
    memory.ai.paused = false
    save()
  }

  function clearGoal () {
    memory.ai.currentGoal = null
    memory.ai.shortTermTask = null
    save()
  }

  function pause (reason) {
    memory.ai.paused = true
    memory.ai.pauseReason = reason || 'Paused'
    memory.ai.shortTermTask = null
    save()
  }

  function resume () {
    memory.ai.paused = false
    memory.ai.pauseReason = null
    save()
  }

  function recordDecision (decision, result) {
    memory.ai.recentDecisions = memory.ai.recentDecisions || []
    memory.ai.recentDecisions.push({
      at: new Date().toISOString(),
      action: decision?.action || 'unknown',
      target: decision?.target || null,
      reason: decision?.reason || null,
      result: String(result || '').slice(0, 160)
    })
    memory.ai.recentDecisions = memory.ai.recentDecisions.slice(-12)
    save()
  }

  function recordFailure (decision, error) {
    const key = actionKey(decision)
    memory.ai.retryCounts[key] = (memory.ai.retryCounts[key] || 0) + 1
    memory.ai.failedActions = memory.ai.failedActions || []
    memory.ai.failedActions.push({
      at: new Date().toISOString(),
      key,
      action: decision?.action || 'unknown',
      target: decision?.target || null,
      reason: decision?.reason || null,
      error: String(error?.message || error || 'failed').slice(0, 160)
    })
    memory.ai.failedActions = memory.ai.failedActions.slice(-10)
    save()
  }

  function markPosition (key, pos) {
    if (!pos) return
    memory.ai[key] = positionToJson(pos)
    save()
  }

  function setShortTask (task) {
    memory.ai.shortTermTask = task ? String(task).slice(0, 160) : null
    save()
  }

  function tooManyRepeats (decision, maxRepeats = 3) {
    const recent = memory.ai.recentDecisions || []
    const key = actionKey(decision)
    return recent.slice(-maxRepeats).every(item => `${item.action}:${item.target || ''}` === key)
  }

  function failureCount (decision) {
    return memory.ai.retryCounts[actionKey(decision)] || 0
  }

  return {
    memory,
    get data () {
      return memory.ai
    },
    save,
    setGoal,
    clearGoal,
    pause,
    resume,
    recordDecision,
    recordFailure,
    markPosition,
    setShortTask,
    tooManyRepeats,
    failureCount
  }
}

function actionKey (decision) {
  return `${decision?.action || 'unknown'}:${decision?.target || ''}`
}

module.exports = { createAiState }

const { depositInventory } = require('./chest')
const { craftItemByName, prepareWoodForCrafting } = require('./crafting')
const { eatIfSafe } = require('./combat')
const { ensurePickaxe } = require('./equipment')
const { farmTarget } = require('./farming')
const { smartMineResource, branchMineForResource } = require('./mining')
const { gatherStarterFood, gatherStarterStone, gatherWood, craftStarterKit } = require('./survival')
const { saveMemory } = require('./memory')

async function runPlannerRecommendation (context, signal) {
  const { bot, memory, config, speaker, planner } = context
  const status = planner.status({ ignoreCurrentTask: true })
  const recommendation = status.currentTaskRecommendation

  if (!recommendation) {
    speaker.say('Planner says stockpiles are stable right now.', true)
    rememberPlannerRun(memory, null, 'stable')
    return status
  }

  speaker.say(`Planner running: ${recommendation.task}.`, true)
  rememberPlannerRun(memory, recommendation, 'started')

  try {
    await executeRecommendation(context, status, recommendation, signal)
    rememberPlannerRun(memory, recommendation, 'done')
    speaker.say(`Planner finished: ${recommendation.task}.`, true)
    return planner.status({ ignoreCurrentTask: true })
  } catch (err) {
    rememberPlannerRun(memory, recommendation, 'failed', shortError(err))
    throw err
  }
}

async function executeRecommendation (context, status, recommendation, signal) {
  const { bot, memory, config, speaker } = context
  const goal = recommendation.goalKey

  if (goal === 'finish_current_task') {
    speaker.say('I am already working on a task.', true)
    return
  }

  if (goal === 'inventory') {
    const report = await depositInventory(bot, memory, config, 'storage', signal)
    speaker.say(formatDepositBrief(report), true)
    return
  }

  if (goal === 'food') {
    await secureFood(context, status, signal)
    return
  }

  if (goal === 'wood') {
    const amount = actionAmount(status, 'wood', 32, 96)
    await gatherWood(bot, config, speaker, signal, amount, { requireFreshLogs: true })
    return
  }

  if (goal === 'tools') {
    await craftStarterKit(bot, memory, config, speaker, signal)
    return
  }

  if (goal === 'coal') {
    await prepareMiningTrip(context, signal)
    await craftTorches(bot, signal).catch(() => false)
    await smartMineResource(bot, memory, config, speaker, 'coal', actionAmount(status, 'coal', 16, 64), signal)
    return
  }

  if (goal === 'iron') {
    await prepareMiningTrip(context, signal)
    await smartMineResource(bot, memory, config, speaker, 'iron', actionAmount(status, 'iron', 16, 64), signal)
    return
  }

  if (goal === 'diamonds') {
    if (!hasIronOrBetterPickaxe(bot)) {
      await prepareMiningTrip(context, signal)
      await smartMineResource(bot, memory, config, speaker, 'iron', 8, signal)
      return
    }
    await prepareMiningTrip(context, signal, { longTrip: true })
    await craftTorches(bot, signal).catch(() => false)
    await branchMineForResource(bot, memory, config, speaker, 'diamond', actionAmount(status, 'diamonds', 4, 24), signal)
    return
  }

  if (goal === 'stone') {
    await gatherStarterStone(bot, memory, config, speaker, signal, actionAmount(status, 'stone', 32, 128))
    return
  }

  throw new Error(`No executor for planner goal ${goal || recommendation.task}.`)
}

async function secureFood (context, status, signal) {
  const { bot, memory, config, speaker } = context
  if ((bot.food ?? 20) < 18) {
    const ate = await eatIfSafe(bot, null).catch(() => false)
    if (ate && (bot.food ?? 20) >= 14) return
  }

  const target = nearestFoodTarget(bot, config)
  if (target) {
    await farmTarget(bot, memory, config, speaker, target, actionAmount(status, 'food', 8, 16), signal)
    return
  }

  await gatherStarterFood(bot, memory, config, speaker, signal)
}

async function prepareMiningTrip (context, signal, options = {}) {
  const { bot, memory, config, speaker } = context
  const minFood = options.longTrip
    ? (config.director?.minFoodBeforeMining || 8)
    : Math.max(6, Math.floor((config.director?.minFoodBeforeMining || 8) / 2))

  if ((bot.food ?? 20) < 18) await eatIfSafe(bot, null).catch(() => false)
  if ((bot.food ?? 20) < minFood && !hasFood(bot)) {
    await gatherStarterFood(bot, memory, config, speaker, signal).catch(() => {})
  }
  if ((bot.food ?? 20) < minFood && !hasFood(bot)) throw new Error('No food for planner mining.')

  await ensurePickaxe(bot, memory, config, speaker, signal)
  await craftTorches(bot, signal).catch(() => false)
}

async function craftTorches (bot, signal) {
  if (countItems(bot, ['torch', 'soul_torch']) >= 16) return true
  if (!bot.inventory.items().some(item => item.name === 'coal' || item.name === 'charcoal')) return false
  await prepareWoodForCrafting(bot, signal).catch(() => {})
  return craftItemByName(bot, 'torch', 16, signal)
}

function actionAmount (status, key, min, max) {
  const row = status.stockpiles?.find(item => item.key === key)
  const missing = row?.missing || min
  return Math.max(min, Math.min(max, missing))
}

function nearestFoodTarget (bot, config) {
  const candidates = [
    ['cows', 'cow'],
    ['pigs', 'pig'],
    ['sheep', 'sheep'],
    ['chickens', 'chicken']
  ]
  const range = config.behavior?.mobSearchRadius || 32

  return candidates
    .map(([target, name]) => {
      const entity = bot.nearestEntity(entity => {
        if (!entity?.isValid || entity.name !== name || entity.username) return false
        return entity.position.distanceTo(bot.entity.position) <= range
      })
      return entity ? { target, distance: entity.position.distanceTo(bot.entity.position) } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)[0]?.target || null
}

function hasIronOrBetterPickaxe (bot) {
  return bot.inventory.items().some(item => ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(item.name))
}

function hasFood (bot) {
  return bot.inventory.items().some(item => [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
    'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton',
    'potato', 'mushroom_stew', 'sweet_berries', 'golden_apple'
  ].includes(item.name))
}

function countItems (bot, names) {
  return bot.inventory.items()
    .filter(item => names.includes(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

function rememberPlannerRun (memory, recommendation, result, detail = null) {
  memory.ai = memory.ai || {}
  memory.ai.goalPlanner = memory.ai.goalPlanner || {}
  const entry = {
    at: new Date().toISOString(),
    goal: recommendation?.goalKey || null,
    task: recommendation?.task || null,
    command: recommendation?.command || null,
    result,
    detail
  }
  memory.ai.goalPlanner.lastRun = entry
  memory.ai.goalPlanner.recentRuns = [entry, ...(memory.ai.goalPlanner.recentRuns || [])].slice(0, 10)
  saveMemory(memory)
}

function formatDepositBrief (report) {
  const deposited = Object.entries(report.deposited || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')
  if (deposited) return `Planner deposited ${deposited}.`
  if (report.full) return 'Planner tried to deposit, but the chest looks full.'
  return 'Planner found no junk to deposit.'
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 100)
}

module.exports = {
  runPlannerRecommendation
}

const { countInventory } = require('./inventory')
const { craftItemByName, ensureCraftingTable, prepareWoodForCrafting } = require('./crafting')
const { ensurePickaxe, equipBestArmorFromInventory } = require('./equipment')
const { collectNearbyItems } = require('./collection')
const { mineBlocks } = require('./mining')
const { farmTarget } = require('./farming')
const { buildStarterCamp } = require('./building')
const { depositInventory } = require('./chest')
const { assertNotCancelled, goNear, sleep } = require('./navigation')
const { positionToJson, saveMemory } = require('./memory')

const FOOD = ['porkchop', 'cooked_porkchop', 'beef', 'cooked_beef', 'mutton', 'cooked_mutton', 'chicken', 'cooked_chicken', 'bread', 'apple', 'carrot', 'potato', 'baked_potato', 'sweet_berries']
const LOGS = /_(log|stem)$/

function claimBotBase (bot, memory) {
  if (!bot.entity?.position) throw new Error('I cannot save a base before spawning.')
  memory.botBase = positionToJson(bot.entity.position)
  if (!memory.home) memory.home = { ...memory.botBase }
  saveMemory(memory)
  return memory.botBase
}

async function gatherWood (bot, config, speaker, signal, amount = config.survival?.targetLogs || 12, options = {}) {
  const start = logCount(bot)
  const goal = options.requireFreshLogs ? start + amount : Math.max(start, amount)
  const radius = config.survival?.treeSearchRadius || 48
  while (!signal?.cancelled && logCount(bot) < goal) {
    assertNotCancelled(signal)
    const tree = bot.findBlock({ matching: block => LOGS.test(block.name), maxDistance: radius })
    if (!tree) break
    if (bot.entity.position.distanceTo(tree.position) > 4) await goNear(bot, tree.position, 3, signal, config.behavior?.pathTimeoutMs || 6000)
    const block = bot.blockAt(tree.position)
    if (!block || !LOGS.test(block.name)) continue
    await bot.dig(block, true, 'raycast')
    await collectNearbyItems(bot, config, signal, { radius: 7, attempts: 3, waitMs: 150 }).catch(() => {})
  }
  if (logCount(bot) < goal) speaker?.say('I could not find enough reachable logs nearby.', true)
  return logCount(bot) - start
}

async function gatherStarterStone (bot, memory, config, speaker, signal, amount = config.survival?.targetStone || 24) {
  const have = stoneCount(bot)
  const needed = Math.max(0, amount - have)
  if (!needed) return 0
  await ensurePickaxe(bot, memory, config, speaker, signal)
  await mineBlocks(bot, memory, config, speaker, 'stone', needed, signal)
  return stoneCount(bot) - have
}

async function gatherStarterFood (bot, memory, config, speaker, signal, amount = config.survival?.targetFood || 4) {
  const starting = foodCount(bot)
  if (starting >= amount) return 0
  assertNotCancelled(signal)
  const nearest = nearestFoodMob(bot, config)
  if (!nearest) {
    speaker?.say('I could not find livestock nearby for food.', true)
    return 0
  }
  await farmTarget(bot, memory, config, speaker, nearest.target, config.survival?.starterFoodKills || 2, signal)
  return foodCount(bot) - starting
}

async function craftStarterKit (bot, memory, config, speaker, signal) {
  await prepareWoodForCrafting(bot, signal)
  if (logCount(bot) > 0 && !hasAny(bot, /_planks$/)) {
    const log = bot.inventory.items().find(item => LOGS.test(item.name))
    if (log) await craftItemByName(bot, log.name.replace(LOGS, '_planks'), 4, signal).catch(() => false)
  }
  const table = await ensureCraftingTable(bot, signal)
  if (!table) throw new Error('I need enough wood to place a crafting table.')
  const result = {}
  for (const [key, name] of [['pickaxe', 'wooden_pickaxe'], ['axe', 'wooden_axe'], ['sword', 'wooden_sword']]) {
    if (!hasItem(bot, name)) await craftItemByName(bot, name, 1, signal).catch(() => false)
    result[key] = hasItem(bot, name)
  }
  if (!result.pickaxe && !result.axe && !result.sword) throw new Error('I could not craft starter tools; gather more wood first.')
  return result
}

async function ensureStarterAxe (bot, memory, config, speaker, signal) {
  if (!hasItem(bot, 'wooden_axe')) {
    const result = await craftStarterKit(bot, memory, config, speaker, signal)
    if (!result.axe) throw new Error('I could not craft a wooden axe.')
  }
  return bot.inventory.items().find(item => item.name === 'wooden_axe')
}

async function ensureStarterSword (bot, memory, config, speaker, signal) {
  if (!hasItem(bot, 'wooden_sword')) {
    const result = await craftStarterKit(bot, memory, config, speaker, signal)
    if (!result.sword) throw new Error('I could not craft a wooden sword.')
  }
  return bot.inventory.items().find(item => item.name === 'wooden_sword')
}

async function bootstrapSurvival (bot, memory, config, speaker, signal) {
  claimBotBase(bot, memory)
  await gatherWood(bot, config, speaker, signal, config.survival?.targetLogs || 12)
  await craftStarterKit(bot, memory, config, speaker, signal)
  await gatherStarterStone(bot, memory, config, speaker, signal, config.survival?.targetStone || 24).catch(err => speaker?.say(`Starter stone skipped: ${err.message}`, true))
  await gatherStarterFood(bot, memory, config, speaker, signal, config.survival?.targetFood || 4).catch(err => speaker?.say(`Starter food skipped: ${err.message}`, true))
  await equipBestArmorFromInventory(bot, config).catch(() => {})
}

async function survivalLoop (bot, memory, config, speaker, signal, minutes = config.survival?.defaultSurvivalMinutes || 10) {
  const endAt = Date.now() + Math.max(1, Number(minutes) || 1) * 60_000
  while (!signal?.cancelled && Date.now() < endAt) {
    await bootstrapSurvival(bot, memory, config, speaker, signal)
    await sleep(1000)
  }
}

async function makeOwnStorage (bot, memory, config, speaker, signal) {
  await buildStarterCamp(bot, memory, config, speaker, signal)
  return memory.chests?.storage || null
}

async function depositToOwnStorage (bot, memory, config, signal) {
  if (!memory.chests?.storage) return false
  return depositInventory(bot, memory, config, 'storage', signal)
}

function foodCount (bot) { return sumInventory(bot, name => FOOD.includes(name)) }
function logCount (bot) { return sumInventory(bot, name => LOGS.test(name)) }
function stoneCount (bot) { return sumInventory(bot, name => ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate'].includes(name)) }
function sumInventory (bot, predicate) { return Object.entries(countInventory(bot)).reduce((sum, [name, count]) => sum + (predicate(name) ? count : 0), 0) }
function hasItem (bot, name) { return bot.inventory.items().some(item => item.name === name) }
function hasAny (bot, pattern) { return bot.inventory.items().some(item => pattern.test(item.name)) }
function nearestFoodMob (bot, config) {
  const names = new Map([['pig', 'pigs'], ['cow', 'cows'], ['sheep', 'sheep'], ['chicken', 'chickens']])
  const entity = bot.nearestEntity(candidate => candidate?.isValid && names.has(candidate.name) && !candidate.username && candidate.position.distanceTo(bot.entity.position) <= (config.behavior?.mobSearchRadius || 32))
  return entity ? { entity, target: names.get(entity.name) } : null
}

module.exports = {
  claimBotBase,
  gatherWood,
  gatherStarterStone,
  gatherStarterFood,
  craftStarterKit,
  ensureStarterAxe,
  ensureStarterSword,
  bootstrapSurvival,
  survivalLoop,
  makeOwnStorage,
  depositToOwnStorage
}

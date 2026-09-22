const { countInventory } = require('./inventory')
const { ensurePickaxe, equipBestArmorFromInventory } = require('./equipment')
const { craftItemByName, ensureCraftingTable, prepareWoodForCrafting } = require('./crafting')
const { gatherWood, gatherStarterStone, gatherStarterFood, craftStarterKit, makeOwnStorage } = require('./survival')
const { smartMineResource } = require('./mining')
const { cookFood } = require('./domestic')
const { assertNotCancelled } = require('./navigation')

function chooseDirectorStep (bot, memory, config) {
  const counts = countInventory(bot)
  const has = name => Boolean(counts[name])
  const wood = sumMatching(counts, name => /_(log|stem)$|_planks$/.test(name))
  const stone = (counts.cobblestone || 0) + (counts.cobbled_deepslate || 0) + (counts.stone || 0)
  const food = sumMatching(counts, name => /porkchop|beef|mutton|chicken|bread|apple|carrot|potato|sweet_berries/.test(name))
  const director = memory.ai?.director || (memory.ai = { ...(memory.ai || {}), director: {} }).director
  let step = 'idle_improve'
  if (food < (config.autopilot?.minFood || 6)) step = 'secure_food'
  else if (wood < (config.autopilot?.minWoodValue || 12)) step = 'gather_wood'
  else if (!has('wooden_pickaxe') && !has('stone_pickaxe') && !has('iron_pickaxe') && !has('diamond_pickaxe')) step = 'craft_tools'
  else if (stone < (config.autopilot?.minStone || 24)) step = 'mine_stone'
  else if (!has('stone_pickaxe') || !has('stone_axe') || !has('stone_sword')) step = 'craft_stone_tools'
  else if ((counts.iron_ingot || 0) < (config.autopilot?.minIron || 8)) step = 'mine_iron'
  else if ((counts.coal || 0) + (counts.charcoal || 0) < (config.autopilot?.minCoal || 8)) step = 'mine_coal'
  director.currentStage = stageFor(step)
  director.currentStep = step
  director.mode = 'running'
  return step
}

async function runDirectorStep (step, bot, memory, config, speaker, signal) {
  assertNotCancelled(signal)
  const normalized = String(step || '').toLowerCase()
  const director = (memory.ai = memory.ai || {}).director || (memory.ai.director = {})
  director.currentStep = normalized
  director.currentStage = stageFor(normalized)
  director.mode = 'running'
  try {
    switch (normalized) {
      case 'secure_food':
        await gatherStarterFood(bot, memory, config, speaker, signal)
        if (bot.inventory.items().some(item => /porkchop|beef|mutton|chicken/.test(item.name) && !item.name.startsWith('cooked_'))) {
          await cookFood(bot, memory, config, speaker, signal, 8).catch(() => {})
        }
        break
      case 'gather_wood':
      case 'get_logs':
        await gatherWood(bot, config, speaker, signal, config.autopilot?.woodLogsPerRun || 12, { requireFreshLogs: true })
        break
      case 'craft_tools':
      case 'craft_starter_tools':
        await craftStarterKit(bot, memory, config, speaker, signal)
        break
      case 'mine_stone':
        await gatherStarterStone(bot, memory, config, speaker, signal, config.autopilot?.minStone || 32)
        break
      case 'craft_stone_tools':
        await ensurePickaxe(bot, memory, config, speaker, signal).catch(() => {})
        await prepareWoodForCrafting(bot, signal)
        if (!await ensureCraftingTable(bot, signal)) throw new Error('I need a crafting table for stone tools.')
        for (const name of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
          if (!bot.inventory.items().some(item => item.name === name)) await craftItemByName(bot, name, 1, signal)
        }
        break
      case 'make_storage':
        await makeOwnStorage(bot, memory, config, speaker, signal)
        break
      case 'mine_coal':
      case 'mine_iron':
        await smartMineResource(bot, memory, config, speaker, normalized === 'mine_coal' ? 'coal' : 'iron', normalized === 'mine_coal' ? config.autopilot?.minCoal || 8 : config.autopilot?.minIron || 8, signal)
        break
      case 'prepare_mining':
      case 'prepare_diamond_mining':
        if ((bot.food ?? 20) < (config.director?.minFoodBeforeMining || 8)) await gatherStarterFood(bot, memory, config, speaker, signal)
        await ensurePickaxe(bot, memory, config, speaker, signal)
        await equipBestArmorFromInventory(bot, config).catch(() => {})
        break
      case 'mine_diamonds':
        await smartMineResource(bot, memory, config, speaker, 'diamond', 8, signal)
        break
      case 'prepare_nether':
      case 'armor_up':
        await equipBestArmorFromInventory(bot, config)
        break
      case 'craft_shield_bucket':
        await prepareWoodForCrafting(bot, signal)
        if (!await ensureCraftingTable(bot, signal)) throw new Error('I need a crafting table to make a shield or bucket.')
        for (const name of ['shield', 'bucket']) {
          if (!bot.inventory.items().some(item => item.name === name)) await craftItemByName(bot, name, 1, signal).catch(() => false)
        }
        break
      case 'idle_improve':
      case 'survival_progression':
        await equipBestArmorFromInventory(bot, config).catch(() => {})
        break
      default:
        throw new Error(`Unknown survival director step ${normalized}.`)
    }
    director.lastResult = 'completed'
    return { step: normalized, stage: director.currentStage }
  } catch (error) {
    director.lastResult = 'failed'
    director.lastError = String(error?.message || error).slice(0, 160)
    throw error
  } finally {
    director.lastRunAt = new Date().toISOString()
  }
}

function directorStatus (memory) {
  const director = memory.ai?.director
  if (!director) return 'director idle'
  return `director ${director.mode || 'idle'}${director.currentStage ? ` ${director.currentStage}` : ''}${director.currentStep ? `/${director.currentStep}` : ''}`
}

function stageFor (step) {
  if (['secure_food', 'gather_wood', 'craft_tools'].includes(step)) return 'starter'
  if (['mine_stone', 'craft_stone_tools', 'make_storage'].includes(step)) return 'stone_age'
  if (['prepare_mining', 'prepare_diamond_mining', 'mine_coal', 'mine_iron', 'mine_diamonds'].includes(step)) return 'mining'
  if (['prepare_nether', 'armor_up', 'craft_shield_bucket'].includes(step)) return 'advancement'
  return 'maintenance'
}

function sumMatching (counts, predicate) {
  return Object.entries(counts).reduce((sum, [name, count]) => sum + (predicate(name) ? count : 0), 0)
}

module.exports = { chooseDirectorStep, runDirectorStep, directorStatus }

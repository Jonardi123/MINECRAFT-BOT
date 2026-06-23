const { Vec3 } = require('vec3')
const { countInventory } = require('./inventory')
const { craftItemByName, prepareWoodForCrafting } = require('./crafting')
const { equipBestArmorFromInventory, ensurePickaxe } = require('./equipment')
const { collectNearbyItems } = require('./collection')
const { goNear, sleep, assertNotCancelled } = require('./navigation')
const {
  claimBotBase,
  gatherWood,
  craftStarterKit,
  gatherStarterStone,
  gatherStarterFood,
  makeOwnStorage,
  depositToOwnStorage
} = require('./survival')
const { smartMineResource } = require('./mining')
const { rewardAction, recordFailureReward, recordMovementDiagnostic, shouldPrioritizeFood } = require('./rewardSystem')
const { chooseDirectorStep, runDirectorStep, directorStatus } = require('./survivalDirector')
const { runAgentStep, agentStatus } = require('./agentCore')
const { cookFood } = require('./domestic')

const FOOD_NAMES = [
  'porkchop', 'cooked_porkchop', 'beef', 'cooked_beef', 'mutton', 'cooked_mutton',
  'chicken', 'cooked_chicken', 'bread', 'apple', 'carrot', 'potato', 'baked_potato',
  'mushroom_stew', 'sweet_berries'
]

const WOOD_NAMES = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
  'crimson_planks', 'warped_planks'
]

async function startAutopilot (bot, memory, config, speaker, tasks, signal, options = {}) {
  const autopilot = ensureAutopilotMemory(memory)
  const minutes = Number(options.minutes || 0)
  const endAt = minutes > 0 ? Date.now() + minutes * 60000 : Infinity
  autopilot.mode = 'running'
  autopilot.startedAt = new Date().toISOString()
  autopilot.lastProgressAt = autopilot.lastProgressAt || new Date().toISOString()
  saveAutopilot(memory)

  if (!memory.botBase) claimBotBase(bot, memory)
  speaker.say(minutes > 0 ? `Autoplay for ${minutes} min.` : 'Autoplay on.', true)
  const autopilotSpeaker = createAutopilotSpeaker(speaker, config)

  while (!signal.cancelled && Date.now() < endAt) {
    assertNotCancelled(signal)
    await equipBestArmorFromInventory(bot, config).catch(() => {})
    await collectNearbyItems(bot, config, signal, { radius: 6, attempts: 2, waitMs: 100 }).catch(() => {})

    const state = snapshotState(bot, memory, config)
    const skill = config.autopilot?.useAgentCore === false
      ? (config.autopilot?.useDirector === false ? chooseNextSkill(state) : chooseDirectorStep(bot, memory, config))
      : 'agent_step'
    autopilot.stage = stageForSkill(skill)
    autopilot.activeSkill = skill
    autopilot.lastPosition = toJsonPos(bot.entity.position)
    saveAutopilot(memory)

    const before = progressSignature(bot)
    try {
      if (config.autopilot?.useAgentCore !== false) {
        const result = await runAgentStep(bot, memory, config, autopilotSpeaker, signal)
        autopilot.stage = result.objective?.milestone || stageForSkill(result.skill)
        autopilot.activeSkill = result.skill
      } else if (config.autopilot?.useDirector === false) {
        await runSkill(skill, bot, memory, config, autopilotSpeaker, signal)
      } else {
        await runDirectorStep(skill, bot, memory, config, autopilotSpeaker, signal)
      }
      const after = progressSignature(bot)
      if (shouldRecoverOnNoProgress(skill) && detectStuck(memory, bot, before, after)) {
        recordMovementDiagnostic(memory, bot, 'stuck', { skill })
        throw new Error('no progress and no movement')
      }
      recordProgress(memory, skill, before, after)
      rewardAction(memory, rewardActionForSkill(skill), { skill })
    } catch (err) {
      if (signal.cancelled) throw err
      recordFailure(memory, skill, err)
      recordFailureReward(memory, skill, err)
      await recoverFromStuck(bot, memory, config, autopilotSpeaker, signal)
    } finally {
      autopilot.activeSkill = null
      saveAutopilot(memory)
    }

    await sleep(config.autopilot?.loopDelayMs || 750)
  }

  autopilot.mode = 'stopped'
  autopilot.activeSkill = null
  saveAutopilot(memory)
  speaker.say('Autoplay stopped.', true)
}

function chooseNextSkill (state) {
  if (state.shouldPrioritizeFood && state.foodCount > 0) return 'eat_food'
  if (state.shouldPrioritizeFood) return 'gather_food'
  if (state.health <= state.config.behavior.criticalHealth && state.foodCount > 0) return 'eat_food'
  if (state.food <= 8 && state.foodCount > 0) return 'eat_food'
  if (!state.botBase) return 'claim_base'
  if (state.failedSkills.get_logs >= 3 && state.woodValue < state.config.autopilot.minWoodValue) return 'recover_position'
  if (state.failedSkills.mine_stone >= 3 && state.stone < state.config.autopilot.minStone) return 'recover_position'
  if (state.failedSkills.craft_wood_tools >= 3 && state.woodValue < state.config.autopilot.minWoodValue) return 'get_logs'
  if (state.failedSkills.craft_wood_tools >= 5) return 'recover_position'
  if (state.woodValue < state.config.autopilot.minWoodValue) return 'get_logs'
  if (!state.hasCraftingTable && state.woodValue >= 4) return 'craft_table'
  if (!state.hasWoodenAxe || !state.hasWoodenPickaxe) return 'craft_wood_tools'
  if (!state.hasStorage && state.woodValue >= 24) return 'make_storage'
  if (state.stone < state.config.autopilot.minStone) return 'mine_stone'
  if (!state.hasStonePickaxe || !state.hasStoneAxe || !state.hasStoneSword) return 'craft_stone_tools'
  if (state.foodCount < state.config.autopilot.minFood) return 'gather_food'
  if (state.coal < state.config.autopilot.minCoal) return 'mine_coal'
  if (state.iron < state.config.autopilot.minIron) return 'mine_iron'
  if (state.hasStorage && state.inventoryUsed > state.config.autopilot.depositSlots) return 'deposit_junk'
  return 'idle_improve'
}

async function runSkill (skill, bot, memory, config, speaker, signal) {
  switch (skill) {
    case 'claim_base':
      claimBotBase(bot, memory)
      return
    case 'eat_food':
      await eatFood(bot)
      return
    case 'get_logs':
      await gatherWood(bot, config, speaker, signal, config.autopilot?.woodLogsPerRun || 12)
      return
    case 'craft_table':
    case 'craft_wood_tools':
      await craftStarterKit(bot, memory, config, speaker, signal)
      return
    case 'make_storage':
      await makeOwnStorage(bot, memory, config, speaker, signal)
      return
    case 'mine_stone':
      await gatherStarterStone(bot, memory, config, speaker, signal, config.autopilot?.minStone || 32)
      return
    case 'craft_stone_tools':
      await craftStoneTools(bot, memory, config, speaker, signal)
      return
    case 'gather_food':
      await gatherStarterFood(bot, memory, config, speaker, signal)
      if (rawFoodItem(bot)) await cookFood(bot, memory, config, speaker, signal, 8).catch(() => {})
      return
    case 'mine_coal':
      await smartMineResource(bot, memory, config, speaker, 'coal', config.autopilot?.minCoal || 8, signal)
      return
    case 'mine_iron':
      await smartMineResource(bot, memory, config, speaker, 'iron', config.autopilot?.minIron || 8, signal)
      return
    case 'deposit_junk':
      await depositToOwnStorage(bot, memory, config, signal)
      return
    case 'recover_position':
      await recoverFromStuck(bot, memory, config, speaker, signal)
      return
    case 'idle_improve':
      await idleImprove(bot, memory, config, speaker, signal)
      return
    default:
      throw new Error(`Unknown autopilot skill ${skill}`)
  }
}

function detectStuck (memory, bot, before, after) {
  const autopilot = ensureAutopilotMemory(memory)
  const moved = autopilot.lastPosition
    ? distance(toVec3(autopilot.lastPosition), bot.entity.position) > 1.25
    : true
  return before === after && !moved
}

async function recoverFromStuck (bot, memory, config, speaker, signal) {
  const autopilot = ensureAutopilotMemory(memory)
  autopilot.stuckRecoveries = (autopilot.stuckRecoveries || 0) + 1
  autopilot.lastRecoveryAt = new Date().toISOString()
  autopilot.failedSkills.get_logs = 0
  autopilot.failedSkills.mine_stone = 0
  saveAutopilot(memory)

  bot.pathfinder?.stop()
  bot.clearControlStates()
  const beforeJump = bot.entity.position.clone()
  recordMovementDiagnostic(memory, bot, 'jump_attempt', { skill: autopilot.activeSkill })
  bot.setControlState('jump', true)
  await sleep(250)
  bot.setControlState('jump', false)
  if (bot.entity.position.distanceTo(beforeJump) < 0.2) {
    recordMovementDiagnostic(memory, bot, 'jump_failed', { skill: autopilot.activeSkill })
  }

  const base = bot.entity.position.floored()
  const radius = Math.min(8, 3 + autopilot.stuckRecoveries)
  const target = base.offset(randomInt(-radius, radius), 0, randomInt(-radius, radius))
  await goNear(bot, target, 2, signal, config.behavior.pathTimeoutMs).catch(() => {})
  if (config.chat?.recoveryMessages !== false) speaker.autopilot?.('Repositioning.')
}

function recordProgress (memory, skill, before, after) {
  const autopilot = ensureAutopilotMemory(memory)
  const madeProgress = before !== after
  if (madeProgress) {
    autopilot.lastProgressAt = new Date().toISOString()
    autopilot.failedSkills[skill] = 0
  }
  autopilot.lastSkill = skill
  autopilot.lastResult = madeProgress ? 'progress' : 'no inventory change'
  saveAutopilot(memory)
}

function recordFailure (memory, skill, err) {
  const autopilot = ensureAutopilotMemory(memory)
  autopilot.failedSkills[skill] = (autopilot.failedSkills[skill] || 0) + 1
  autopilot.lastFailure = {
    at: new Date().toISOString(),
    skill,
    error: String(err?.message || err).slice(0, 160)
  }
  saveAutopilot(memory)
}

function autoplayStatus (memory) {
  const autopilot = ensureAutopilotMemory(memory)
  const failures = Object.entries(autopilot.failedSkills || {})
    .filter(([, count]) => count > 0)
    .slice(-3)
    .map(([skill, count]) => `${skill}:${count}`)
    .join(', ')
  return [
    agentStatus(memory),
    directorStatus(memory),
    `autoplay ${autopilot.mode || 'stopped'}`,
    `stage ${autopilot.stage || 'none'}`,
    `skill ${autopilot.activeSkill || autopilot.lastSkill || 'none'}`,
    failures ? `fails ${failures}` : null
  ].filter(Boolean).join(', ')
}

async function craftStoneTools (bot, memory, config, speaker, signal) {
  await ensurePickaxe(bot, memory, config, speaker, signal).catch(() => {})
  await prepareWoodForCrafting(bot, signal)
  for (const itemName of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
    if (!hasItem(bot, itemName)) await craftItemByName(bot, itemName, 1, signal).catch(() => false)
  }
}

async function idleImprove (bot, memory, config, speaker, signal) {
  const failures = ensureAutopilotMemory(memory).failedSkills || {}
  if ((failures.get_logs || 0) > 2) {
    await recoverFromStuck(bot, memory, config, speaker, signal)
    return
  }
  await gatherWood(bot, config, speaker, signal, 4).catch(() => {})
  await gatherStarterFood(bot, memory, config, speaker, signal).catch(() => {})
  if (rawFoodItem(bot)) await cookFood(bot, memory, config, speaker, signal, 8).catch(() => {})
}

function rawFoodItem (bot) {
  return bot.inventory.items().find(item => [
    'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'
  ].includes(item.name))
}

function createAutopilotSpeaker (speaker, config) {
  return {
    say (message, force = false) {
      if (force) {
        if (speaker.autopilot) speaker.autopilot(message, true)
        else speaker.say(message, true)
        return
      }
      if (speaker.autopilot) speaker.autopilot(message, false)
    },
    routine (message) {
      if (speaker.autopilot) speaker.autopilot(message, false)
    },
    autopilot (message, important = false) {
      if (speaker.autopilot) speaker.autopilot(message, important)
      else if (important) speaker.say(message, true)
    },
    whisper (username, message) {
      speaker.whisper(username, message)
    }
  }
}

function shouldRecoverOnNoProgress (skill) {
  return ![
    'agent_step',
    'craft_table',
    'craft_wood_tools',
    'craft_stone_tools',
    'deposit_junk',
    'eat_food',
    'claim_base',
    'recover_position'
  ].includes(skill)
}

async function eatFood (bot) {
  const food = bot.inventory.items().find(item => FOOD_NAMES.includes(item.name))
  if (!food) throw new Error('no food')
  await bot.equip(food, 'hand')
  await bot.consume()
}

function snapshotState (bot, memory, config) {
  const counts = countInventory(bot)
  return {
    config,
    health: bot.health || 0,
    food: bot.food || 0,
    shouldPrioritizeFood: shouldPrioritizeFood(memory, bot, config),
    botBase: memory.botBase,
    failedSkills: memory.ai?.autopilot?.failedSkills || {},
    hasStorage: Boolean(memory.chests?.botStorage || memory.chests?.storage),
    woodValue: woodValue(counts),
    stone: sum(counts, ['cobblestone', 'cobbled_deepslate', 'stone']),
    coal: sum(counts, ['coal', 'charcoal']),
    iron: sum(counts, ['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore']),
    foodCount: sum(counts, FOOD_NAMES),
    hasCraftingTable: Boolean(counts.crafting_table) || Boolean(bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 8 })),
    hasWoodenAxe: Boolean(counts.wooden_axe),
    hasWoodenPickaxe: Boolean(counts.wooden_pickaxe || counts.stone_pickaxe || counts.iron_pickaxe || counts.diamond_pickaxe),
    hasStonePickaxe: Boolean(counts.stone_pickaxe || counts.iron_pickaxe || counts.diamond_pickaxe),
    hasStoneAxe: Boolean(counts.stone_axe || counts.iron_axe || counts.diamond_axe),
    hasStoneSword: Boolean(counts.stone_sword || counts.iron_sword || counts.diamond_sword),
    inventoryUsed: bot.inventory.items().length
  }
}

function ensureAutopilotMemory (memory) {
  memory.ai = memory.ai || {}
  memory.ai.autopilot = memory.ai.autopilot || {}
  const autopilot = memory.ai.autopilot
  autopilot.mode = autopilot.mode || 'stopped'
  autopilot.stage = autopilot.stage || null
  autopilot.activeSkill = autopilot.activeSkill || null
  autopilot.failedSkills = autopilot.failedSkills || {}
  autopilot.resourcesWanted = autopilot.resourcesWanted || {}
  autopilot.knownWorksites = autopilot.knownWorksites || {}
  autopilot.knownTrees = autopilot.knownTrees || []
  autopilot.knownMineEntrances = autopilot.knownMineEntrances || []
  return autopilot
}

function saveAutopilot (memory) {
  memory.lastUpdated = new Date().toISOString()
  require('./memory').saveMemory(memory)
}

function progressSignature (bot) {
  const pos = bot.entity.position
  const counts = countInventory(bot)
  return JSON.stringify({
    pos: [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)],
    inventory: counts,
    held: bot.heldItem?.name || null,
    food: bot.food,
    health: bot.health
  })
}

function stageForSkill (skill) {
  if (skill === 'agent_step') return 'agent_core'
  if (['claim_base', 'get_logs', 'gather_wood', 'craft_table', 'craft_wood_tools', 'craft_tools'].includes(skill)) return 'wood_age'
  if (['make_storage', 'mine_stone', 'craft_stone_tools'].includes(skill)) return 'stone_age'
  if (['gather_food', 'secure_food', 'mine_coal', 'get_coal', 'mine_iron', 'get_iron', 'craft_shield_bucket', 'armor_up'].includes(skill)) return 'iron_prep'
  if (['prepare_diamond_mining', 'mine_diamonds'].includes(skill)) return 'diamond_prep'
  if (['prepare_nether'].includes(skill)) return 'nether_prep'
  if (['prepare_dragon'].includes(skill)) return 'dragon_prep'
  return 'survival_improve'
}

function rewardActionForSkill (skill) {
  if (skill === 'eat_food') return 'eat_food'
  if (skill === 'gather_food' || skill === 'secure_food') return 'gather_food'
  if (skill === 'get_logs' || skill === 'gather_wood') return 'gather_wood'
  if (skill.includes('mine')) return 'mine_resource'
  if (skill.includes('craft')) return 'craft_item'
  if (skill === 'idle_improve') return 'idle'
  return skill
}

function woodValue (counts) {
  return Object.entries(counts).reduce((total, [name, count]) => {
    if (name.endsWith('_log') || name.endsWith('_stem')) return total + count * 4
    if (WOOD_NAMES.includes(name)) return total + count
    return total
  }, 0)
}

function sum (counts, names) {
  return names.reduce((total, name) => total + (counts[name] || 0), 0)
}

function hasItem (bot, name) {
  return bot.inventory.items().some(item => item.name === name)
}

function toJsonPos (pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}

function toVec3 (pos) {
  return new Vec3(pos.x, pos.y, pos.z)
}

function distance (a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function randomInt (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

module.exports = {
  startAutopilot,
  chooseNextSkill,
  runSkill,
  detectStuck,
  recoverFromStuck,
  recordProgress,
  autoplayStatus
}

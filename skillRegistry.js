const { goNear, getHomePosition } = require('./navigation')
const { runDirectorStep } = require('./survivalDirector')
const { executeMiningPlan, chooseMiningPlan } = require('./miningPlanner')
const { prepareForCombat, fightBestThreat } = require('./combatPlanner')

const SKILLS = {
  secure_food: {
    description: 'Eat or gather enough food before risky work.',
    timeoutMs: 60000,
    preconditions: [],
    expected: 'food restored or food gained',
    recovery: 'gather_wood_or_return_home'
  },
  gather_wood: {
    description: 'Gather logs and collect drops.',
    timeoutMs: 90000,
    preconditions: [],
    expected: 'logs or planks increase',
    recovery: 'switch_tree_or_reposition'
  },
  craft_starter_tools: {
    description: 'Craft table, sticks, wooden pickaxe, and wooden axe.',
    timeoutMs: 45000,
    preconditions: ['wood'],
    expected: 'pickaxe and axe exist',
    recovery: 'gather_wood'
  },
  mine_stone: {
    description: 'Mine starter cobblestone safely with a pickaxe.',
    timeoutMs: 90000,
    preconditions: ['pickaxe'],
    expected: 'cobblestone increases',
    recovery: 'craft_starter_tools'
  },
  craft_stone_tools: {
    description: 'Craft stone pickaxe, axe, and sword.',
    timeoutMs: 45000,
    preconditions: ['stone', 'wood'],
    expected: 'stone tools exist',
    recovery: 'mine_stone'
  },
  make_storage: {
    description: 'Craft/place storage and save it.',
    timeoutMs: 60000,
    preconditions: ['wood'],
    expected: 'storage chest saved',
    recovery: 'gather_wood'
  },
  prepare_mining: {
    description: 'Prepare food, pickaxe, torches, armor, inventory space.',
    timeoutMs: 90000,
    preconditions: ['food', 'pickaxe'],
    expected: 'mining loadout ready',
    recovery: 'secure_food'
  },
  mine_coal: { description: 'Mine coal or make progress toward torches.', timeoutMs: 120000, preconditions: ['pickaxe'], expected: 'coal gained', recovery: 'mine_stone' },
  mine_iron: { description: 'Mine iron safely.', timeoutMs: 180000, preconditions: ['pickaxe', 'food'], expected: 'iron gained', recovery: 'prepare_mining' },
  craft_shield_bucket: { description: 'Craft shield and bucket when iron exists.', timeoutMs: 45000, preconditions: ['iron', 'wood'], expected: 'shield/bucket exists', recovery: 'mine_iron' },
  armor_up: { description: 'Equip or craft better armor.', timeoutMs: 60000, preconditions: ['armor or iron'], expected: 'armor improves', recovery: 'mine_iron' },
  prepare_diamond_mining: { description: 'Prepare iron pickaxe, food, blocks, torches.', timeoutMs: 120000, preconditions: ['iron_pickaxe', 'food'], expected: 'diamond loadout ready', recovery: 'mine_iron' },
  mine_diamonds: { description: 'Safe branch mine for diamonds.', timeoutMs: 300000, preconditions: ['iron_pickaxe', 'food'], expected: 'diamonds gained or tunnel extended safely', recovery: 'prepare_diamond_mining' },
  prepare_nether: { description: 'Prepare food, armor, shield, blocks, pickaxe, weapon.', timeoutMs: 120000, preconditions: ['iron_kit'], expected: 'nether loadout ready', recovery: 'mine_iron' },
  combat_prepare: { description: 'Equip weapon, armor, shield, food.', timeoutMs: 45000, preconditions: ['food', 'weapon'], expected: 'combat loadout ready', recovery: 'secure_food' },
  return_home: { description: 'Return to saved home.', timeoutMs: 60000, preconditions: ['home'], expected: 'near home', recovery: 'recover_from_stuck' },
  recover_from_stuck: { description: 'Clear movement and reposition.', timeoutMs: 30000, preconditions: [], expected: 'position changes', recovery: 'return_home' },
  survival_progression: { description: 'General survival improvement.', timeoutMs: 60000, preconditions: [], expected: 'some useful progress', recovery: 'secure_food' }
}

async function runRegisteredSkill (skill, ctx, signal) {
  const { bot, memory, config, speaker } = ctx
  const name = normalizeSkill(skill)
  assertKnownSkill(name)

  switch (name) {
    case 'secure_food':
      return runDirectorStep('secure_food', bot, memory, config, speaker, signal)
    case 'gather_wood':
      return runDirectorStep('gather_wood', bot, memory, config, speaker, signal)
    case 'craft_starter_tools':
      return runDirectorStep('craft_tools', bot, memory, config, speaker, signal)
    case 'mine_stone':
      return runDirectorStep('mine_stone', bot, memory, config, speaker, signal)
    case 'craft_stone_tools':
      return runDirectorStep('craft_stone_tools', bot, memory, config, speaker, signal)
    case 'make_storage':
      return runDirectorStep('make_storage', bot, memory, config, speaker, signal)
    case 'prepare_mining':
      return runDirectorStep('prepare_diamond_mining', bot, memory, config, speaker, signal)
    case 'mine_coal':
      return executeMiningPlan(bot, memory, config, speaker, { target: 'coal', amount: config.autopilot?.minCoal || 8 }, signal)
    case 'mine_iron':
      return executeMiningPlan(bot, memory, config, speaker, { target: 'iron', amount: config.autopilot?.minIron || 8 }, signal)
    case 'craft_shield_bucket':
      return runDirectorStep('craft_shield_bucket', bot, memory, config, speaker, signal)
    case 'armor_up':
      return runDirectorStep('armor_up', bot, memory, config, speaker, signal)
    case 'prepare_diamond_mining':
      return runDirectorStep('prepare_diamond_mining', bot, memory, config, speaker, signal)
    case 'mine_diamonds':
      return executeMiningPlan(bot, memory, config, speaker, chooseMiningPlan('diamond'), signal)
    case 'prepare_nether':
      return runDirectorStep('prepare_nether', bot, memory, config, speaker, signal)
    case 'combat_prepare':
      return prepareForCombat(bot, memory, config, speaker, signal)
    case 'return_home': {
      const home = getHomePosition(memory, config)
      if (!home) throw new Error('no home saved')
      await goNear(bot, home, 2, signal, config.behavior?.pathTimeoutMs || 6000)
      return
    }
    case 'recover_from_stuck':
      bot.pathfinder?.stop()
      bot.clearControlStates()
      bot.setControlState('jump', true)
      await new Promise(resolve => setTimeout(resolve, 250))
      bot.setControlState('jump', false)
      return
    case 'survival_progression':
      return runDirectorStep('idle_improve', bot, memory, config, speaker, signal)
    default:
      throw new Error(`No deterministic runner for ${name}`)
  }
}

function getSkillSpec (skill) {
  return SKILLS[normalizeSkill(skill)] || null
}

function listSkillsForPrompt () {
  return Object.entries(SKILLS).map(([name, spec]) => ({
    skill: name,
    description: spec.description,
    preconditions: spec.preconditions,
    expected: spec.expected
  }))
}

function normalizeSkill (skill) {
  const name = String(skill || '').toLowerCase()
  const aliases = {
    get_logs: 'gather_wood',
    craft_tools: 'craft_starter_tools',
    craft_wood_tools: 'craft_starter_tools',
    get_coal: 'mine_coal',
    get_iron: 'mine_iron',
    safe_branch_mine: 'mine_diamonds',
    nether_prepare: 'prepare_nether'
  }
  return aliases[name] || name
}

function assertKnownSkill (skill) {
  if (!SKILLS[skill]) throw new Error(`unknown skill ${skill}`)
}

module.exports = {
  SKILLS,
  runRegisteredSkill,
  getSkillSpec,
  listSkillsForPrompt,
  normalizeSkill,
  assertKnownSkill,
  fightBestThreat
}

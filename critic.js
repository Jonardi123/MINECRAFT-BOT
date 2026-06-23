const { countInventory } = require('./inventory')
const { evaluateProgress } = require('./progressTracker')
const { addReward, recordFailureReward } = require('./rewardSystem')

function critiqueSkill (skill, before, after, bot, memory) {
  const contract = progressContract(skill)
  const progress = evaluateProgress(before, after, {
    watchItems: contract.watchItems,
    minMove: contract.minMove ?? 1.25
  })
  const counts = countInventory(bot)
  const checks = contract.checks || []
  const failed = []

  for (const check of checks) {
    if (check === 'has_food' && !hasAny(counts, FOOD_NAMES) && bot.food < 18) failed.push('missing food')
    if (check === 'has_pickaxe' && !hasAnySuffix(counts, '_pickaxe')) failed.push('missing pickaxe')
    if (check === 'has_weapon' && !hasWeapon(counts)) failed.push('missing weapon')
    if (check === 'has_shield' && !counts.shield) failed.push('missing shield')
    if (check === 'has_blocks' && blockCount(counts) < 8) failed.push('missing blocks')
  }

  const checksPassed = checks.length > 0 && failed.length === 0
  const success = progress.madeProgress || checksPassed || (failed.length === 0 && contract.allowNoProgress)
  const verdict = {
    success,
    reason: success ? 'verified' : failed[0] || 'no measurable progress',
    progress,
    failed
  }

  if (success) addReward(memory, 'completing_objectives', 6, { skill })
  else recordFailureReward(memory, skill, verdict.reason)
  return verdict
}

function progressContract (skill) {
  const contracts = {
    secure_food: { watchItems: FOOD_NAMES, checks: ['has_food'], minMove: 1, allowNoProgress: true },
    gather_wood: { watchItems: WOOD_NAMES, minMove: 1 },
    craft_starter_tools: { checks: ['has_pickaxe'], allowNoProgress: false },
    mine_stone: { watchItems: ['cobblestone', 'cobbled_deepslate', 'stone'], checks: ['has_pickaxe'] },
    craft_stone_tools: { checks: ['has_pickaxe', 'has_weapon'], allowNoProgress: false },
    make_storage: { watchItems: ['chest'], allowNoProgress: true },
    prepare_mining: { checks: ['has_food', 'has_pickaxe', 'has_blocks'], allowNoProgress: true },
    mine_coal: { watchItems: ['coal', 'charcoal'], checks: ['has_pickaxe'] },
    mine_iron: { watchItems: ['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore'], checks: ['has_pickaxe'] },
    craft_shield_bucket: { checks: ['has_shield'], allowNoProgress: true },
    armor_up: { allowNoProgress: true },
    prepare_diamond_mining: { checks: ['has_food', 'has_pickaxe', 'has_blocks'], allowNoProgress: true },
    mine_diamonds: { watchItems: ['diamond'], checks: ['has_food', 'has_pickaxe'] },
    prepare_nether: { checks: ['has_food', 'has_pickaxe', 'has_weapon', 'has_blocks'], allowNoProgress: true },
    combat_prepare: { checks: ['has_food', 'has_weapon'], allowNoProgress: true },
    return_home: { minMove: 1, allowNoProgress: true },
    recover_from_stuck: { minMove: 1 }
  }
  return contracts[skill] || { minMove: 1, allowNoProgress: false }
}

const FOOD_NAMES = [
  'porkchop', 'cooked_porkchop', 'beef', 'cooked_beef', 'mutton', 'cooked_mutton',
  'chicken', 'cooked_chicken', 'bread', 'apple', 'carrot', 'potato', 'baked_potato',
  'rotten_flesh', 'spider_eye'
]

const WOOD_NAMES = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks'
]

function hasAny (counts, names) {
  return names.some(name => counts[name] > 0)
}

function hasAnySuffix (counts, suffix) {
  return Object.keys(counts).some(name => name.endsWith(suffix) && counts[name] > 0)
}

function hasWeapon (counts) {
  return Object.keys(counts).some(name => (name.endsWith('_sword') || name.endsWith('_axe')) && counts[name] > 0)
}

function blockCount (counts) {
  return ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'oak_planks', 'spruce_planks', 'netherrack']
    .reduce((sum, name) => sum + (counts[name] || 0), 0)
}

module.exports = {
  critiqueSkill,
  progressContract
}

const { countInventory } = require('./inventory')
const { ensureDirectorMemory } = require('./progressTracker')
const { rewardSummary } = require('./rewardSystem')

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

function chooseCurriculumObjective (bot, memory, config) {
  const curriculum = ensureCurriculumMemory(memory)
  const state = curriculumState(bot, memory, config)
  updateMilestones(curriculum, state)

  let objective
  if (!state.hasFoodSecurity) objective = obj('secure_food', 'food_stable', 'Food is required before long tasks.')
  else if (state.woodValue < config.autopilot.minWoodValue) objective = obj('gather_wood', 'logs', 'Need wood for tools and crafting.')
  else if (!state.hasCraftingTable || !state.hasAnyPickaxe || !state.hasAnyAxe) objective = obj('craft_starter_tools', 'starter_tools', 'Need table, axe, and pickaxe.')
  else if (state.stone < config.autopilot.minStone) objective = obj('mine_stone', 'stone_tools', 'Need stone for better tools.')
  else if (!state.hasStoneTools) objective = obj('craft_stone_tools', 'stone_tools', 'Upgrade to stone tools.')
  else if (!state.hasStorage && state.woodValue >= 24) objective = obj('make_storage', 'storage', 'Need a stash for safe progress.')
  else if (state.needsCombatReadiness) objective = obj('combat_prepare', 'combat_ready', 'Recent damage says gear up before risky work.')
  else if (state.coal < config.autopilot.minCoal) objective = obj('mine_coal', 'coal', 'Need coal or charcoal for torches and smelting.')
  else if (state.iron < config.autopilot.minIron) objective = obj('mine_iron', 'iron', 'Iron unlocks shield, bucket, armor, and better mining.')
  else if (!state.hasShield || !state.hasBucket) objective = obj('craft_shield_bucket', 'iron_kit', 'Shield and bucket improve survival.')
  else if (state.armorPieces < 3 && state.iron >= 12) objective = obj('armor_up', 'armor', 'Armor reduces deaths during exploration.')
  else if (wantsDiamonds(memory) && !state.hasIronOrBetterPickaxe) objective = obj('prepare_diamond_mining', 'diamond_prep', 'Need iron pickaxe or better before diamonds.')
  else if (wantsDiamonds(memory) && state.diamonds < targetAmount(memory.ai?.currentGoal, 4)) objective = obj('mine_diamonds', 'diamonds', 'Mine diamonds with safe branch mining.')
  else if (wantsNether(memory)) objective = obj('prepare_nether', 'nether_ready', 'Prepare safe Nether loadout before entering.')
  else if (wantsDragon(memory)) objective = obj('prepare_dragon', 'dragon_ready', 'Prepare for stronghold and dragon later.')
  else objective = obj('survival_progression', 'open_progress', 'Improve supplies and stay ready.')

  curriculum.currentObjective = objective
  curriculum.lastChosenAt = new Date().toISOString()
  ensureDirectorMemory(memory).currentObjective = objective.skill
  return objective
}

function markCurriculumResult (memory, objective, verdict) {
  const curriculum = ensureCurriculumMemory(memory)
  const record = {
    at: new Date().toISOString(),
    objective: objective?.skill || 'unknown',
    milestone: objective?.milestone || null,
    success: Boolean(verdict?.success),
    reason: verdict?.reason || null
  }
  if (record.success) {
    curriculum.completed.push(record)
    curriculum.completed = curriculum.completed.slice(-80)
    if (record.milestone) curriculum.milestones[record.milestone] = true
  } else {
    curriculum.failed.push(record)
    curriculum.failed = curriculum.failed.slice(-80)
    if (record.milestone) curriculum.blocked[record.milestone] = record
  }
}

function curriculumState (bot, memory, config) {
  const counts = countInventory(bot)
  const reward = rewardSummary(memory)
  const scores = memory.ai?.rewards?.scores || {}
  const foodCount = sum(counts, FOOD_NAMES)
  const minFood = config.autopilot?.minFood ?? 6
  const safeMiningFood = config.director?.minFoodBeforeMining ?? 8
  const foodPriority = reward.priorities?.foodPriority ?? 50
  const damageScore = (scores.taking_damage || 0) + (scores.dying || 0)
  const hasFoodSecurity = foodCount >= minFood || (bot.food >= 18 && foodCount >= 2 && foodPriority < 80)
  return {
    counts,
    reward,
    food: bot.food || 0,
    health: bot.health || 0,
    hasFoodSecurity: hasFoodSecurity && bot.food >= Math.min(safeMiningFood, 12),
    woodValue: woodValue(counts),
    stone: sum(counts, ['cobblestone', 'cobbled_deepslate', 'stone']),
    coal: sum(counts, ['coal', 'charcoal']),
    iron: sum(counts, ['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore']),
    diamonds: sum(counts, ['diamond']),
    hasCraftingTable: Boolean(counts.crafting_table) || Boolean(bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 8 })),
    hasStorage: Boolean(memory.chests?.botStorage || memory.chests?.storage),
    hasAnyPickaxe: hasAny(counts, ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']),
    hasAnyAxe: hasAny(counts, ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']),
    hasWeapon: hasAny(counts, ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword', 'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']),
    hasStoneTools: hasAny(counts, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']) &&
      hasAny(counts, ['stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']) &&
      hasAny(counts, ['stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword']),
    hasIronOrBetterPickaxe: hasAny(counts, ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']),
    hasShield: Boolean(counts.shield),
    hasBucket: Boolean(counts.bucket || counts.water_bucket),
    armorPieces: armorPieces(bot),
    needsCombatReadiness: damageScore <= -120 && hasFoodSecurity && (
      !hasAny(counts, ['shield']) ||
      !hasAny(counts, ['stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword', 'stone_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']) ||
      armorPieces(bot) < 2
    )
  }
}

function ensureCurriculumMemory (memory) {
  memory.ai = memory.ai || {}
  memory.ai.curriculum = memory.ai.curriculum || {}
  const curriculum = memory.ai.curriculum
  curriculum.milestones = curriculum.milestones || {}
  curriculum.completed = curriculum.completed || []
  curriculum.failed = curriculum.failed || []
  curriculum.blocked = curriculum.blocked || {}
  return curriculum
}

function updateMilestones (curriculum, state) {
  curriculum.milestones.logs = state.woodValue >= 16
  curriculum.milestones.crafting_table = state.hasCraftingTable
  curriculum.milestones.starter_tools = state.hasAnyPickaxe && state.hasAnyAxe
  curriculum.milestones.stone_tools = state.hasStoneTools
  curriculum.milestones.food_stable = state.hasFoodSecurity
  curriculum.milestones.coal = state.coal >= 4
  curriculum.milestones.iron = state.iron >= 8
  curriculum.milestones.iron_kit = state.hasShield && state.hasBucket
  curriculum.milestones.armor = state.armorPieces >= 3
  curriculum.milestones.combat_ready = state.hasWeapon && (state.hasShield || state.armorPieces >= 2)
  curriculum.milestones.diamonds = state.diamonds > 0
  curriculum.milestones.nether_ready = state.hasShield && state.armorPieces >= 3 && state.hasFoodSecurity
}

function obj (skill, milestone, reason) {
  return { skill, milestone, reason }
}

function wantsDiamonds (memory) {
  const goal = String(memory.ai?.currentGoal || '').toLowerCase()
  return goal.includes('diamond')
}

function wantsNether (memory) {
  const goal = String(memory.ai?.currentGoal || '').toLowerCase()
  return ['nether', 'blaze', 'fortress', 'pearl', 'ender'].some(word => goal.includes(word))
}

function wantsDragon (memory) {
  const goal = String(memory.ai?.currentGoal || '').toLowerCase()
  return ['dragon', 'stronghold', 'beat minecraft', 'beat the game'].some(word => goal.includes(word))
}

function targetAmount (goal, fallback) {
  const text = String(goal || '')
  const stackMatch = text.match(/(\d+)\s*stacks?/i)
  if (stackMatch) return Number(stackMatch[1]) * 64
  const numberMatch = text.match(/(\d+)/)
  return numberMatch ? Number(numberMatch[1]) : fallback
}

function hasAny (counts, names) {
  return names.some(name => counts[name] > 0)
}

function sum (counts, names) {
  return names.reduce((total, name) => total + (counts[name] || 0), 0)
}

function woodValue (counts) {
  return Object.entries(counts).reduce((total, [name, count]) => {
    if (name.endsWith('_log') || name.endsWith('_stem')) return total + count * 4
    if (WOOD_NAMES.includes(name)) return total + count
    return total
  }, 0)
}

function armorPieces (bot) {
  return ['head', 'torso', 'legs', 'feet'].filter(slot => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]).length
}

module.exports = {
  chooseCurriculumObjective,
  markCurriculumResult,
  curriculumState,
  ensureCurriculumMemory
}

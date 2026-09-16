const { countInventory } = require('./inventory')
const { rewardSummary } = require('./rewardSystem')
const { HOSTILES } = require('./safety')
const { adaptiveThreatSummary } = require('./modThreat')

const NOTABLE_BLOCKS = [
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore',
  'coal_ore', 'deepslate_coal_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'emerald_ore',
  'spawner', 'end_portal',
  'lava', 'water',
  'crafting_table', 'furnace', 'chest', 'end_chest'
]

const HOSTILE_RANGE = 24
const VISIBLE_RANGE = 24

function createWorldSummary (bot, memory, config, tasks, protector, pvp, state) {
  const pos = bot.entity?.position
  return {
    currentGoal: memory.ai?.currentGoal || null,
    currentTask: tasks?.currentTask || 'idle',
    shortTermTask: memory.ai?.shortTermTask || null,
    health: bot.health ?? 20,
    food: bot.food ?? 20,
    position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
    dimension: bot.game?.dimension || bot.game?.dimensionName || 'unknown',
    heldItem: bot.heldItem?.name || 'empty hand',
    inventory: countInventory(bot),
    director: {
      stage: memory.ai?.director?.currentStage || null,
      step: memory.ai?.director?.currentStep || null
    },
    hostileMobs: scanHostiles(bot, config),
    adaptiveThreats: adaptiveThreatSummary(bot, config, memory),
    visibleBlocks: scanVisibleBlocks(bot),
    failedActions: memory.ai?.failedActions || [],
    recentDecisions: memory.ai?.recentDecisions || [],
    rewardLearning: rewardSummary(memory),
    combat: {
      pvp: {
        enabled: pvp?.enabled ?? false,
        active: pvp?.active ?? false,
        target: pvp?.targetName || null
      },
      protector: {
        enabled: protector?.enabled ?? false
      }
    }
  }
}

function scanHostiles (bot, config) {
  const range = config.behavior?.hostileScanRange || HOSTILE_RANGE
  const pos = bot.entity?.position
  if (!pos) return []
  return Object.values(bot.entities || {})
    .filter(entity => entity?.isValid && HOSTILES.has(entity.name) && entity.position?.distanceTo(pos) <= range)
    .map(entity => ({
      name: entity.name,
      distance: Math.round(entity.position.distanceTo(pos) * 10) / 10
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10)
}

function scanVisibleBlocks (bot) {
  const pos = bot.entity?.position
  if (!pos || typeof bot.findBlocks !== 'function') return []
  return bot.findBlocks({
    matching: block => NOTABLE_BLOCKS.includes(block.name),
    maxDistance: VISIBLE_RANGE,
    count: 40
  })
    .map(blockPos => bot.blockAt(blockPos))
    .filter(Boolean)
    .map(block => ({
      name: block.name,
      distance: Math.round(pos.distanceTo(block.position) * 10) / 10
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20)
}

function summaryForPrompt (summary) {
  return JSON.stringify({
    currentGoal: summary.currentGoal,
    currentTask: summary.currentTask,
    shortTermTask: summary.shortTermTask,
    health: summary.health,
    food: summary.food,
    position: summary.position,
    dimension: summary.dimension,
    heldItem: summary.heldItem,
    inventory: summary.inventory,
    director: summary.director,
    hostileMobs: summary.hostileMobs.map(entry => `${entry.distance}m ${entry.name}`),
    adaptiveThreats: summary.adaptiveThreats.map(entry => `${entry.distance}m ${entry.name}${entry.ranged ? ' (ranged)' : ''}`),
    visibleBlocks: summary.visibleBlocks.map(entry => `${entry.distance}m ${entry.name}`),
    pvp: summary.combat?.pvp,
    protector: summary.combat?.protector,
    failedActions: summary.failedActions,
    recentDecisions: summary.recentDecisions,
    rewardLearning: summary.rewardLearning
  }, null, 2)
}

module.exports = {
  createWorldSummary,
  summaryForPrompt
}
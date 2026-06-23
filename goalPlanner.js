const { countInventory } = require('./inventory')

const DEFAULT_TARGETS = {
  diamonds: 256,
  iron: 512,
  food: 192,
  wood: 384,
  coal: 128,
  stone: 512
}

const DEFINITIONS = {
  diamonds: {
    label: 'Diamond Stockpile',
    items: { diamond: 1, diamond_block: 9, diamond_ore: 1, deepslate_diamond_ore: 1 },
    command: '!diamondMine 64',
    task: 'diamond branch mine',
    reason: 'diamonds are below the long-term stockpile target'
  },
  iron: {
    label: 'Iron Stockpile',
    items: { iron_ingot: 1, iron_block: 9, raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1 },
    command: '!smartMine iron 64',
    task: 'smart mine iron',
    reason: 'iron supports tools, armor, buckets, shields, and backup gear'
  },
  food: {
    label: 'Food Stockpile',
    items: {
      cooked_beef: 1,
      cooked_porkchop: 1,
      cooked_chicken: 1,
      cooked_mutton: 1,
      bread: 1,
      baked_potato: 1,
      carrot: 1,
      apple: 1,
      beef: 1,
      porkchop: 1,
      chicken: 1,
      mutton: 1,
      potato: 1,
      mushroom_stew: 1,
      sweet_berries: 1,
      golden_apple: 1
    },
    command: '!farm cows 12',
    task: 'secure food',
    reason: 'food is the first survival bottleneck'
  },
  wood: {
    label: 'Wood Stockpile',
    items: {
      oak_log: 1,
      spruce_log: 1,
      birch_log: 1,
      jungle_log: 1,
      acacia_log: 1,
      dark_oak_log: 1,
      mangrove_log: 1,
      cherry_log: 1,
      oak_planks: 1,
      spruce_planks: 1,
      birch_planks: 1,
      jungle_planks: 1,
      acacia_planks: 1,
      dark_oak_planks: 1,
      mangrove_planks: 1,
      cherry_planks: 1
    },
    command: '!getWood 64',
    task: 'gather wood',
    reason: 'wood feeds crafting, storage, shields, torches, and building'
  },
  coal: {
    label: 'Coal Stockpile',
    items: { coal: 1, charcoal: 1, coal_block: 9, coal_ore: 1, deepslate_coal_ore: 1 },
    command: '!smartMine coal 64',
    task: 'smart mine coal',
    reason: 'coal keeps torches and smelting available'
  },
  stone: {
    label: 'Stone Stockpile',
    items: {
      cobblestone: 1,
      stone: 1,
      deepslate: 1,
      cobbled_deepslate: 1,
      stone_bricks: 1,
      tuff: 1
    },
    command: '!getStone 128',
    task: 'gather stone',
    reason: 'stone is the base material for tools, furnaces, bridges, and builds'
  }
}

function createGoalPlanner (bot, memory, config, tasks) {
  return {
    status (options = {}) {
      return evaluateGoalPlan(bot, memory, config, tasks, options)
    }
  }
}

function evaluateGoalPlan (bot, memory, config, tasks, options = {}) {
  if (config.goalPlanner?.enabled === false) {
    return {
      enabled: false,
      currentGoal: null,
      currentTaskRecommendation: null,
      stockpiles: [],
      hierarchy: [],
      generatedAt: Date.now()
    }
  }

  const inventoryCounts = safeInventoryCounts(bot)
  const cachedStorageCounts = memoryStockpileCounts(memory)
  const counts = mergeCounts(inventoryCounts, cachedStorageCounts)
  const stockpiles = buildStockpileRows(counts, inventoryCounts, cachedStorageCounts, config)
  const prerequisites = buildPrerequisites(bot, counts)
  const currentTaskRecommendation = chooseRecommendation(stockpiles, prerequisites, bot, tasks, options)
  const currentGoal = currentTaskRecommendation
    ? {
        key: currentTaskRecommendation.goalKey || 'stabilize',
        label: currentTaskRecommendation.goalLabel || 'Stabilize Survival',
        reason: currentTaskRecommendation.reason
      }
    : {
        key: 'maintain',
        label: 'Maintain Stockpiles',
        reason: 'all configured stockpiles are currently satisfied'
      }

  return {
    enabled: true,
    currentGoal,
    currentTaskRecommendation,
    stockpiles,
    hierarchy: buildHierarchy(stockpiles, prerequisites, currentTaskRecommendation),
    prerequisites,
    currentTask: tasks?.currentTask || 'idle',
    stockpileScan: stockpileScanSummary(memory),
    lastRun: memory?.ai?.goalPlanner?.lastRun || null,
    sourceNote: Object.keys(cachedStorageCounts).length
      ? 'inventory plus cached storage memory'
      : 'live inventory only; chest stock levels are added after a supply scan',
    generatedAt: Date.now()
  }
}

function buildStockpileRows (counts, inventoryCounts, cachedStorageCounts, config) {
  return Object.entries(DEFINITIONS).map(([key, definition]) => {
    const target = targetFor(key, config)
    const inventory = weightedCount(inventoryCounts, definition.items)
    const cachedStorage = weightedCount(cachedStorageCounts, definition.items)
    const available = weightedCount(counts, definition.items)
    const missing = Math.max(0, target - available)
    return {
      key,
      label: definition.label,
      target,
      available,
      inventory,
      cachedStorage,
      missing,
      ok: missing <= 0,
      progress: target > 0 ? Math.min(1, available / target) : 1,
      command: definition.command,
      task: definition.task,
      reason: definition.reason
    }
  })
}

function buildPrerequisites (bot, counts) {
  const emptySlots = safeEmptySlots(bot)
  const hasAnyPickaxe = hasAny(counts, [
    'wooden_pickaxe',
    'stone_pickaxe',
    'iron_pickaxe',
    'diamond_pickaxe',
    'netherite_pickaxe'
  ])
  const hasIronOrBetterPickaxe = hasAny(counts, ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'])
  const food = weightedCount(counts, DEFINITIONS.food.items)
  const torches = (counts.torch || 0) + (counts.lantern || 0) + (counts.soul_torch || 0)

  return [
    {
      key: 'inventory_space',
      label: 'Inventory Space',
      ok: emptySlots >= 4,
      detail: emptySlots >= 4 ? `${emptySlots} empty slots` : `${emptySlots} empty slots; deposit junk first`,
      command: '!deposit',
      task: 'deposit inventory'
    },
    {
      key: 'basic_pickaxe',
      label: 'Any Pickaxe',
      ok: hasAnyPickaxe,
      detail: hasAnyPickaxe ? 'pickaxe available' : 'no pickaxe detected',
      command: '!getStone 24',
      task: 'craft or gather for pickaxe'
    },
    {
      key: 'diamond_pickaxe_gate',
      label: 'Iron+ Pickaxe',
      ok: hasIronOrBetterPickaxe,
      detail: hasIronOrBetterPickaxe ? 'diamond mining capable' : 'need iron, diamond, or netherite pickaxe before diamonds',
      command: '!smartMine iron 3',
      task: 'prepare iron pickaxe'
    },
    {
      key: 'mining_food',
      label: 'Mining Food',
      ok: food >= 8,
      detail: `${food} food items visible`,
      command: '!farm cows 8',
      task: 'secure trip food'
    },
    {
      key: 'mining_light',
      label: 'Mining Light',
      ok: torches >= 16 || (counts.coal || 0) + (counts.charcoal || 0) >= 8,
      detail: `${torches} torches, ${(counts.coal || 0) + (counts.charcoal || 0)} fuel`,
      command: '!smartMine coal 16',
      task: 'prepare torches'
    }
  ]
}

function chooseRecommendation (stockpiles, prerequisites, bot, tasks, options = {}) {
  if (!options.ignoreCurrentTask && tasks?.currentTask && tasks.currentTask !== 'idle') {
    return {
      goalKey: 'finish_current_task',
      goalLabel: 'Finish Current Task',
      task: tasks.currentTask,
      command: '!status',
      reason: `already working on ${tasks.currentTask}`,
      blockers: []
    }
  }

  if ((bot?.food ?? 20) <= 8) {
    return fromPrerequisite(prerequisites.find(step => step.key === 'mining_food'), 'food', 'Emergency Food')
  }

  const inventorySpace = prerequisites.find(step => step.key === 'inventory_space')
  if (inventorySpace && !inventorySpace.ok) return fromPrerequisite(inventorySpace, 'inventory', 'Make Inventory Space')

  const food = stockpiles.find(row => row.key === 'food')
  if (food && !food.ok) return fromStockpile(food)

  const wood = stockpiles.find(row => row.key === 'wood')
  if (wood && !wood.ok) return fromStockpile(wood)

  const basicPickaxe = prerequisites.find(step => step.key === 'basic_pickaxe')
  if (basicPickaxe && !basicPickaxe.ok) return fromPrerequisite(basicPickaxe, 'tools', 'Prepare Tools')

  const coal = stockpiles.find(row => row.key === 'coal')
  if (coal && !coal.ok) return fromStockpile(coal)

  const iron = stockpiles.find(row => row.key === 'iron')
  if (iron && !iron.ok) return fromStockpile(iron)

  const diamondGate = prerequisites.find(step => step.key === 'diamond_pickaxe_gate')
  const diamonds = stockpiles.find(row => row.key === 'diamonds')
  if (diamonds && !diamonds.ok && diamondGate && !diamondGate.ok) {
    return fromPrerequisite(diamondGate, 'diamonds', 'Prepare Diamond Mining')
  }
  if (diamonds && !diamonds.ok) return fromStockpile(diamonds)

  const stone = stockpiles.find(row => row.key === 'stone')
  if (stone && !stone.ok) return fromStockpile(stone)

  const missing = stockpiles
    .filter(row => !row.ok)
    .sort((a, b) => b.missing - a.missing)[0]
  return missing ? fromStockpile(missing) : null
}

function fromStockpile (row) {
  return {
    goalKey: row.key,
    goalLabel: row.label,
    task: row.task,
    command: row.command,
    reason: `${row.reason}; missing ${row.missing}`,
    blockers: []
  }
}

function fromPrerequisite (step, goalKey, goalLabel) {
  if (!step) return null
  return {
    goalKey,
    goalLabel,
    task: step.task,
    command: step.command,
    reason: step.detail,
    blockers: [step.label]
  }
}

function buildHierarchy (stockpiles, prerequisites, recommendation) {
  const diamonds = stockpiles.find(row => row.key === 'diamonds')
  const priorityGaps = stockpiles
    .filter(row => !row.ok)
    .sort((a, b) => b.missing - a.missing)
    .slice(0, 4)

  return [
    {
      level: 0,
      key: 'maintain_diamonds',
      label: `Maintain ${diamonds?.target || DEFAULT_TARGETS.diamonds} diamonds`,
      ok: Boolean(diamonds?.ok)
    },
    ...prerequisites.map(step => ({
      level: 1,
      key: step.key,
      label: step.label,
      ok: step.ok,
      detail: step.detail
    })),
    ...priorityGaps.map(row => ({
      level: 1,
      key: row.key,
      label: row.label,
      ok: row.ok,
      detail: `${row.available}/${row.target}, missing ${row.missing}`
    })),
    recommendation
      ? {
          level: 2,
          key: 'next_task',
          label: `Next: ${recommendation.task}`,
          ok: false,
          detail: recommendation.reason
        }
      : {
          level: 2,
          key: 'next_task',
          label: 'Next: patrol and maintain',
          ok: true,
          detail: 'no stockpile task is currently needed'
        }
  ]
}

function formatPlannerStatus (status) {
  if (!status?.enabled) return 'Planner is off.'
  const recommendation = status.currentTaskRecommendation
  const worst = status.stockpiles
    .filter(row => !row.ok)
    .sort((a, b) => b.missing - a.missing)
    .slice(0, 3)
    .map(row => `${row.key} -${row.missing}`)

  if (!recommendation) {
    return 'Planner: stockpiles look stable. Keep surviving.'
  }

  const gaps = worst.length ? ` Gaps: ${worst.join(', ')}.` : ''
  return `Planner: ${status.currentGoal.label}. Next ${recommendation.command} (${recommendation.reason}).${gaps}`
}

function targetFor (key, config) {
  const configured = config.goalPlanner?.stockpiles?.[key]
  const target = Number(configured ?? DEFAULT_TARGETS[key] ?? 0)
  return Number.isFinite(target) && target >= 0 ? Math.floor(target) : DEFAULT_TARGETS[key]
}

function safeInventoryCounts (bot) {
  if (!bot?.inventory) return {}
  try {
    return countInventory(bot)
  } catch {
    return {}
  }
}

function safeEmptySlots (bot) {
  if (!bot?.inventory?.emptySlotCount) return 0
  try {
    return bot.inventory.emptySlotCount()
  } catch {
    return 0
  }
}

function memoryStockpileCounts (memory) {
  return mergeCounts(
    memory?.stockpiles?.counts || {},
    memory?.ai?.goalPlanner?.stockpileCounts || {}
  )
}

function stockpileScanSummary (memory) {
  const stockpiles = memory?.stockpiles
  if (!stockpiles?.scannedAt) return null
  return {
    scannedAt: stockpiles.scannedAt,
    chestCount: Object.keys(stockpiles.byChest || {}).length,
    failures: stockpiles.failures || []
  }
}

function mergeCounts (...countMaps) {
  const result = {}
  for (const counts of countMaps) {
    for (const [name, count] of Object.entries(counts || {})) {
      const number = Number(count)
      if (Number.isFinite(number) && number > 0) result[name] = (result[name] || 0) + number
    }
  }
  return result
}

function weightedCount (counts, weights) {
  let total = 0
  for (const [name, weight] of Object.entries(weights)) total += (counts[name] || 0) * weight
  return total
}

function hasAny (counts, names) {
  return names.some(name => (counts[name] || 0) > 0)
}

module.exports = {
  createGoalPlanner,
  evaluateGoalPlan,
  formatPlannerStatus
}

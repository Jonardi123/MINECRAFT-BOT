const { Vec3 } = require('vec3')
const { goNear, sleep } = require('./navigation')

async function findCraftingTable (bot, signal) {
  const table = bot.findBlock({
    matching: block => block.name === 'crafting_table',
    maxDistance: 8
  })
  if (!table) return null
  await goNear(bot, table.position, 2, signal)
  return table
}

async function ensureCraftingTable (bot, signal) {
  const existing = await findCraftingTable(bot, signal).catch(() => null)
  if (existing) return existing

  if (!bot.inventory.items().some(item => item.name === 'crafting_table')) {
    await craftItemByName(bot, 'crafting_table', 1, signal).catch(() => false)
  }

  const tableItem = bot.inventory.items().find(item => item.name === 'crafting_table')
  if (!tableItem) return null

  await bot.equip(tableItem, 'hand')
  for (let attempt = 0; attempt < 4; attempt++) {
    const spot = findPlaceSpot(bot)
    if (!spot) {
      await nudge(bot)
      continue
    }

    await goNear(bot, spot.floor.position.offset(0, 1, 0), 3, signal, 3000).catch(() => {})
    await clearPlacementBlock(bot, spot.target)
    await clearPlacementBlock(bot, spot.target.offset(0, 1, 0))

    const floor = bot.blockAt(spot.floor.position)
    if (!floor) continue
    await bot.lookAt(floor.position.offset(0.5, 1.5, 0.5), true).catch(() => {})
    await bot.placeBlock(floor, new Vec3(0, 1, 0)).catch(() => null)

    const placed = bot.blockAt(spot.target)
    if (placed?.name === 'crafting_table') return placed
  }

  return null
}

async function craftItemByName (bot, itemName, count, signal) {
  const mcData = require('minecraft-data')(bot.version)
  const item = mcData.itemsByName[itemName]
  if (!item) return false

  let recipe = bot.recipesFor(item.id, null, count, null)[0]
  let table = null
  if (!recipe) {
    table = await findCraftingTable(bot, signal)
    if (!table) return false
    recipe = bot.recipesFor(item.id, null, count, table)[0]
  }
  if (recipe) {
    await bot.craft(recipe, craftApplications(recipe, count), table)
    return true
  }

  const fallbackRecipes = bot.recipesAll(item.id, null, table)
  for (const fallback of fallbackRecipes) {
    try {
      await bot.craft(fallback, craftApplications(fallback, count), table)
      return true
    } catch {}
  }

  return false
}

async function prepareWoodForCrafting (bot, signal) {
  const hasPlanks = bot.inventory.items().some(item => item.name.endsWith('_planks'))
  if (!hasPlanks) {
    const log = bot.inventory.items().find(item => item.name.endsWith('_log') || item.name.endsWith('_stem'))
    if (log) await craftItemByName(bot, log.name.replace(/_(log|stem)$/, '_planks'), 1, signal).catch(() => false)
  }

  const stickCount = bot.inventory.items()
    .filter(item => item.name === 'stick')
    .reduce((sum, item) => sum + item.count, 0)
  if (stickCount < 2) await craftItemByName(bot, 'stick', 1, signal).catch(() => false)
}

module.exports = {
  findCraftingTable,
  ensureCraftingTable,
  craftItemByName,
  prepareWoodForCrafting
}

function craftApplications (recipe, desiredCount) {
  return Math.max(1, Math.ceil((desiredCount || 1) / Math.max(1, recipe?.result?.count || 1)))
}

function findPlaceSpot (bot) {
  const base = bot.entity.position.floored()
  const offsets = []
  for (let radius = 1; radius <= 5; radius++) {
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) === radius) offsets.push([x, z])
      }
    }
  }

  for (const [x, z] of offsets) {
    const target = base.offset(x, 0, z)
    const floor = bot.blockAt(target.offset(0, -1, 0))
    const at = bot.blockAt(target)
    const above = bot.blockAt(target.offset(0, 1, 0))
    if (!floor || !at || !above) continue
    if (!canClear(at) || !canClear(above)) continue
    if (isAir(floor) || floor.name.includes('water') || floor.name.includes('lava')) continue
    return { floor, target }
  }
  return null
}

async function clearPlacementBlock (bot, pos) {
  const block = bot.blockAt(pos)
  if (!block || isAir(block)) return
  if (!canClear(block) || !block.diggable) return
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
  await bot.dig(block, true, 'raycast').catch(() => {})
}

async function nudge (bot) {
  bot.setControlState('back', true)
  bot.setControlState('jump', true)
  await sleep(250)
  bot.setControlState('back', false)
  bot.setControlState('jump', false)
}

function isAir (block) {
  return ['air', 'cave_air', 'void_air'].includes(block?.name)
}

function canClear (block) {
  if (!block) return false
  if (isAir(block) || block.boundingBox === 'empty') return true
  const name = block.name || ''
  return block.diggable && (
    name.includes('leaves') ||
    name.includes('grass') ||
    name.includes('fern') ||
    name.includes('vine') ||
    name.includes('snow') ||
    name.includes('mushroom') ||
    ['dead_bush', 'leaf_litter', 'dirt', 'grass_block'].includes(name)
  )
}

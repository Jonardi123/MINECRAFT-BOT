const { Vec3 } = require('vec3')
const { ensureCraftingTable, craftItemByName } = require('./crafting')
const { collectNearbyItems } = require('./collection')
const { assertNotCancelled, goNear, sleep } = require('./navigation')
const { setPosition, setChest, saveMemory } = require('./memory')
const { PALETTES, createBaseBlueprint, normalizeBaseVariant, normalizePaletteName } = require('./baseBlueprints')

const PLANK_BLOCKS = [
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
  'crimson_planks', 'warped_planks'
]

const STONE_BLOCKS = ['stone_bricks', 'cobblestone', 'cobbled_deepslate', 'stone', 'dirt']
const BUILD_BLOCKS = [...STONE_BLOCKS, ...PLANK_BLOCKS]

async function buildStarterCamp (bot, memory, config, speaker, signal) {
  setPosition(memory, 'botBase', bot.entity.position)
  if (!memory.home) setPosition(memory, 'home', bot.entity.position)

  const table = await ensureCraftingTable(bot, signal)
  if (!table) throw new Error('I could not place or find a crafting table.')

  await craftItemByName(bot, 'chest', 1, signal).catch(() => false)
  const chestPos = await placeInventoryBlock(bot, ['chest'], signal).catch(() => null)
  if (chestPos) {
    setChest(memory, 'botStorage', chestPos)
    if (!memory.chests?.storage) setChest(memory, 'storage', chestPos)
  }

  await placeTorchIfPossible(bot, signal).catch(() => false)
  saveMemory(memory)
  speaker.say('Starter camp set.', true)
}

async function buildEmergencyShelter (bot, memory, config, speaker, signal) {
  if (bot.health < 8 && !hasEmergencyFood(bot)) throw new Error('I need food or more health before building a shelter.')
  if ((bot.food ?? 20) < 6 && !hasEmergencyFood(bot)) throw new Error('I need food before building a shelter.')
  const origin = bot.entity.position.floored()
  const block = pickBuildBlock(bot)
  if (!block) throw new Error('I need dirt, cobble, stone, or planks to build a shelter.')

  speaker.say('Building shelter.', true)
  const positions = shelterPositions(origin)
  let placed = 0
  for (const pos of positions) {
    assertNotCancelled(signal)
    if (!pickBuildBlock(bot)) break
    const ok = await placeBlockAt(bot, pos, signal).catch(() => false)
    if (ok) placed++
    if (placed % 5 === 0) await collectNearbyItems(bot, config, signal, { radius: 4, attempts: 1, waitMs: 50 }).catch(() => {})
  }

  await placeTorchIfPossible(bot, signal).catch(() => false)
  if (placed < 8) throw new Error(`Shelter only placed ${placed} blocks.`)
  speaker.say(`Shelter placed ${placed} blocks.`, true)
}

async function buildBase (bot, memory, config, speaker, signal, options = {}) {
  const variant = normalizeBaseVariant(options.variant)
  const blueprint = createBaseBlueprint(variant)
  const requestedPalette = normalizePaletteName(options.palette)

  if (bot.health < 8 && !hasEmergencyFood(bot)) throw new Error('I need food or more health before building a base.')
  if ((bot.food ?? 20) < 6 && !hasEmergencyFood(bot)) throw new Error('I need food before building a base.')

  speaker.say('Checking build area and materials.', true)
  const materialPlan = chooseMaterialPlan(bot, blueprint, requestedPalette)
  if (materialPlan.missingTotal > 0) {
    throw new Error(`Missing for ${blueprint.label} (${materialPlan.palette.label}): ${formatMissing(materialPlan.missing)}.`)
  }

  const origin = await findFlatBuildSite(bot, options.player, blueprint, signal)
  if (!origin) {
    throw new Error(`I refused to build here: ${describeBuildSiteFailure(bot, options.player, blueprint)}.`)
  }

  await goNear(bot, origin, 3, signal, 6000).catch(() => {})
  await clearBuildArea(bot, origin, blueprint, signal)

  setPosition(memory, 'botBase', origin)
  if (!memory.home) setPosition(memory, 'home', origin)

  speaker.say(`Building ${blueprint.label} with ${materialPlan.palette.label}.`, true)
  let placed = 0
  let failed = 0
  const failedRoles = {}
  for (const step of blueprint.steps) {
    assertNotCancelled(signal)
    const ok = await placeBlueprintStep(bot, origin, step, materialPlan.palette, signal).catch(err => {
      console.error(`[build:${step.role}] ${err.message}`)
      return false
    })
    if (ok) {
      placed++
      if (step.role === 'chest') {
        const pos = origin.offset(step.x, step.y, step.z)
        setChest(memory, 'botStorage', pos)
        if (!memory.chests?.storage) setChest(memory, 'storage', pos)
      }
    } else {
      failed++
      failedRoles[step.role] = (failedRoles[step.role] || 0) + 1
    }
    if (placed > 0 && placed % 16 === 0) {
      await collectNearbyItems(bot, config, signal, { radius: 5, attempts: 1, waitMs: 50 }).catch(() => {})
    }
  }

  saveMemory(memory)
  const minimum = Math.max(20, Math.floor(blueprint.steps.length * 0.55))
  if (placed < minimum) throw new Error(`Base only placed ${placed}/${blueprint.steps.length} blueprint blocks.`)
  const failText = failed ? ` Skipped ${failed} placements (${formatRoleCounts(failedRoles)}).` : ''
  speaker.say(`${blueprint.label} placed ${placed} blocks.${failText}`, true)
}

async function buildFancyBase (bot, memory, config, speaker, signal, options = {}) {
  return buildBase(bot, memory, config, speaker, signal, { ...options, variant: 'fancy' })
}

async function placeInventoryBlock (bot, itemNames, signal) {
  const item = bot.inventory.items().find(inv => itemNames.includes(inv.name))
  if (!item) return null
  await bot.equip(item, 'hand')
  const base = bot.entity.position.floored()
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2]]) {
    const pos = base.offset(x, 0, z)
    const floor = bot.blockAt(pos.offset(0, -1, 0))
    const at = bot.blockAt(pos)
    const above = bot.blockAt(pos.offset(0, 1, 0))
    if (!floor || !at || !above || !isAir(at) || !isAir(above) || isAir(floor)) continue
    await bot.lookAt(floor.position.offset(0.5, 1.5, 0.5), true).catch(() => {})
    await bot.placeBlock(floor, new Vec3(0, 1, 0)).catch(() => null)
    const placed = bot.blockAt(pos)
    if (placed && itemNames.includes(placed.name)) return pos
  }
  return null
}

async function placeBlockAt (bot, pos, signal, preferredBlocks = null, options = {}) {
  assertNotCancelled(signal)
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 5.4) {
    const feet = bot.entity.position.floored()
    await goNear(bot, new Vec3(pos.x, feet.y, pos.z), 4, signal, 3000).catch(() => {})
  }

  let at = bot.blockAt(pos)
  if (!at) return false
  if (!isAir(at)) {
    if (!await clearPlacementBlock(bot, at, signal, options)) return false
    at = bot.blockAt(pos)
    if (!at || !isAir(at)) return false
  }

  const support = findSupport(bot, pos)
  if (!support) return false
  const item = pickBuildBlock(bot, preferredBlocks, options.allowFallback !== false)
  if (!item) return false
  await bot.equip(item, 'hand')
  await bot.lookAt(support.block.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
  await bot.placeBlock(support.block, support.face).catch(() => null)
  await sleep(80)
  const placed = bot.blockAt(pos)
  return Boolean(placed && !isAir(placed))
}

function chooseMaterialPlan (bot, blueprint, requestedPalette) {
  const paletteEntries = requestedPalette
    ? [[requestedPalette, PALETTES[requestedPalette]]].filter(([, palette]) => palette)
    : Object.entries(PALETTES)

  let best = null
  for (const [name, palette] of paletteEntries) {
    const analysis = analyzePalette(bot, blueprint, palette)
    const score = analysis.missingTotal
    if (!best || score < best.missingTotal) best = { name, palette, ...analysis }
  }

  if (!best) {
    const fallback = Object.entries(PALETTES)[0]
    best = { name: fallback[0], palette: fallback[1], ...analyzePalette(bot, blueprint, fallback[1]) }
  }
  return best
}

function analyzePalette (bot, blueprint, palette) {
  const inventory = inventoryCounts(bot)
  const missing = {}
  let missingTotal = 0

  for (const step of blueprint.steps) {
    const names = paletteItems(palette, step.role)
    const found = names.find(name => (inventory[name] || 0) > 0)
    if (found) {
      inventory[found]--
      continue
    }
    const missingName = names[0] || step.role
    missing[missingName] = (missing[missingName] || 0) + 1
    missingTotal++
  }

  return { missing, missingTotal }
}

function inventoryCounts (bot) {
  return bot.inventory.items().reduce((counts, item) => {
    counts[item.name] = (counts[item.name] || 0) + item.count
    return counts
  }, {})
}

function formatMissing (missing) {
  return Object.entries(missing)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')
}

async function findFlatBuildSite (bot, player, blueprint, signal) {
  const anchor = (player?.position || bot.entity.position).floored()
  const maxRadius = Math.max(10, Math.max(Math.abs(blueprint.bounds.minX), Math.abs(blueprint.bounds.maxX), Math.abs(blueprint.bounds.minZ), Math.abs(blueprint.bounds.maxZ)) + 8)
  const offsets = siteOffsets(maxRadius)

  for (const [x, z] of offsets) {
    assertNotCancelled(signal)
    for (const y of [anchor.y, anchor.y + 1, anchor.y - 1]) {
      const origin = new Vec3(anchor.x + x, y, anchor.z + z)
      if (isFlatSafeSite(bot, origin, blueprint)) return origin
    }
  }
  return null
}

function siteOffsets (maxRadius) {
  const offsets = []
  const start = 4
  for (let radius = start; radius <= maxRadius; radius++) {
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue
        offsets.push([x, z])
      }
    }
  }
  offsets.push([0, 0])
  return offsets
}

function isFlatSafeSite (bot, origin, blueprint) {
  for (let x = blueprint.bounds.minX - 1; x <= blueprint.bounds.maxX + 1; x++) {
    for (let z = blueprint.bounds.minZ - 1; z <= blueprint.bounds.maxZ + 1; z++) {
      const floor = bot.blockAt(origin.offset(x, -1, z))
      const belowFloor = bot.blockAt(origin.offset(x, -2, z))
      if (!isSolidSupport(floor) || isLiquid(floor) || !isSolidSupport(belowFloor) || isLiquid(belowFloor)) return false

      for (let y = 0; y <= blueprint.bounds.maxY; y++) {
        const block = bot.blockAt(origin.offset(x, y, z))
        if (!block) return false
        if (isLiquid(block)) return false
        if (!isAir(block) && !canClearForBuild(block)) return false
      }
    }
  }
  return true
}

function describeBuildSiteFailure (bot, player, blueprint) {
  const anchor = (player?.position || bot.entity.position).floored()
  const checks = {
    liquid: 0,
    holes: 0,
    solidObstruction: 0,
    softObstruction: 0,
    unknown: 0
  }
  const radius = Math.max(6, Math.min(12, Math.max(Math.abs(blueprint.bounds.minX), Math.abs(blueprint.bounds.maxX), Math.abs(blueprint.bounds.minZ), Math.abs(blueprint.bounds.maxZ))))
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const floor = bot.blockAt(anchor.offset(x, -1, z))
      const at = bot.blockAt(anchor.offset(x, 0, z))
      if (!floor || !at) {
        checks.unknown++
        continue
      }
      if (isLiquid(floor) || isLiquid(at)) checks.liquid++
      else if (!isSolidSupport(floor)) checks.holes++
      else if (!isAir(at) && canClearForBuild(at)) checks.softObstruction++
      else if (!isAir(at)) checks.solidObstruction++
    }
  }
  const reason = Object.entries(checks).sort((a, b) => b[1] - a[1]).find(([, count]) => count > 0)
  if (!reason) return 'no flat safe footprint nearby'
  const labels = {
    liquid: 'water or lava is in the footprint',
    holes: 'the ground has holes or cliffs',
    solidObstruction: 'solid blocks are blocking the footprint',
    softObstruction: 'too much grass/leaves need clearing',
    unknown: 'part of the area is not loaded'
  }
  return labels[reason[0]]
}

async function clearBuildArea (bot, origin, blueprint, signal) {
  for (let y = 0; y <= blueprint.bounds.maxY; y++) {
    for (let z = blueprint.bounds.minZ - 1; z <= blueprint.bounds.maxZ + 1; z++) {
      for (let x = blueprint.bounds.minX - 1; x <= blueprint.bounds.maxX + 1; x++) {
        assertNotCancelled(signal)
        const block = bot.blockAt(origin.offset(x, y, z))
        if (!block || isAir(block)) continue
        if (isLiquid(block)) throw new Error(`Build area has ${block.name} at ${block.position.x} ${block.position.y} ${block.position.z}.`)
        if (canClearForBuild(block)) await clearSoftBlock(bot, block, signal)
      }
    }
  }
}

async function placeBlueprintStep (bot, origin, step, palette, signal) {
  const pos = origin.offset(step.x, step.y, step.z)
  return placeBlockAt(bot, pos, signal, paletteItems(palette, step.role), {
    allowFallback: false,
    clearSoft: true,
    clearFloor: ['floor', 'path', 'farm'].includes(step.role)
  })
}

function paletteItems (palette, role) {
  return palette.roles[role] || BUILD_BLOCKS
}

function shelterPositions (origin) {
  const positions = []
  for (let y = 0; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        const wall = Math.abs(x) === 2 || Math.abs(z) === 2
        const roof = y === 2
        const doorway = z === -2 && x === 0 && y < 2
        if ((wall || roof) && !doorway) positions.push(origin.offset(x, y, z))
      }
    }
  }
  return positions
}

function findSupport (bot, pos) {
  const checks = [
    [new Vec3(0, -1, 0), new Vec3(0, 1, 0)],
    [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)],
    [new Vec3(-1, 0, 0), new Vec3(1, 0, 0)],
    [new Vec3(0, 0, 1), new Vec3(0, 0, -1)],
    [new Vec3(0, 0, -1), new Vec3(0, 0, 1)]
  ]
  for (const [offset, face] of checks) {
    const block = bot.blockAt(pos.plus(offset))
    if (isSolidSupport(block)) return { block, face }
  }
  return null
}

async function clearPlacementBlock (bot, block, signal, options = {}) {
  if (!block || isAir(block)) return true
  if (isLiquid(block)) return false
  if (options.clearFloor && canReplaceFloorBlock(block)) return clearBlock(bot, block, signal)
  if (options.clearSoft && canClearForBuild(block)) return clearBlock(bot, block, signal)
  return false
}

async function clearSoftBlock (bot, block, signal) {
  if (!canClearForBuild(block)) return false
  return clearBlock(bot, block, signal)
}

async function clearBlock (bot, block, signal) {
  await goNear(bot, block.position, 4, signal, 3000).catch(() => {})
  await bot.dig(block, true).catch(() => null)
  await sleep(80)
  const after = bot.blockAt(block.position)
  return Boolean(after && isAir(after))
}

async function placeTorchIfPossible (bot, signal) {
  const torch = bot.inventory.items().find(item => item.name === 'torch')
  if (!torch) return false
  await bot.equip(torch, 'hand')
  const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!floor || isAir(floor)) return false
  await bot.placeBlock(floor, new Vec3(0, 1, 0))
  return true
}

function pickBuildBlock (bot, preferredBlocks = null, allowFallback = true) {
  const inventory = bot.inventory.items()
  if (preferredBlocks?.length) {
    for (const name of preferredBlocks) {
      const preferred = inventory.find(item => item.name === name)
      if (preferred) return preferred
    }
    if (!allowFallback) return null
  }
  return inventory.find(item => BUILD_BLOCKS.includes(item.name))
}

function hasEmergencyFood (bot) {
  const foods = new Set([
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
    'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton',
    'potato', 'rotten_flesh', 'spider_eye'
  ])
  return bot.inventory.items().some(item => foods.has(item.name))
}

function isAir (block) {
  return ['air', 'cave_air', 'void_air'].includes(block?.name)
}

function isLiquid (block) {
  const name = block?.name || ''
  return name.includes('water') || name.includes('lava')
}

function isSolidSupport (block) {
  return Boolean(block && !isAir(block) && block.boundingBox !== 'empty' && !isLiquid(block))
}

function canClearForBuild (block) {
  if (!block || isAir(block)) return true
  const name = block.name || ''
  return block.diggable && (
    block.boundingBox === 'empty' ||
    name.includes('leaves') ||
    name.includes('mushroom') ||
    [
      'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'leaf_litter', 'snow',
      'vine', 'cave_vines', 'weeping_vines', 'twisting_vines'
    ].includes(name)
  )
}

function canReplaceFloorBlock (block) {
  if (!block || isAir(block) || isLiquid(block)) return false
  const name = block.name || ''
  return block.diggable && [
    'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'sand', 'red_sand',
    'gravel', 'stone', 'cobblestone', 'cobbled_deepslate'
  ].includes(name)
}

function formatRoleCounts (counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([role, count]) => `${count} ${role}`)
    .join(', ')
}

function key (x, y, z) {
  return `${x},${y},${z}`
}

module.exports = {
  buildStarterCamp,
  buildEmergencyShelter,
  buildBase,
  buildFancyBase
}

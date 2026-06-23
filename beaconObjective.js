const { Vec3 } = require('vec3')
const { countInventory } = require('./inventory')
const { countChestItems, depositInventory, withdrawMatching } = require('./chest')
const { craftItemByName, ensureCraftingTable } = require('./crafting')
const { ensurePickaxe, equipBestArmorFromInventory } = require('./equipment')
const { gatherStarterFood, gatherStarterStone, craftStarterKit, gatherWood } = require('./survival')
const { smartMineResource, branchMineForResource, mineBlocks, prospectMine } = require('./mining')
const { goNear, sleep, assertNotCancelled } = require('./navigation')
const { saveMemory, positionToJson } = require('./memory')
const { smeltInventoryItem } = require('./domestic')
const { hostileNearby } = require('./safety')

const REQUIRED_DIAMOND_BLOCKS = 164
const REQUIRED_DIAMONDS = REQUIRED_DIAMOND_BLOCKS * 9
const BEACON_RECIPE = {
  glass: 5,
  obsidian: 3,
  nether_star: 1
}

const PLANK_OR_LOG_NAMES = [
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'crimson_stem', 'warped_stem', 'crimson_planks', 'warped_planks'
]

async function runDiamondBeaconObjective (bot, memory, config, speaker, signal, options = {}) {
  const state = ensureBeaconMemory(memory)
  state.mode = 'running'
  state.startedAt = state.startedAt || new Date().toISOString()
  state.lastRunAt = new Date().toISOString()
  saveMemory(memory)

  const endAt = options.minutes ? Date.now() + options.minutes * 60000 : Infinity
  speaker.say('Diamond beacon objective started.', true)

  while (!signal.cancelled && Date.now() < endAt) {
    const counts = await countAllResources(bot, memory, config, signal)
    updateProgress(state, counts)
    saveMemory(memory)

    if (diamondBlockPotential(counts) < REQUIRED_DIAMOND_BLOCKS) {
      await acquireDiamonds(bot, memory, config, speaker, signal, counts)
      continue
    }

    await craftDiamondBlocks(bot, memory, config, speaker, signal)
    const afterBlocks = await countAllResources(bot, memory, config, signal)
    updateProgress(state, afterBlocks)
    saveMemory(memory)

    if (!hasBeaconMaterials(afterBlocks)) {
      await acquireBeaconMaterials(bot, memory, config, speaker, signal, afterBlocks)
      continue
    }

    if (!hasBeaconItem(afterBlocks)) {
      await craftBeacon(bot, memory, config, speaker, signal)
      continue
    }

    if (!state.site) {
      state.phase = 'waiting_for_beacon_site'
      state.blockedReason = 'No beacon site saved. Use !setBeaconSite near base when ready.'
      saveMemory(memory)
      speaker.say('Diamond supply ready. Use !setBeaconSite when you want me to build it.', true)
      return
    }

    await buildBeaconPyramid(bot, memory, config, speaker, signal)
    const verified = verifyBeaconPyramid(bot, state.site)
    state.phase = verified ? 'complete' : 'build_incomplete'
    state.verifiedComplete = verified
    state.completedAt = verified ? new Date().toISOString() : null
    saveMemory(memory)
    speaker.say(verified ? 'Diamond beacon verified complete.' : 'Beacon build stopped before verification.', true)
    return
  }

  const counts = await countAllResources(bot, memory, config, signal).catch(() => countInventory(bot))
  updateProgress(ensureBeaconMemory(memory), counts)
  saveMemory(memory)
  speaker.say(beaconStatus(memory), true)
}

function setBeaconSite (bot, memory) {
  const state = ensureBeaconMemory(memory)
  state.site = positionToJson(bot.entity.position.floored())
  state.phase = state.phase || 'site_saved'
  state.updatedAt = new Date().toISOString()
  saveMemory(memory)
  return state.site
}

function beaconStatus (memory) {
  const state = ensureBeaconMemory(memory)
  const progress = state.progress || {}
  const diamonds = progress.equivalentDiamonds || 0
  const blocks = progress.diamondBlocks || 0
  const missingDiamonds = Math.max(0, REQUIRED_DIAMONDS - diamonds)
  const phase = state.phase || 'not_started'
  const site = state.site ? `site ${state.site.x} ${state.site.y} ${state.site.z}` : 'no site'
  const materials = progress.beaconMaterials || {}
  const blocked = state.blockedReason ? ` Blocked: ${state.blockedReason}` : ''
  return `Beacon ${phase}: ${blocks}/${REQUIRED_DIAMOND_BLOCKS} diamond blocks, need ${missingDiamonds} diamonds, glass ${materials.glass || 0}/5, obsidian ${materials.obsidian || 0}/3, star ${materials.nether_star || 0}/1, ${site}.${blocked}`
}

async function acquireDiamonds (bot, memory, config, speaker, signal, counts) {
  const state = ensureBeaconMemory(memory)
  state.phase = 'mining_diamonds'
  state.blockedReason = null
  saveMemory(memory)

  await ensureDiamondMiningPrep(bot, memory, config, speaker, signal)

  const before = countDiamondEquivalent(counts)
  const missing = Math.max(0, REQUIRED_DIAMONDS - before)
  const batch = Math.min(Math.max(1, Math.ceil(missing / 9)), config.beaconObjective?.diamondBatch || 8)
  speaker.say(`Beacon diamonds: ${before}/${REQUIRED_DIAMONDS}. Mining ${batch}.`, true)

  await branchMineForResource(bot, memory, config, speaker, 'diamond', batch, signal)
  await depositInventory(bot, memory, config, 'storage', signal, item => isValuableForBeacon(item.name)).catch(() => {})

  const after = await countAllResources(bot, memory, config, signal)
  updateProgress(state, after)
  const gained = countDiamondEquivalent(after) - before
  state.lastDiamondGain = gained
  state.lastMilestoneAt = new Date().toISOString()
  saveMemory(memory)
  speaker.say(`Beacon diamond progress: ${countDiamondEquivalent(after)}/${REQUIRED_DIAMONDS}.`, true)
  if (gained <= 0) {
    state.blockedReason = 'Diamond batch made no verified diamond progress.'
    saveMemory(memory)
  }
}

async function ensureDiamondMiningPrep (bot, memory, config, speaker, signal) {
  await prepareBeaconInventory(bot, memory, config, signal).catch(() => {})
  await moveToBeaconWorksite(bot, memory, config, signal).catch(() => {})
  await waitForMiningSafety(bot, config, signal).catch(() => {})
  await stabilizeFoodAndHealth(bot, memory, config, speaker, signal)
  if ((bot.food ?? 20) < 16 && foodItem(bot)) await eatFood(bot)
  if ((bot.food ?? 20) < (config.director?.minFoodBeforeMining || 8) && !foodItem(bot)) {
    await gatherStarterFood(bot, memory, config, speaker, signal).catch(() => {})
  }
  if ((bot.food ?? 20) < (config.director?.minFoodBeforeMining || 8) && !foodItem(bot)) {
    throw new Error('Need food before beacon diamond mining.')
  }
  if ((bot.food ?? 20) < 16 && foodItem(bot)) await eatFood(bot).catch(() => {})

  await ensureIronOrBetterPickaxe(bot, memory, config, speaker, signal)
  await equipBestArmorFromInventory(bot, config).catch(() => {})
  await waitForBeaconDaylight(bot, memory, config, signal)
}

async function waitForBeaconDaylight (bot, memory, config, signal) {
  if (!isDangerousNight(bot)) return
  if (bot.health >= 18 && (bot.food ?? 20) >= 18 && hasGoodWeapon(bot)) return
  const state = ensureBeaconMemory(memory)
  state.phase = 'waiting_for_daylight'
  state.blockedReason = 'Waiting for safer daylight before resource gathering.'
  saveMemory(memory)
  const endAt = Date.now() + (config.beaconObjective?.nightWaitMs || 60000)
  while (!signal.cancelled && isDangerousNight(bot) && Date.now() < endAt) {
    await sleep(1000)
  }
  if (isDangerousNight(bot)) throw new Error('Waiting for daylight before beacon resource gathering.')
}

async function stabilizeFoodAndHealth (bot, memory, config, speaker, signal) {
  const state = ensureBeaconMemory(memory)
  if ((bot.food ?? 20) < 18 || bot.health < 16) {
    if (foodItem(bot)) await eatFood(bot).catch(() => {})
    if (!foodItem(bot) || (bot.food ?? 20) < 16) {
      state.phase = 'food_stability'
      state.blockedReason = 'Getting food/health stable before beacon mining.'
      saveMemory(memory)
      await gatherStarterFood(bot, memory, config, speaker, signal).catch(() => {})
    }
    if (foodItem(bot) && (bot.food ?? 20) < 18) await eatFood(bot).catch(() => {})
  }

  if (bot.health < 10 && !foodItem(bot)) {
    state.phase = 'food_stability'
    state.blockedReason = 'Need food and recovery before safe mining.'
    saveMemory(memory)
    throw new Error('Need food and health before beacon mining.')
  }

  if ((bot.food ?? 20) < (config.beaconObjective?.stableFood || 16) || bot.health < (config.beaconObjective?.stableHealth || 14)) {
    state.phase = 'food_stability'
    state.blockedReason = 'Food/health not stable enough for beacon mining yet.'
    saveMemory(memory)
    throw new Error('Need stable food and health before beacon mining.')
  }
}

async function ensureIronOrBetterPickaxe (bot, memory, config, speaker, signal) {
  const state = ensureBeaconMemory(memory)
  state.phase = 'preparing_iron_pickaxe'
  state.blockedReason = null
  saveMemory(memory)

  const existing = bot.inventory.items().find(item => ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'].includes(item.name))
  if (existing) {
    await bot.equip(existing, 'hand')
    return existing
  }

  await withdrawFromSavedChests(bot, memory, config, ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'], 1, signal)
  const withdrawn = bot.inventory.items().find(item => ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'].includes(item.name))
  if (withdrawn) {
    await bot.equip(withdrawn, 'hand')
    return withdrawn
  }

  await withdrawFromSavedChests(bot, memory, config, ['iron_ingot'], 3, signal)
  await smeltIronIfPossible(bot, signal).catch(() => {})
  const craftedFromStoredIron = await craftIronPickaxeFromInventory(bot, signal)
  if (craftedFromStoredIron) return craftedFromStoredIron

  speaker.say('Need iron pickaxe for diamonds. Getting stone and iron first.', true)
  await ensureStonePickaxeForIron(bot, memory, config, speaker, signal)
  await acquireStarterIron(bot, memory, config, speaker, signal)
  await withdrawFromSavedChests(bot, memory, config, ['raw_iron', 'iron_ore', 'deepslate_iron_ore'], 3, signal)
  await withdrawFromSavedChests(bot, memory, config, ['coal', 'charcoal'], 3, signal)
  if (!hasSmeltingFuel(bot)) await withdrawFromSavedChests(bot, memory, config, PLANK_OR_LOG_NAMES, 4, signal)

  await smeltIronIfPossible(bot, signal).catch(err => {
    state.blockedReason = `Iron smelting blocked: ${err.message}`
  })

  await withdrawFromSavedChests(bot, memory, config, ['iron_ingot'], 3, signal)
  const pickaxe = await craftIronPickaxeFromInventory(bot, signal)
  if (pickaxe) {
    state.blockedReason = null
    saveMemory(memory)
    return pickaxe
  }
  state.blockedReason = 'Need iron ingots for an iron pickaxe before diamond mining.'
  saveMemory(memory)
  throw new Error('Need an iron pickaxe before mining diamonds.')
}

async function ensureStonePickaxeForIron (bot, memory, config, speaker, signal) {
  const goodPickaxe = bot.inventory.items().find(item => ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(item.name))
  if (goodPickaxe) {
    await bot.equip(goodPickaxe, 'hand')
    return goodPickaxe
  }

  await withdrawFromSavedChests(bot, memory, config, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'], 1, signal)
  const stored = bot.inventory.items().find(item => ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(item.name))
  if (stored) {
    await bot.equip(stored, 'hand')
    return stored
  }

  await withdrawFromSavedChests(bot, memory, config, ['cobblestone', 'cobbled_deepslate'], 3, signal)
  await withdrawFromSavedChests(bot, memory, config, ['stick'], 2, signal)
  await withdrawFromSavedChests(bot, memory, config, PLANK_OR_LOG_NAMES, 8, signal)
  await clearBeaconJunkIfNeeded(bot, signal)

  if (woodValue(bot) < 8) await gatherWood(bot, config, speaker, signal, 4).catch(() => {})
  await clearBeaconJunkIfNeeded(bot, signal)
  await craftStarterKit(bot, memory, config, speaker, signal).catch(() => {})
  await ensurePickaxe(bot, memory, config, speaker, signal).catch(() => {})
  if ((countInventory(bot).cobblestone || 0) + (countInventory(bot).cobbled_deepslate || 0) < 3) {
    await gatherStarterStone(bot, memory, config, speaker, signal, 3)
  }
  await ensureCraftingTable(bot, signal).catch(() => null)
  await craftItemByName(bot, 'stone_pickaxe', 1, signal).catch(() => false)

  const crafted = bot.inventory.items().find(item => ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(item.name))
  if (!crafted) throw new Error('Need a stone pickaxe before mining iron.')
  await bot.equip(crafted, 'hand')
  return crafted
}

async function acquireStarterIron (bot, memory, config, speaker, signal) {
  await moveToBeaconWorksite(bot, memory, config, signal).catch(() => {})
  await waitForMiningSafety(bot, config, signal).catch(() => {})
  await ensureStonePickaxeForIron(bot, memory, config, speaker, signal)
  const before = ironProgress(bot)
  if (before >= 3) return before

  await mineBlocks(bot, memory, config, speaker, 'iron_ore', 3 - before, signal).catch(() => {})
  if (ironProgress(bot) >= 3) return ironProgress(bot)

  await prospectMine(bot, memory, config, speaker, 'iron_ore', 3 - ironProgress(bot), signal, config.mining?.prospectHardLimit || 512).catch(() => {})
  if (ironProgress(bot) >= 3) return ironProgress(bot)

  await smartMineResource(bot, memory, config, speaker, 'iron', 3 - ironProgress(bot), signal).catch(() => {})
  return ironProgress(bot)
}

async function moveToBeaconWorksite (bot, memory, config, signal) {
  const saved = memory.botBase || memory.chests?.storage || memory.chests?.botStorage || memory.home
  if (!saved) return
  const pos = new Vec3(saved.x, saved.y, saved.z)
  if (bot.entity.position.distanceTo(pos) <= 14 && !hostileNearby(bot, config.dispatcher?.hostileRange || 9, config, memory)) return
  await goNear(bot, pos, 5, signal, config.behavior?.pathTimeoutMs || 6000)
}

async function waitForMiningSafety (bot, config, signal) {
  const started = Date.now()
  const maxWait = config.beaconObjective?.safetyWaitMs || 15000
  while (!signal.cancelled && hostileNearby(bot, config.dispatcher?.hostileRange || 9, config, memory) && Date.now() - started < maxWait) {
    bot.pathfinder?.stop()
    await sleep(500)
  }
}

async function craftIronPickaxeFromInventory (bot, signal) {
  if ((countInventory(bot).iron_ingot || 0) < 3) return null
  await ensureCraftingTable(bot, signal)
  await craftItemByName(bot, 'iron_pickaxe', 1, signal).catch(() => false)
  const crafted = bot.inventory.items().find(item => item.name === 'iron_pickaxe')
  if (!crafted) return null
  await bot.equip(crafted, 'hand')
  return crafted
}

async function smeltIronIfPossible (bot, signal) {
  const counts = countInventory(bot)
  if ((counts.iron_ingot || 0) >= 3) return counts.iron_ingot
  const fuelNames = [
    'coal', 'charcoal',
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'pale_oak_log'
  ]
  if (counts.raw_iron) await smeltInventoryItem(bot, 'raw_iron', fuelNames, Math.min(3, counts.raw_iron), signal)
  if (countInventory(bot).iron_ore) await smeltInventoryItem(bot, 'iron_ore', fuelNames, Math.min(3, countInventory(bot).iron_ore), signal)
  if (countInventory(bot).deepslate_iron_ore) await smeltInventoryItem(bot, 'deepslate_iron_ore', fuelNames, Math.min(3, countInventory(bot).deepslate_iron_ore), signal)
  return countInventory(bot).iron_ingot || 0
}

async function prepareBeaconInventory (bot, memory, config, signal) {
  const keep = new Set([
    'diamond', 'diamond_block', 'glass', 'obsidian', 'nether_star', 'beacon',
    'iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore',
    'coal', 'charcoal', 'torch', 'shield',
    'cobblestone', 'cobbled_deepslate', 'dirt', 'stone',
    'stick', 'crafting_table', 'furnace',
    ...PLANK_OR_LOG_NAMES
  ])
  const isLoadout = item => {
    if (keep.has(item.name)) return true
    if (item.name.endsWith('_pickaxe') || item.name.endsWith('_axe') || item.name.endsWith('_sword')) return true
    if (item.name.endsWith('_helmet') || item.name.endsWith('_chestplate') || item.name.endsWith('_leggings') || item.name.endsWith('_boots')) return true
    return foodNames().includes(item.name)
  }
  await depositInventory(bot, memory, config, 'botStorage', signal, item => !isLoadout(item)).catch(() => {})
  await depositInventory(bot, memory, config, 'storage', signal, item => !isLoadout(item)).catch(() => {})
  await clearBeaconJunkIfNeeded(bot, signal)
}

async function withdrawFromSavedChests (bot, memory, config, names, count, signal) {
  let remaining = count
  for (const kind of ['botStorage', 'storage']) {
    if (remaining <= 0) break
    const got = await withdrawMatching(bot, memory, config, kind, names, remaining, signal).catch(() => 0)
    remaining -= got || 0
  }
  return count - remaining
}

function ironProgress (bot) {
  const counts = countInventory(bot)
  return (counts.iron_ingot || 0) + (counts.raw_iron || 0) + (counts.iron_ore || 0) + (counts.deepslate_iron_ore || 0)
}

function hasSmeltingFuel (bot) {
  const counts = countInventory(bot)
  return ['coal', 'charcoal', ...PLANK_OR_LOG_NAMES].some(name => (counts[name] || 0) > 0)
}

function isDangerousNight (bot) {
  const time = bot.time?.timeOfDay
  if (typeof time !== 'number') return false
  return time >= 13000 && time <= 23500
}

function hasGoodWeapon (bot) {
  return bot.inventory.items().some(item => /^(stone|iron|diamond|netherite)_(sword|axe)$/.test(item.name))
}

async function clearBeaconJunkIfNeeded (bot, signal) {
  const junk = [
    'leaf_litter', 'wheat_seeds', 'bone', 'arrow', 'string', 'feather', 'gunpowder',
    'rotten_flesh', 'spider_eye', 'dirt', 'gravel', 'flint'
  ]
  const junkCount = bot.inventory.items()
    .filter(item => junk.includes(item.name))
    .reduce((sum, item) => sum + item.count, 0)
  if (freeSlots(bot) >= 6 && junkCount < 32) return
  for (const item of bot.inventory.items()) {
    assertNotCancelled(signal)
    if (freeSlots(bot) >= 8 && junkCount < 32) return
    if (!junk.includes(item.name)) continue
    await bot.tossStack(item).catch(() => {})
    await sleep(150)
  }
}

function freeSlots (bot) {
  if (typeof bot.inventory.emptySlotCount === 'function') return bot.inventory.emptySlotCount()
  const used = bot.inventory.items().length
  return Math.max(0, 36 - used)
}

function woodValue (bot) {
  return bot.inventory.items().reduce((sum, item) => {
    if (PLANK_OR_LOG_NAMES.includes(item.name)) return sum + item.count * (item.name.endsWith('_planks') ? 1 : 4)
    return sum
  }, 0)
}

async function craftDiamondBlocks (bot, memory, config, speaker, signal) {
  const state = ensureBeaconMemory(memory)
  state.phase = 'crafting_diamond_blocks'
  saveMemory(memory)

  await withdrawMatching(bot, memory, config, 'storage', ['diamond'], 64, signal).catch(() => 0)
  await ensureCraftingTable(bot, signal)

  let craftedAny = false
  while (!signal.cancelled && countInventory(bot).diamond >= 9 && countInventory(bot).diamond_block < REQUIRED_DIAMOND_BLOCKS) {
    const made = await craftItemByName(bot, 'diamond_block', 1, signal).catch(() => false)
    if (!made) break
    craftedAny = true
  }

  await depositInventory(bot, memory, config, 'storage', signal, item => ['diamond', 'diamond_block'].includes(item.name)).catch(() => {})
  const counts = await countAllResources(bot, memory, config, signal)
  updateProgress(state, counts)
  saveMemory(memory)
  if (craftedAny) speaker.say(`Crafted diamond blocks: ${state.progress.diamondBlocks}/${REQUIRED_DIAMOND_BLOCKS}.`, true)
}

async function acquireBeaconMaterials (bot, memory, config, speaker, signal, counts) {
  const state = ensureBeaconMemory(memory)
  state.phase = 'gathering_beacon_materials'
  saveMemory(memory)

  if ((counts.obsidian || 0) < BEACON_RECIPE.obsidian) {
    await ensureIronOrBetterPickaxe(bot, memory, config, speaker, signal)
    await mineBlocks(bot, memory, config, speaker, 'obsidian', BEACON_RECIPE.obsidian - (counts.obsidian || 0), signal).catch(err => {
      state.blockedReason = `Missing obsidian: ${err.message}`
    })
  }

  const refreshed = await countAllResources(bot, memory, config, signal)
  if ((refreshed.glass || 0) < BEACON_RECIPE.glass) {
    state.blockedReason = 'Missing glass. Need sand and smelting support before beacon crafting.'
  }
  if ((refreshed.nether_star || 0) < BEACON_RECIPE.nether_star) {
    state.blockedReason = 'Missing nether star. The bot must defeat or receive Wither loot before crafting a beacon.'
  }
  updateProgress(state, refreshed)
  saveMemory(memory)
  speaker.say(`Beacon materials: glass ${refreshed.glass || 0}/5, obsidian ${refreshed.obsidian || 0}/3, star ${refreshed.nether_star || 0}/1.`, true)
}

async function craftBeacon (bot, memory, config, speaker, signal) {
  const state = ensureBeaconMemory(memory)
  state.phase = 'crafting_beacon'
  saveMemory(memory)
  for (const [name, amount] of Object.entries(BEACON_RECIPE)) {
    await withdrawMatching(bot, memory, config, 'storage', [name], amount, signal).catch(() => 0)
  }
  await ensureCraftingTable(bot, signal)
  const made = await craftItemByName(bot, 'beacon', 1, signal).catch(() => false)
  if (!made) throw new Error('Missing glass, obsidian, or nether star for beacon.')
  speaker.say('Beacon crafted.', true)
}

async function buildBeaconPyramid (bot, memory, config, speaker, signal) {
  const state = ensureBeaconMemory(memory)
  const site = new Vec3(state.site.x, state.site.y, state.site.z)
  state.phase = 'building_pyramid'
  saveMemory(memory)

  await withdrawMatching(bot, memory, config, 'storage', ['diamond_block'], REQUIRED_DIAMOND_BLOCKS, signal).catch(() => 0)
  await withdrawMatching(bot, memory, config, 'storage', ['beacon'], 1, signal).catch(() => 0)
  await goNear(bot, site, 3, signal, 10000)

  const positions = pyramidPositions(site)
  let placed = 0
  for (const pos of positions) {
    assertNotCancelled(signal)
    if (blockNameAt(bot, pos) === 'diamond_block') {
      placed++
      continue
    }
    await placeNamedBlockAt(bot, 'diamond_block', pos, signal)
    if (blockNameAt(bot, pos) === 'diamond_block') placed++
    if (placed % 16 === 0) speaker.say(`Beacon pyramid placed ${placed}/${REQUIRED_DIAMOND_BLOCKS}.`, true)
  }

  await placeNamedBlockAt(bot, 'beacon', site.offset(0, 4, 0), signal)
}

function verifyBeaconPyramid (bot, siteJson) {
  const site = new Vec3(siteJson.x, siteJson.y, siteJson.z)
  return pyramidPositions(site).every(pos => blockNameAt(bot, pos) === 'diamond_block') &&
    blockNameAt(bot, site.offset(0, 4, 0)) === 'beacon'
}

async function placeNamedBlockAt (bot, itemName, pos, signal) {
  const item = bot.inventory.items().find(item => item.name === itemName)
  if (!item) throw new Error(`Missing ${itemName} while building.`)
  if (bot.entity.position.distanceTo(pos) > 4) await goNear(bot, pos, 3, signal, 8000).catch(() => {})
  const existing = bot.blockAt(pos)
  if (existing && existing.name === itemName) return true
  if (existing && !isAir(existing)) throw new Error(`Build spot blocked by ${existing.name}.`)
  const support = findSupport(bot, pos)
  if (!support) throw new Error('No support block for placement.')
  await bot.equip(item, 'hand')
  await bot.lookAt(support.block.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
  await bot.placeBlock(support.block, support.face)
  await sleep(120)
  return blockNameAt(bot, pos) === itemName
}

function pyramidPositions (site) {
  const positions = []
  const layers = [
    { y: 0, radius: 4 },
    { y: 1, radius: 3 },
    { y: 2, radius: 2 },
    { y: 3, radius: 1 }
  ]
  for (const layer of layers) {
    for (let x = -layer.radius; x <= layer.radius; x++) {
      for (let z = -layer.radius; z <= layer.radius; z++) {
        positions.push(site.offset(x, layer.y, z))
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
    if (block && !isAir(block) && !block.name.includes('water') && !block.name.includes('lava')) return { block, face }
  }
  return null
}

async function countAllResources (bot, memory, config, signal) {
  const inventory = countInventory(bot)
  const storage = await countChestItems(bot, memory, config, 'storage', signal).catch(() => ({}))
  const botStorage = await countChestItems(bot, memory, config, 'botStorage', signal).catch(() => ({}))
  return mergeCounts(inventory, storage, botStorage)
}

function updateProgress (state, counts) {
  state.updatedAt = new Date().toISOString()
  state.progress = {
    diamondItems: counts.diamond || 0,
    diamondBlocks: counts.diamond_block || 0,
    equivalentDiamonds: countDiamondEquivalent(counts),
    beaconMaterials: {
      glass: counts.glass || 0,
      obsidian: counts.obsidian || 0,
      nether_star: counts.nether_star || 0,
      beacon: counts.beacon || 0
    },
    missingDiamonds: Math.max(0, REQUIRED_DIAMONDS - countDiamondEquivalent(counts))
  }
}

function countDiamondEquivalent (counts) {
  return (counts.diamond || 0) + (counts.diamond_block || 0) * 9
}

function diamondBlockPotential (counts) {
  return (counts.diamond_block || 0) + Math.floor((counts.diamond || 0) / 9)
}

function hasBeaconMaterials (counts) {
  return Object.entries(BEACON_RECIPE).every(([name, amount]) => (counts[name] || 0) >= amount)
}

function hasBeaconItem (counts) {
  return (counts.beacon || 0) > 0
}

function isValuableForBeacon (name) {
  return ['diamond', 'diamond_block', 'glass', 'obsidian', 'nether_star', 'beacon'].includes(name)
}

function mergeCounts (...maps) {
  const out = {}
  for (const map of maps) {
    for (const [name, count] of Object.entries(map || {})) out[name] = (out[name] || 0) + count
  }
  return out
}

function ensureBeaconMemory (memory) {
  memory.ai = memory.ai || {}
  memory.ai.beaconPyramid = memory.ai.beaconPyramid || {
    mode: 'stopped',
    phase: 'not_started',
    targetDiamondBlocks: REQUIRED_DIAMOND_BLOCKS,
    targetDiamonds: REQUIRED_DIAMONDS,
    progress: {}
  }
  const state = memory.ai.beaconPyramid
  state.targetDiamondBlocks = REQUIRED_DIAMOND_BLOCKS
  state.targetDiamonds = REQUIRED_DIAMONDS
  return state
}

function foodItem (bot) {
  return bot.inventory.items().find(item => foodNames().includes(item.name))
}

function foodNames () {
  return [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
    'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton',
    'potato', 'mushroom_stew', 'sweet_berries'
  ]
}

async function eatFood (bot) {
  const food = foodItem(bot)
  if (!food) return false
  await bot.equip(food, 'hand')
  await bot.consume()
  return true
}

function blockNameAt (bot, pos) {
  return bot.blockAt(pos)?.name || null
}

function isAir (block) {
  return ['air', 'cave_air', 'void_air'].includes(block?.name)
}

module.exports = {
  REQUIRED_DIAMOND_BLOCKS,
  REQUIRED_DIAMONDS,
  runDiamondBeaconObjective,
  beaconStatus,
  setBeaconSite
}

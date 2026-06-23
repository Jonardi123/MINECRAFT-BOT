const { countChestItems, withdrawMatching } = require('./chest')
const { assertNotCancelled } = require('./navigation')
const { craftItemByName, ensureCraftingTable, prepareWoodForCrafting } = require('./crafting')

const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
const CRAFT_PICKAXES = ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
const AXES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']
const SHOVELS = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel']
const ARMOR_SLOTS = {
  helmet: 'head',
  chestplate: 'torso',
  leggings: 'legs',
  boots: 'feet'
}

async function ensurePickaxe (bot, memory, config, speaker, signal) {
  const existing = bot.inventory.items()
    .filter(item => PICKAXES.includes(item.name))
    .filter(item => durabilityRatio(item) > (config.behavior?.toolDurabilityThreshold ?? 0.08))
    .sort((a, b) => PICKAXES.indexOf(a.name) - PICKAXES.indexOf(b.name))[0]
  if (existing) {
    await bot.equip(existing, 'hand')
    return existing
  }

  speaker.say('Looking for a pickaxe.')
  const fromChest = await withdrawMatching(bot, memory, config, 'storage', PICKAXES, 1, signal).catch(() => 0)
  if (fromChest) {
    const pickaxe = bot.inventory.items().find(item => PICKAXES.includes(item.name))
    if (pickaxe) await bot.equip(pickaxe, 'hand')
    return pickaxe
  }

  speaker.say('No pickaxe found, crafting one.')
  return craftPickaxe(bot, memory, config, speaker, signal)
}

async function craftPickaxe (bot, memory, config, speaker, signal) {
  await gatherCraftingMaterials(bot, memory, config, signal)
  await prepareWoodForCrafting(bot, signal)
  const table = await ensureCraftingTable(bot, signal)
  if (!table) throw new Error('I need a crafting table to make a pickaxe.')

  for (const name of CRAFT_PICKAXES) {
    if (name === 'iron_pickaxe' && config.behavior.avoidRareMaterialsForTools) continue
    const crafted = await craftItemByName(bot, name, 1, signal)
    if (crafted) {
      assertNotCancelled(signal)
      const pickaxe = bot.inventory.items().find(inv => inv.name === name)
      if (pickaxe) {
        await bot.equip(pickaxe, 'hand')
        return pickaxe
      }
    }
  }

  throw new Error('Missing sticks, planks, stone, or iron for a pickaxe.')
}

async function gatherCraftingMaterials (bot, memory, config, signal) {
  await withdrawMatching(bot, memory, config, 'storage', ['stick'], 8, signal).catch(() => 0)
  await withdrawMatching(bot, memory, config, 'storage', ['cobblestone', 'cobbled_deepslate'], 3, signal).catch(() => 0)
  if (!config.behavior.avoidRareMaterialsForTools) {
    await withdrawMatching(bot, memory, config, 'storage', ['iron_ingot'], 3, signal).catch(() => 0)
  }
  const hasWood = bot.inventory.items().some(item => item.name.includes('planks') || item.name.includes('log'))
  if (!hasWood) {
    await withdrawMatching(bot, memory, config, 'storage', [
      'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
      'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log'
    ], 8, signal).catch(() => 0)
  }
}

async function equipBestArmor (bot, memory, config, speaker, signal) {
  await pullArmorFromStorage(bot, memory, config, signal)
  await craftMissingIronArmor(bot, memory, config, signal)
  for (const [piece, slot] of Object.entries(ARMOR_SLOTS)) {
    const current = bot.inventory.slots[equipmentSlot(bot, slot)]
    const replacement = bestArmorForPiece(bot, piece)
    if (replacement && shouldReplaceArmor(current, replacement, config)) {
      await bot.equip(replacement, slot)
    }
  }
}

async function equipBestArmorFromInventory (bot, config = {}) {
  for (const [piece, slot] of Object.entries(ARMOR_SLOTS)) {
    const current = bot.inventory.slots[equipmentSlot(bot, slot)]
    const replacement = bestArmorForPiece(bot, piece)
    if (replacement && shouldReplaceArmor(current, replacement, config)) {
      await bot.equip(replacement, slot)
    }
  }
}

async function equipBestToolForBlock (bot, block) {
  const tools = toolPreferenceForBlock(block)
  if (!tools.length) return null

  const tool = bot.inventory.items()
    .filter(item => tools.includes(item.name))
    .filter(item => durabilityRatio(item) > 0.05)
    .sort((a, b) => {
      const rank = tools.indexOf(a.name) - tools.indexOf(b.name)
      if (rank !== 0) return rank
      return durabilityRatio(b) - durabilityRatio(a)
    })[0]

  if (!tool) return null
  await bot.equip(tool, 'hand')
  return tool
}

function toolPreferenceForBlock (block) {
  const name = block?.name || ''
  if (needsAxe(name)) return AXES
  if (needsPickaxe(name)) return PICKAXES
  if (needsShovel(name)) return SHOVELS
  return []
}

function needsAxe (name) {
  return name.endsWith('_log') ||
    name.endsWith('_wood') ||
    name.endsWith('_stem') ||
    name.endsWith('_hyphae') ||
    name.includes('planks') ||
    name.includes('chest') ||
    name === 'crafting_table' ||
    name === 'barrel'
}

function needsPickaxe (name) {
  return name.includes('stone') ||
    name.includes('deepslate') ||
    name.includes('ore') ||
    name === 'cobblestone' ||
    name === 'netherrack' ||
    name === 'blackstone'
}

function needsShovel (name) {
  return name === 'dirt' ||
    name === 'grass_block' ||
    name === 'coarse_dirt' ||
    name === 'rooted_dirt' ||
    name === 'gravel' ||
    name === 'sand' ||
    name === 'red_sand' ||
    name === 'clay' ||
    name === 'snow'
}

async function craftMissingIronArmor (bot, memory, config, signal) {
  if (config.behavior.avoidRareMaterialsForTools) return
  const needed = []
  for (const [piece, slot] of Object.entries(ARMOR_SLOTS)) {
    const current = bot.inventory.slots[equipmentSlot(bot, slot)]
    if (!current || durabilityRatio(current) <= config.behavior.armorDurabilityThreshold) needed.push(piece)
  }
  if (!needed.length) return

  const recipes = {
    helmet: ['iron_helmet', 5],
    chestplate: ['iron_chestplate', 8],
    leggings: ['iron_leggings', 7],
    boots: ['iron_boots', 4]
  }

  for (const piece of needed) {
    const [itemName, ingots] = recipes[piece]
    const haveIngots = bot.inventory.items().filter(item => item.name === 'iron_ingot').reduce((sum, item) => sum + item.count, 0)
    if (haveIngots < ingots) {
      await withdrawMatching(bot, memory, config, 'storage', ['iron_ingot'], ingots - haveIngots, signal).catch(() => 0)
    }
    await craftItemByName(bot, itemName, 1, signal).catch(() => false)
  }
}

async function pullArmorFromStorage (bot, memory, config, signal) {
  const counts = await countChestItems(bot, memory, config, 'storage', signal).catch(() => ({}))
  for (const name of Object.keys(counts)) {
    if (Object.keys(ARMOR_SLOTS).some(piece => name.includes(piece))) {
      await withdrawMatching(bot, memory, config, 'storage', [name], 1, signal).catch(() => 0)
    }
  }
}

function bestArmorForPiece (bot, piece) {
  return bot.inventory.items()
    .filter(item => item.name.endsWith(piece))
    .sort((a, b) => armorScore(b) - armorScore(a))[0]
}

function equipmentSlot (bot, slot) {
  return bot.getEquipmentDestSlot(slot)
}

function armorRank (itemName, ranking) {
  const rank = ranking.indexOf(itemName.split('_')[0])
  return rank === -1 ? ranking.length : rank
}

function shouldReplaceArmor (current, replacement, config = {}) {
  if (!replacement) return false
  if (!current) return true
  const threshold = config.behavior?.armorDurabilityThreshold ?? 0.35
  if (durabilityRatio(current) <= threshold) return true
  return armorScore(replacement) > armorScore(current)
}

function armorScore (item) {
  if (!item) return 0
  const material = item.name.split('_')[0]
  const piece = Object.keys(ARMOR_SLOTS).find(piece => item.name.endsWith(piece)) || ''
  const materialScore = {
    netherite: 60,
    diamond: 50,
    iron: 40,
    chainmail: 34,
    golden: 28,
    leather: 18
  }[material] || 0
  const pieceScore = {
    chestplate: 8,
    leggings: 6,
    helmet: 4,
    boots: 3
  }[piece] || 0
  return materialScore + pieceScore + durabilityRatio(item)
}

function durabilityRatio (item) {
  if (!item || !item.maxDurability) return 1
  const used = item.nbt?.value?.Damage?.value || 0
  return Math.max(0, (item.maxDurability - used) / item.maxDurability)
}

module.exports = {
  ensurePickaxe,
  craftPickaxe,
  equipBestArmor,
  equipBestArmorFromInventory,
  equipBestToolForBlock,
  toolPreferenceForBlock,
  durabilityRatio,
  armorScore
}

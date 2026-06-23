const LOADOUTS = {
  basic_survival: {
    keep: ['food', 'pickaxe', 'axe', 'sword', 'blocks'],
    minFood: 4,
    minBlocks: 16
  },
  mining_trip: {
    keep: ['food', 'pickaxe', 'weapon', 'blocks', 'torches', 'shield'],
    minFood: 8,
    minBlocks: 32,
    minTorches: 16
  },
  combat_trip: {
    keep: ['food', 'weapon', 'shield', 'armor', 'blocks'],
    minFood: 6,
    minBlocks: 16
  },
  nether_trip: {
    keep: ['food', 'weapon', 'shield', 'armor', 'pickaxe', 'blocks', 'flint_and_steel', 'gold_armor'],
    minFood: 10,
    minBlocks: 48
  },
  dragon_prep: {
    keep: ['food', 'weapon', 'shield', 'armor', 'bow', 'arrows', 'blocks', 'water_bucket', 'pickaxe'],
    minFood: 16,
    minBlocks: 64
  }
}

function getLoadout (name) {
  return LOADOUTS[name] || LOADOUTS.basic_survival
}

function loadoutStatus (bot, name) {
  const loadout = getLoadout(name)
  const items = bot.inventory.items()
  const missing = []
  if (loadout.minFood && foodCount(items) < loadout.minFood) missing.push('food')
  if (loadout.minBlocks && blockCount(items) < loadout.minBlocks) missing.push('blocks')
  if (loadout.minTorches && countName(items, 'torch') < loadout.minTorches) missing.push('torches')
  for (const keep of loadout.keep || []) {
    if (keep === 'pickaxe' && !items.some(item => item.name.endsWith('_pickaxe'))) missing.push('pickaxe')
    if (keep === 'weapon' && !items.some(item => item.name.endsWith('_sword') || item.name.endsWith('_axe'))) missing.push('weapon')
    if (keep === 'shield' && !items.some(item => item.name === 'shield')) missing.push('shield')
    if (keep === 'water_bucket' && !items.some(item => item.name === 'water_bucket')) missing.push('water_bucket')
  }
  return { name, missing: [...new Set(missing)], ready: missing.length === 0 }
}

function foodCount (items) {
  return items.filter(item => [
    'porkchop', 'cooked_porkchop', 'beef', 'cooked_beef', 'mutton', 'cooked_mutton',
    'chicken', 'cooked_chicken', 'bread', 'apple', 'carrot', 'potato', 'baked_potato',
    'rotten_flesh', 'spider_eye'
  ].includes(item.name)).reduce((sum, item) => sum + item.count, 0)
}

function blockCount (items) {
  return items.filter(item => [
    'cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'netherrack', 'oak_planks', 'spruce_planks'
  ].includes(item.name)).reduce((sum, item) => sum + item.count, 0)
}

function countName (items, name) {
  return items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
}

module.exports = {
  LOADOUTS,
  getLoadout,
  loadoutStatus
}

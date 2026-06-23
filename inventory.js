const { goNear } = require('./navigation')

function summarizeInventory (bot) {
  const counts = countInventory(bot)
  const entries = Object.entries(counts).slice(0, 8)
  if (!entries.length) return 'Inventory is empty.'
  return entries.map(([name, count]) => `${count} ${name}`).join(', ')
}

function countInventory (bot) {
  const counts = {}
  for (const item of bot.inventory.items()) {
    counts[item.name] = (counts[item.name] || 0) + item.count
  }
  return counts
}

function hasInventorySpace (bot) {
  return bot.inventory.emptySlotCount() > 0
}

async function dropItemToPlayer (bot, player, itemName, signal) {
  const item = findItem(bot, itemName)
  if (!item) throw new Error(`I do not have ${itemName}.`)
  if (player?.position && bot.entity.position.distanceTo(player.position) > 4) {
    await goNear(bot, player.position, 3, signal, 2500).catch(() => {})
  }
  if (player?.position) await bot.lookAt(player.position.offset(0, 1, 0), true).catch(() => {})
  await bot.tossStack(item)
}

function findItem (bot, itemName) {
  const names = itemAliases(normalizeName(itemName))
  return bot.inventory.items().find(item => {
    const displayName = item.displayName.toLowerCase()
    return names.some(name => item.name === name || item.name.includes(name) || displayName.includes(name.replace(/_/g, ' ')))
  })
}

function normalizeName (name) {
  return String(name).toLowerCase().replace(/\s+/g, '_')
}

function itemAliases (name) {
  const aliases = {
    stone: ['stone', 'cobblestone'],
    cobble: ['cobblestone'],
    wood: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
    pork: ['porkchop', 'cooked_porkchop']
  }
  return aliases[name] || [name]
}

module.exports = {
  summarizeInventory,
  countInventory,
  hasInventorySpace,
  dropItemToPlayer,
  findItem,
  normalizeName,
  itemAliases
}

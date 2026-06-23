const { Vec3 } = require('vec3')
const { goNear, assertNotCancelled } = require('./navigation')
const { countInventory } = require('./inventory')

const SUPPLY_GROUPS = {
  wood: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'planks'],
  stone: ['cobblestone', 'stone', 'deepslate', 'cobbled_deepslate'],
  iron: ['iron_ingot'],
  coal: ['coal', 'charcoal'],
  food: ['porkchop', 'cooked_porkchop', 'beef', 'cooked_beef', 'chicken', 'cooked_chicken', 'bread', 'carrot', 'potato'],
  pickaxes: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'],
  armor: ['helmet', 'chestplate', 'leggings', 'boots']
}

function findChestPositionNearLook (bot, config) {
  const lookedAt = bot.blockAtCursor(config.behavior.chestSearchRadius)
  if (lookedAt && isChest(lookedAt)) return lookedAt.position

  const chest = bot.findBlock({
    matching: block => isChest(block),
    maxDistance: config.behavior.chestSearchRadius
  })
  return chest?.position || null
}

async function openSavedChest (bot, memory, config, kind, signal) {
  const candidates = chestCandidates(bot, memory, config, kind)
  if (!candidates.length) throw new Error(`No ${kind} chest saved or nearby.`)

  const failures = bot._teammateChestFailures || (bot._teammateChestFailures = new Map())
  let lastError = null
  for (const candidate of candidates) {
    const key = positionKey(candidate)
    if ((failures.get(key)?.count || 0) >= 3) continue
    try {
      await goNear(bot, candidate, 2, signal, config.behavior?.pathTimeoutMs || 6000)
      assertNotCancelled(signal)
      const block = bot.blockAt(candidate)
      if (!block || !isChest(block)) throw new Error(`No chest at ${candidate.x} ${candidate.y} ${candidate.z}`)
      const chest = await bot.openContainer(block)
      failures.delete(key)
      return chest
    } catch (err) {
      lastError = err
      const current = failures.get(key) || { count: 0 }
      failures.set(key, { count: current.count + 1, at: Date.now() })
    }
  }

  throw new Error(`Could not open ${kind} chest: ${shortError(lastError || 'all candidates failed')}`)
}

async function depositInventory (bot, memory, config, kind, signal, filter = () => true, options = {}) {
  const chest = await openSavedChest(bot, memory, config, kind, signal)
  const plan = loadoutKeepPlan(bot)
  const explicitFilter = arguments.length >= 6
  const report = {
    deposited: {},
    kept: {},
    failed: {},
    full: false,
    attempted: 0
  }
  try {
    const items = bot.inventory.items().slice().sort(depositPriority)
    for (const item of items) {
      assertNotCancelled(signal)
      if (!filter(item)) continue
      const keep = options.protectLoadout === false ? 0 : keepCountFor(item, plan, { explicitFilter })
      const depositCount = Math.max(0, item.count - keep)
      if (depositCount <= 0) {
        addCount(report.kept, item.name, item.count)
        continue
      }
      report.attempted += depositCount
      try {
        await chest.deposit(item.type, null, depositCount)
        addCount(report.deposited, item.name, depositCount)
      } catch (err) {
        if (/full|destination|no empty slot|space/i.test(String(err?.message || err))) report.full = true
        addCount(report.failed, item.name, depositCount)
      }
    }
    return report
  } finally {
    chest.close()
  }
}

async function countChestItems (bot, memory, config, kind, signal) {
  const chest = await openSavedChest(bot, memory, config, kind, signal)
  try {
    const counts = {}
    for (const item of chest.containerItems()) {
      counts[item.name] = (counts[item.name] || 0) + item.count
    }
    return counts
  } finally {
    chest.close()
  }
}

async function withdrawMatching (bot, memory, config, kind, names, count, signal) {
  const chest = await openSavedChest(bot, memory, config, kind, signal)
  try {
    for (const item of chest.containerItems()) {
      if (names.includes(item.name)) {
        const amount = Math.min(count, item.count)
        await chest.withdraw(item.type, null, amount)
        return amount
      }
    }
    return 0
  } finally {
    chest.close()
  }
}

async function checkSupplies (bot, memory, config, signal) {
  const chestCounts = await countChestItems(bot, memory, config, 'storage', signal)
  const invCounts = countInventory(bot)
  const counts = mergeCounts(chestCounts, invCounts)
  const low = []

  if (sumGroups(counts, SUPPLY_GROUPS.wood) < config.supplies.lowWood) low.push('wood')
  if (sumGroups(counts, SUPPLY_GROUPS.stone) < config.supplies.lowStone) low.push('stone')
  if (sumGroups(counts, SUPPLY_GROUPS.iron) < config.supplies.lowIron) low.push('iron')
  if (sumGroups(counts, SUPPLY_GROUPS.coal) < config.supplies.lowCoal) low.push('coal')
  if (sumGroups(counts, SUPPLY_GROUPS.food) < config.supplies.lowFood) low.push('food')
  if (sumGroups(counts, SUPPLY_GROUPS.pickaxes) < config.supplies.lowPickaxes) low.push('pickaxes')
  if (sumGroups(counts, SUPPLY_GROUPS.armor) < config.supplies.lowArmorPieces) low.push('armor')

  return low.length ? `Low supplies: ${low.join(', ')}.` : 'Supplies look okay.'
}

function mergeCounts (...countMaps) {
  const result = {}
  for (const counts of countMaps) {
    for (const [name, count] of Object.entries(counts)) {
      result[name] = (result[name] || 0) + count
    }
  }
  return result
}

function sumGroups (counts, names) {
  return Object.entries(counts).reduce((sum, [name, count]) => {
    return names.some(groupName => name.includes(groupName)) ? sum + count : sum
  }, 0)
}

function isChest (block) {
  return block?.name === 'chest' || block?.name === 'trapped_chest' || block?.name === 'barrel'
}

function chestCandidates (bot, memory, config, kind) {
  const seen = new Set()
  const candidates = []
  const saved = memory.chests?.[kind]
  if (saved) addCandidate(new Vec3(saved.x, saved.y, saved.z))

  for (const block of findNearbyChests(bot, config)) addCandidate(block.position)

  return candidates
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))

  function addCandidate (pos) {
    const key = positionKey(pos)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(pos)
  }
}

function findNearbyChests (bot, config) {
  const radius = Math.max(config.behavior?.chestSearchRadius || 5, 8)
  return bot.findBlocks({
    matching: block => isChest(block),
    maxDistance: radius,
    count: 16
  })
    .map(pos => bot.blockAt(pos))
    .filter(Boolean)
}

function loadoutKeepPlan (bot) {
  const plan = new Map()
  const items = bot.inventory.items()
  keepBest(plan, items, item => isWeapon(item.name), weaponScore)
  keepBest(plan, items, item => item.name.endsWith('_pickaxe'), toolScore)

  for (const item of items) {
    if (isArmor(item.name) || isRare(item.name)) plan.set(item.name, (plan.get(item.name) || 0) + item.count)
  }

  const food = items.filter(item => isFood(item.name)).sort((a, b) => b.count - a.count)[0]
  if (food) plan.set(food.name, Math.max(plan.get(food.name) || 0, Math.min(food.count, 32)))

  const torches = items.find(item => item.name === 'torch' || item.name === 'lantern')
  if (torches) plan.set(torches.name, Math.max(plan.get(torches.name) || 0, Math.min(torches.count, 32)))

  return plan
}

function keepBest (plan, items, predicate, scoreFn) {
  const best = items.filter(predicate).sort((a, b) => scoreFn(b) - scoreFn(a))[0]
  if (best) plan.set(best.name, Math.max(plan.get(best.name) || 0, 1))
}

function keepCountFor (item, plan, options = {}) {
  if (isArmor(item.name)) return item.count
  if (isRare(item.name) && !options.explicitFilter) return item.count
  if (isTool(item.name) && !item.name.endsWith('_pickaxe') && !isWeapon(item.name)) return item.count
  return Math.min(item.count, plan.get(item.name) || 0)
}

function depositPriority (a, b) {
  return junkScore(a.name) - junkScore(b.name) || a.name.localeCompare(b.name)
}

function junkScore (name) {
  if (isTool(name) || isArmor(name) || isFood(name) || name === 'torch' || name === 'lantern' || isRare(name)) return 50
  if (['dirt', 'gravel', 'sand', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack'].includes(name)) return 0
  if (name.includes('rotten') || name.includes('string') || name.includes('bone')) return 5
  return 10
}

function isTool (name) {
  return /_(pickaxe|axe|shovel|hoe|sword)$/.test(name) || name === 'bow' || name === 'crossbow' || name === 'trident' || name === 'mace' || name === 'shield'
}

function isWeapon (name) {
  return /_(sword|axe)$/.test(name) || name === 'bow' || name === 'crossbow' || name === 'trident' || name === 'mace'
}

function isArmor (name) {
  return /_(helmet|chestplate|leggings|boots)$/.test(name) || name === 'elytra'
}

function isFood (name) {
  return [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
    'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton',
    'potato', 'mushroom_stew', 'sweet_berries', 'golden_apple'
  ].includes(name)
}

function isRare (name) {
  return /diamond|emerald|netherite|ancient_debris|elytra|totem|shulker|beacon|nether_star|blaze|ender_pearl|eye_of_ender/.test(name)
}

function weaponScore (item) {
  const material = materialScore(item.name)
  if (item.name.endsWith('_axe')) return 100 + material
  if (item.name.endsWith('_sword')) return 90 + material
  if (item.name === 'trident' || item.name === 'mace') return 95
  if (item.name === 'bow' || item.name === 'crossbow') return 70
  return material
}

function toolScore (item) {
  return materialScore(item.name) + durabilityRatio(item)
}

function materialScore (name) {
  if (name.startsWith('netherite_')) return 50
  if (name.startsWith('diamond_')) return 40
  if (name.startsWith('iron_')) return 30
  if (name.startsWith('stone_')) return 20
  if (name.startsWith('golden_')) return 15
  if (name.startsWith('wooden_')) return 10
  return 0
}

function durabilityRatio (item) {
  if (!item?.maxDurability) return 1
  const used = item.nbt?.value?.Damage?.value || 0
  return Math.max(0, (item.maxDurability - used) / item.maxDurability)
}

function addCount (map, name, count) {
  map[name] = (map[name] || 0) + count
}

function positionKey (pos) {
  return `${pos.x},${pos.y},${pos.z}`
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)
}

module.exports = {
  SUPPLY_GROUPS,
  findChestPositionNearLook,
  openSavedChest,
  depositInventory,
  countChestItems,
  withdrawMatching,
  checkSupplies,
  sumGroups
}

const { Vec3 } = require('vec3')
const { goNear, sleep, assertNotCancelled } = require('./navigation')
const { craftItemByName, ensureCraftingTable, prepareWoodForCrafting } = require('./crafting')
const { farmTarget } = require('./farming')

const COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
]

const RAW_TO_COOKED = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato'
}

const FUEL_NAMES = [
  'coal', 'charcoal',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log'
]

async function makeBedAndSetSpawn (bot, memory, config, speaker, signal) {
  const existing = findNearestBed(bot) || findInventoryItem(bot, item => item.name.endsWith('_bed'))
  if (!existing) {
    await ensureBedItem(bot, memory, config, speaker, signal)
  }

  let bedBlock = findNearestBed(bot)
  if (!bedBlock) {
    const bedItem = findInventoryItem(bot, item => item.name.endsWith('_bed'))
    if (!bedItem) throw new Error('I need 3 matching wool and 3 planks to make a bed.')
    bedBlock = await placeBed(bot, signal)
  }

  if (!bedBlock) throw new Error('I made or have a bed, but I could not place it safely.')
  const slept = await trySleep(bot, bedBlock)
  rememberBed(memory, bedBlock.position, slept)
  if (slept) {
    speaker.say('Bed made and spawn set.', true)
  } else {
    speaker.say('Bed placed. I can set spawn when it is night or thunder.', true)
  }
  return { placed: true, spawnSet: slept }
}

async function sleepInOwnBed (bot, memory, speaker, signal) {
  const bed = findNearestBed(bot)
  if (!bed) throw new Error('No bed nearby. Use !makeBed first.')
  await goNear(bot, bed.position, 2, signal, 5000).catch(() => {})
  const slept = await trySleep(bot, bed)
  rememberBed(memory, bed.position, slept)
  if (!slept) throw new Error('I can only sleep and set spawn at night or during thunder.')
  speaker.say('Spawn set.', true)
  return true
}

async function cookFood (bot, memory, config, speaker, signal, wanted = 64) {
  const raw = pickRawFood(bot)
  if (!raw) {
    speaker.say('No raw food to cook.', true)
    return { cooked: 0 }
  }

  const furnaceBlock = await ensureFurnace(bot, signal)
  if (!furnaceBlock) throw new Error('I need a furnace, or 8 cobblestone/deepslate to craft one.')

  const fuel = pickFuel(bot)
  if (!fuel) throw new Error('I need coal, charcoal, logs, or planks as fuel.')

  await goNear(bot, furnaceBlock.position, 2, signal, 5000)
  const furnace = await bot.openFurnace(furnaceBlock)
  let cooked = 0
  try {
    const amount = Math.min(raw.count, wanted, fuelCapacity(fuel))
    await furnace.putInput(raw.type, null, amount)
    await furnace.putFuel(fuel.type, null, Math.max(1, Math.ceil(amount / 8)))

    const endAt = Date.now() + Math.max(20000, amount * 12000)
    while (!signal.cancelled && Date.now() < endAt) {
      const output = furnace.outputItem()
      if (output) {
        cooked += output.count
        await furnace.takeOutput()
        if (cooked >= amount) break
      }
      await sleep(1000)
    }
  } finally {
    furnace.close()
  }

  if (cooked > 0) speaker.say(`Cooked ${cooked} food.`, true)
  else speaker.say('Furnace started, but no cooked food came out yet.', true)
  return { cooked }
}

async function smeltInventoryItem (bot, itemName, fuelNames, wanted, signal) {
  const input = findInventoryItem(bot, item => item.name === itemName)
  if (!input) return 0
  const furnaceBlock = await ensureFurnace(bot, signal)
  if (!furnaceBlock) throw new Error('I need a furnace or 8 cobblestone/deepslate to smelt.')
  const fuel = findInventoryItem(bot, item => fuelNames.includes(item.name)) || pickFuel(bot)
  if (!fuel) throw new Error('I need fuel to smelt.')

  await goNear(bot, furnaceBlock.position, 2, signal, 5000)
  const furnace = await bot.openFurnace(furnaceBlock)
  let smelted = 0
  try {
    const amount = Math.min(input.count, wanted || input.count, fuelCapacity(fuel))
    await furnace.putInput(input.type, null, amount)
    await furnace.putFuel(fuel.type, null, Math.max(1, Math.ceil(amount / 8)))
    const endAt = Date.now() + Math.max(20000, amount * 12000)
    while (!signal.cancelled && Date.now() < endAt) {
      const output = furnace.outputItem()
      if (output) {
        smelted += output.count
        await furnace.takeOutput()
        if (smelted >= amount) break
      }
      await sleep(1000)
    }
  } finally {
    furnace.close()
  }
  return smelted
}

async function ensureBedItem (bot, memory, config, speaker, signal) {
  await craftPlanksUntil(bot, 3, signal)
  if (!hasPlanks(bot, 3)) throw new Error('I need 3 planks for a bed.')

  if (!bestWoolColor(bot)) {
    speaker.routine?.('Getting wool.')
    await farmTarget(bot, memory, config, quietSpeaker(speaker), 'sheep', 3, signal).catch(() => {})
  }

  const color = bestWoolColor(bot)
  if (!color) throw new Error('I could not get 3 matching wool.')

  await ensureCraftingTable(bot, signal)
  const made = await craftItemByName(bot, `${color}_bed`, 1, signal).catch(() => false)
  if (!made && !findInventoryItem(bot, item => item.name === `${color}_bed`)) {
    throw new Error(`I could not craft a ${color.replace(/_/g, ' ')} bed.`)
  }
}

async function ensureFurnace (bot, signal) {
  const existing = bot.findBlock({ matching: block => block.name === 'furnace', maxDistance: 8 })
  if (existing) return existing

  if (!findInventoryItem(bot, item => item.name === 'furnace')) {
    await ensureCraftingTable(bot, signal).catch(() => null)
    await craftItemByName(bot, 'furnace', 1, signal).catch(() => false)
  }

  if (!findInventoryItem(bot, item => item.name === 'furnace')) return null
  const pos = await placeInventoryBlock(bot, ['furnace'], signal)
  return pos ? bot.blockAt(pos) : null
}

async function placeBed (bot, signal) {
  const bedItem = findInventoryItem(bot, item => item.name.endsWith('_bed'))
  if (!bedItem) return null
  await bot.equip(bedItem, 'hand')

  const base = bot.entity.position.floored()
  const directions = [
    [0, -1], [1, 0], [0, 1], [-1, 0],
    [1, -1], [1, 1], [-1, 1], [-1, -1]
  ]

  for (const [x, z] of directions) {
    assertNotCancelled(signal)
    const head = base.offset(x, 0, z)
    const foot = head.offset(Math.sign(x), 0, Math.sign(z))
    if (!isTwoBlockSpaceClear(bot, head, foot)) continue
    const floor = bot.blockAt(head.offset(0, -1, 0))
    if (!floor || isAir(floor)) continue
    await goNear(bot, head, 3, signal, 4000).catch(() => {})
    await bot.lookAt(floor.position.offset(0.5, 1.5, 0.5), true).catch(() => {})
    await bot.placeBlock(floor, new Vec3(0, 1, 0)).catch(() => null)
    await sleep(250)
    const placed = findNearestBed(bot)
    if (placed) return placed
  }
  return null
}

async function placeInventoryBlock (bot, names, signal) {
  const item = findInventoryItem(bot, inv => names.includes(inv.name))
  if (!item) return null
  await bot.equip(item, 'hand')
  const base = bot.entity.position.floored()
  for (let radius = 1; radius <= 4; radius++) {
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue
        const pos = base.offset(x, 0, z)
        const floor = bot.blockAt(pos.offset(0, -1, 0))
        const at = bot.blockAt(pos)
        const above = bot.blockAt(pos.offset(0, 1, 0))
        if (!floor || !at || !above || !isAir(at) || !isAir(above) || isAir(floor)) continue
        assertNotCancelled(signal)
        await goNear(bot, pos, 3, signal, 4000).catch(() => {})
        await bot.lookAt(floor.position.offset(0.5, 1.5, 0.5), true).catch(() => {})
        await bot.placeBlock(floor, new Vec3(0, 1, 0)).catch(() => null)
        await sleep(200)
        const placed = bot.blockAt(pos)
        if (placed && names.includes(placed.name)) return pos
      }
    }
  }
  return null
}

async function trySleep (bot, bed) {
  try {
    await bot.sleep(bed)
    return true
  } catch {
    return false
  }
}

function rememberBed (memory, pos, spawnSet) {
  memory.ai = memory.ai || {}
  memory.ai.domestic = memory.ai.domestic || {}
  memory.ai.domestic.bed = { x: pos.x, y: pos.y, z: pos.z }
  memory.ai.domestic.spawnSet = Boolean(spawnSet) || memory.ai.domestic.spawnSet === true
  memory.ai.domestic.lastBedCheckAt = new Date().toISOString()
}

function findNearestBed (bot) {
  return bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 8 })
}

function pickRawFood (bot) {
  return bot.inventory.items()
    .filter(item => Object.prototype.hasOwnProperty.call(RAW_TO_COOKED, item.name))
    .sort((a, b) => foodPriority(a.name) - foodPriority(b.name))[0] || null
}

function pickFuel (bot) {
  return bot.inventory.items()
    .filter(item => FUEL_NAMES.includes(item.name))
    .sort((a, b) => FUEL_NAMES.indexOf(a.name) - FUEL_NAMES.indexOf(b.name))[0] || null
}

async function craftPlanksUntil (bot, amount, signal) {
  for (let i = 0; i < 4 && !hasPlanks(bot, amount); i++) {
    await prepareWoodForCrafting(bot, signal).catch(() => {})
    const log = bot.inventory.items().find(item => item.name.endsWith('_log') || item.name.endsWith('_stem'))
    if (!log) break
    const plankName = log.name.replace(/_(log|stem)$/, '_planks')
    await craftItemByName(bot, plankName, 1, signal).catch(() => false)
  }
}

function fuelCapacity (item) {
  if (!item) return 0
  if (item.name === 'coal' || item.name === 'charcoal') return item.count * 8
  return item.count
}

function bestWoolColor (bot) {
  return COLORS.find(color => countItems(bot, [`${color}_wool`]) >= 3) || null
}

function hasPlanks (bot, amount) {
  return bot.inventory.items()
    .filter(item => item.name.endsWith('_planks'))
    .reduce((sum, item) => sum + item.count, 0) >= amount
}

function countItems (bot, names) {
  return bot.inventory.items()
    .filter(item => names.includes(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

function findInventoryItem (bot, predicate) {
  return bot.inventory.items().find(predicate)
}

function foodPriority (name) {
  return ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'].indexOf(name)
}

function isTwoBlockSpaceClear (bot, a, b) {
  return [a, b].every(pos => {
    const at = bot.blockAt(pos)
    const above = bot.blockAt(pos.offset(0, 1, 0))
    const floor = bot.blockAt(pos.offset(0, -1, 0))
    return at && above && floor && isAir(at) && isAir(above) && !isAir(floor)
  })
}

function isAir (block) {
  return ['air', 'cave_air', 'void_air'].includes(block?.name)
}

function quietSpeaker (speaker) {
  return {
    say: message => speaker.routine?.(message),
    routine: message => speaker.routine?.(message),
    autopilot: (message, important) => speaker.autopilot?.(message, important)
  }
}

module.exports = {
  cookFood,
  smeltInventoryItem,
  ensureFurnace,
  makeBedAndSetSpawn,
  sleepInOwnBed
}

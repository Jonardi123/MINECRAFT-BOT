const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goNear, followPlayer, wanderNearHome, getHomePosition, gotoWithTimeout, sleep, assertNotCancelled } = require('./navigation')
const { findItem } = require('./inventory')
const { craftItemByName } = require('./crafting')
const { depositInventory, withdrawMatching, openSavedChest } = require('./chest')
const { equipBestToolForBlock } = require('./equipment')
const { mineBlocks, prospectMine, smartMineResource, branchMineForResource, staircaseMine, safeCaveExplore, isSafeToDig } = require('./mining')
const { farmTarget } = require('./farming')
const { collectNearbyItems } = require('./collection')
const { gatherWood, gatherStarterStone } = require('./survival')
const { fightEntitySmart, findBestHostileThreat } = require('./combat')
const { runDirectorStep } = require('./survivalDirector')

const FOOD_NAMES = [
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
  'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton', 'potato',
  'rotten_flesh', 'spider_eye'
]

const LOG_NAMES = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log'
]

async function executeAiAction (ctx, decision, signal) {
  const { bot, memory, config, speaker, protector, pvp } = ctx
  assertNotCancelled(signal)

  switch (decision.action) {
    case 'idle':
      await sleep(Math.min(config.aiControl?.idleMs || 1000, 5000))
      return 'idled'

    case 'chat':
      if (decision.chat) speaker.say(decision.chat, true)
      return 'chatted'

    case 'move_to':
      await goNear(bot, toVec(decision.position), 2, signal, config.behavior.pathTimeoutMs)
      return 'moved'

    case 'follow_player': {
      const player = findPlayer(bot, decision.target)
      if (!player) throw new Error('player not visible')
      await followPlayer(bot, player, signal, config)
      return 'followed player'
    }

    case 'look_at':
      await lookAtTarget(bot, decision)
      return 'looked'

    case 'jump':
      bot.setControlState('jump', true)
      await sleep(350)
      bot.setControlState('jump', false)
      return 'jumped'

    case 'sprint':
      bot.setControlState('sprint', true)
      await sleep(Math.min(decision.amount || 1000, 3000))
      bot.setControlState('sprint', false)
      return 'sprinted'

    case 'sneak':
      bot.setControlState('sneak', true)
      await sleep(Math.min(decision.amount || 1000, 3000))
      bot.setControlState('sneak', false)
      return 'sneaked'

    case 'dig_block':
      await digSpecificBlock(bot, config, decision, signal)
      await collectNearbyItems(bot, config, signal, { radius: 6, attempts: 5 }).catch(() => {})
      return 'dug block'

    case 'place_block':
      await placeBlock(bot, decision, signal)
      return 'placed block'

    case 'equip_item':
      await equipItem(bot, decision.target)
      return 'equipped item'

    case 'eat_food':
      await eatFood(bot)
      return 'ate food'

    case 'attack_entity':
      await attackEntity(ctx, decision, signal)
      return 'attacked entity'

    case 'fight':
      await attackEntity(ctx, decision, signal)
      return 'fought target'

    case 'flee':
      await flee(bot, memory, config, signal)
      return 'fled'

    case 'craft_item':
      if (!decision.target) throw new Error('missing craft target')
      if (!await craftItemByName(bot, decision.target, Math.max(1, decision.amount || 1), signal)) {
        throw new Error(`could not craft ${decision.target}`)
      }
      return 'crafted item'

    case 'smelt_item':
      await smeltItem(bot, decision, signal)
      return 'smelted item'

    case 'open_chest':
      await openSavedChest(bot, memory, config, decision.target || 'storage', signal).then(chest => chest.close())
      return 'opened chest'

    case 'deposit_item':
      await depositAiItem(bot, memory, config, decision, signal)
      return 'deposited items'

    case 'withdraw_item':
      if (!decision.target) throw new Error('missing withdraw target')
      await withdrawMatching(bot, memory, config, 'storage', [decision.target], Math.max(1, decision.amount || 1), signal)
      return 'withdrew item'

    case 'sleep':
      await sleepInBed(bot)
      return 'slept'

    case 'explore':
      await wanderNearHome(bot, memory, config, speaker, signal)
      return 'explored'

    case 'return_home': {
      const home = getHomePosition(memory, config)
      if (!home) throw new Error('no home saved')
      await goNear(bot, home, 2, signal, config.behavior.pathTimeoutMs)
      return 'returned home'
    }

    case 'mine_resource':
      if (isStarterStoneTarget(decision.target)) {
        await gatherStarterStone(bot, memory, config, speaker, signal, Math.max(1, decision.amount || 12))
        return 'mined starter stone'
      }
      await smartMineResource(bot, memory, config, speaker, decision.target || 'stone', Math.max(1, decision.amount || 4), signal)
      return 'mined resource'

    case 'prospect_resource':
      await prospectMine(bot, memory, config, speaker, decision.target || 'iron', Math.max(1, decision.amount || 1), signal, config.aiControl?.prospectSteps || 96)
      return 'prospected resource'

    case 'branch_mine':
      await branchMineForResource(bot, memory, config, speaker, decision.target || 'diamond', Math.max(1, decision.amount || 1), signal)
      return 'branch mined'

    case 'staircase_mine':
      await staircaseMine(bot, memory, config, speaker, decision.position?.y ?? decision.amount ?? -58, signal)
      return 'staircase mined'

    case 'cave_explore':
      await safeCaveExplore(bot, memory, config, speaker, Math.max(4, decision.amount || 32), signal)
      return 'cave explored'

    case 'gather_wood':
      await gatherWood(bot, config, speaker, signal, Math.max(1, decision.amount || 12))
      return 'gathered wood'

    case 'gather_food':
      await gatherFood(bot, memory, config, speaker, decision, signal)
      return 'gathered food'

    case 'secure_food':
      await runDirectorStep('secure_food', bot, memory, config, speaker, signal)
      return 'secured food'

    case 'prepare_mining':
      await runDirectorStep('prepare_diamond_mining', bot, memory, config, speaker, signal)
      return 'prepared mining'

    case 'safe_branch_mine':
      await runDirectorStep(decision.target?.includes('diamond') ? 'mine_diamonds' : 'prepare_diamond_mining', bot, memory, config, speaker, signal)
      return 'safe branch mine'

    case 'combat_prepare':
      await runDirectorStep('armor_up', bot, memory, config, speaker, signal)
      return 'combat prepared'

    case 'nether_prepare':
      await runDirectorStep('prepare_nether', bot, memory, config, speaker, signal)
      return 'nether prepared'

    case 'survival_progression':
      await runDirectorStep('idle_improve', bot, memory, config, speaker, signal)
      return 'survival improved'

    case 'recover_from_failure':
      await flee(bot, memory, config, signal)
      return 'recovered'

    default:
      throw new Error(`unsupported action ${decision.action}`)
  }
}

function toVec (position) {
  if (!position) throw new Error('missing position')
  return new Vec3(position.x, position.y, position.z)
}

function findPlayer (bot, name) {
  if (name && bot.players[name]?.entity) return bot.players[name].entity
  return Object.values(bot.players).find(player => player.entity && player.entity.username !== bot.username)?.entity || null
}

async function lookAtTarget (bot, decision) {
  if (decision.position) {
    await bot.lookAt(toVec(decision.position).offset(0.5, 0.5, 0.5), true)
    return
  }
  const entity = nearestEntityByName(bot, decision.target)
  if (!entity) throw new Error('target not visible')
  await bot.lookAt(entity.position.offset(0, entity.height || 1, 0), true)
}

async function digSpecificBlock (bot, config, decision, signal) {
  const block = decision.position
    ? bot.blockAt(toVec(decision.position))
    : nearestBlock(bot, decision.target, config.aiControl?.visibleBlockRadius || 12)
  if (!block) throw new Error('block not visible')
  if (decision.target && block.name !== decision.target && !block.name.includes(decision.target)) throw new Error(`target mismatch: ${block.name}`)
  if (!isSafeToDig(bot, block)) throw new Error('block unsafe to dig')
  if (!bot.canDigBlock(block)) {
    await gotoWithTimeout(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }), signal, config.behavior.minePathTimeoutMs)
  }
  await equipBestToolForBlock(bot, block).catch(() => null)
  if (!bot.canDigBlock(block)) throw new Error('cannot dig block')
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  await bot.dig(block, true, 'raycast')
}

async function placeBlock (bot, decision, signal) {
  const item = findItem(bot, decision.target)
  if (!item) throw new Error(`missing ${decision.target}`)
  await bot.equip(item, 'hand')
  const pos = decision.position ? toVec(decision.position) : bot.entity.position.floored().offset(1, 0, 0)
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  if (!floor || floor.name === 'air') throw new Error('no floor for placement')
  await goNear(bot, pos, 3, signal, 4000).catch(() => {})
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
  await bot.placeBlock(floor, new Vec3(0, 1, 0))
}

async function equipItem (bot, target) {
  const item = findItem(bot, target)
  if (!item) throw new Error(`missing ${target}`)
  const slot = item.name.endsWith('_helmet') ? 'head'
    : item.name.endsWith('_chestplate') ? 'torso'
      : item.name.endsWith('_leggings') ? 'legs'
        : item.name.endsWith('_boots') ? 'feet'
          : 'hand'
  await bot.equip(item, slot)
}

async function eatFood (bot) {
  const food = bot.inventory.items().find(item => FOOD_NAMES.includes(item.name))
  if (!food) throw new Error('no food')
  await bot.equip(food, 'hand')
  await bot.consume()
}

async function attackEntity (ctx, decision, signal) {
  const { bot, memory, config, speaker } = ctx
  const entity = nearestEntityByName(bot, decision.target) || findBestHostileThreat(bot, config, false, null, memory)
  if (!entity) throw new Error('entity not visible')
  await fightEntitySmart(bot, memory, config, speaker, entity, signal)
}

async function flee (bot, memory, config, signal) {
  const home = getHomePosition(memory, config)
  if (home) {
    await goNear(bot, home, 3, signal, config.behavior.pathTimeoutMs).catch(() => {})
    return
  }
  const away = bot.entity.position.offset(Math.round(Math.random() * 12) - 6, 0, Math.round(Math.random() * 12) - 6)
  await goNear(bot, away, 3, signal, config.behavior.pathTimeoutMs).catch(() => {})
}

async function smeltItem (bot, decision, signal) {
  const furnace = bot.findBlock({ matching: block => block.name === 'furnace', maxDistance: 8 })
  if (!furnace) throw new Error('no furnace nearby')
  await goNear(bot, furnace.position, 2, signal)
  const input = findItem(bot, decision.target)
  const fuel = bot.inventory.items().find(item => ['coal', 'charcoal', 'oak_log', 'dark_oak_log', 'spruce_log'].includes(item.name))
  if (!input || !fuel) throw new Error('missing smelt input or fuel')
  const open = await bot.openFurnace(furnace)
  try {
    await open.putInput(input.type, null, Math.max(1, decision.amount || 1))
    await open.putFuel(fuel.type, null, 1)
    await sleep(1000)
  } finally {
    open.close()
  }
}

async function sleepInBed (bot) {
  const bed = bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 8 })
  if (!bed) throw new Error('no bed nearby')
  await bot.sleep(bed)
}

async function gatherFood (bot, memory, config, speaker, decision, signal) {
  const targets = {
    pigs: 'pig',
    cows: 'cow',
    sheep: 'sheep',
    chickens: 'chicken'
  }
  const target = targets[decision.target]
    ? decision.target
    : Object.entries(targets).find(([, entityName]) => nearestEntityByName(bot, entityName))?.[0] || 'pigs'
  await farmTarget(bot, memory, config, speaker, target, Math.max(1, decision.amount || 2), signal)
}

async function depositAiItem (bot, memory, config, decision, signal) {
  const container = decision.container || decision.kind
  const kind = container === 'farm' || decision.target === 'farm' ? 'farm' : 'storage'
  const itemName = decision.kind ? decision.target : (decision.target === 'storage' || decision.target === 'farm' ? null : decision.target)
  if (!itemName) {
    await depositInventory(bot, memory, config, kind, signal)
    return
  }

  await depositInventory(bot, memory, config, kind, signal, item => {
    return item.name === itemName || item.name.includes(itemName)
  })
}

function nearestBlock (bot, name, radius) {
  const block = bot.findBlock({
    matching: block => !name || block.name === name || block.name.includes(name),
    maxDistance: radius
  })
  return block || null
}

function nearestEntityByName (bot, name) {
  return bot.nearestEntity(entity => {
    if (!entity?.isValid || entity === bot.entity) return false
    if (!name) return true
    const needle = String(name).toLowerCase()
    return entity.name === needle || entity.username?.toLowerCase() === needle || entity.name?.includes(needle)
  })
}

function positionKey (pos) {
  return `${pos.x},${pos.y},${pos.z}`
}

function isStarterStoneTarget (target) {
  const name = String(target || '').toLowerCase()
  return ['stone', 'cobble', 'cobblestone', 'deepslate', 'cobbled_deepslate'].includes(name)
}

module.exports = { executeAiAction }

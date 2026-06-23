const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { hasInventorySpace, normalizeName } = require('./inventory')
const { depositInventory } = require('./chest')
const { ensurePickaxe, equipBestToolForBlock, durabilityRatio } = require('./equipment')
const { collectNearbyItems } = require('./collection')
const { assertNotCancelled, gotoWithTimeout } = require('./navigation')
const { hostileNearby } = require('./safety')
const { saveMemory } = require('./memory')

const OPTIMAL_Y = {
  diamond_ore: -58,
  deepslate_diamond_ore: -58,
  redstone_ore: -58,
  deepslate_redstone_ore: -58,
  iron_ore: 16,
  deepslate_iron_ore: 16,
  coal_ore: 96,
  copper_ore: 48,
  lapis_ore: 0,
  gold_ore: -16
}

async function mineBlocks (bot, memory, config, speaker, blockName, amount, signal) {
  const mcData = require('minecraft-data')(bot.version)
  const normalized = blockAlias(normalizeName(blockName))
  const blockIds = blockIdsForName(mcData, normalized)
  if (!blockIds.length) throw new Error(`I do not know block ${blockName}.`)

  let mined = 0
  let searchSteps = 0
  const skipped = new Set()
  const start = bot.entity.position.floored()
  rememberMiningPosition(memory, 'lastMiningStart', start)
  speaker.say('Mining started.')

  while (mined < amount && !signal.cancelled) {
    const unsafe = unsafeMiningState(bot, config, memory)
    if (unsafe) {
      speaker.say(`${unsafe}, stopping mining.`)
      break
    }

    if (!await handleMiningInventoryFull(bot, memory, config, speaker, signal, start)) break

    await ensureMiningPickaxe(bot, memory, config, speaker, signal)

    const block = await chooseLocalMiningBlock(bot, blockIds, config, signal, skipped)
    if (!block) {
      if (['stone', 'cobblestone'].includes(normalized) && searchSteps < 24) {
        searchSteps++
        const carved = await digTunnelStep(bot, facingDirection(bot), config, signal).catch(() => false)
        await collectNearbyItems(bot, config, signal, { radius: 6, attempts: 4 }).catch(() => {})
        if (carved) continue
      }
      speaker.say(`No reachable ${normalized} in this spot.`)
      break
    }

    if (!isSafeToDig(bot, block)) {
      speaker.say('That block looks unsafe to mine.')
      break
    }

    try {
      await digBlock(bot, block, config, signal)
      mined++
      if (heldPickaxeAlmostBroken(bot, config)) {
        speaker.say('Pickaxe is almost broken, stopping mining before it breaks.')
        break
      }
      await collectNearbyItems(bot, config, signal, { radius: 6, attempts: 8 })
    } catch (err) {
      if (/pickaxe|tool/i.test(err.message)) {
        speaker.say(`${shortError(err)} Stopping mining until I have a safer pickaxe.`)
        break
      } else if (err.message.includes('timed out') || err.message.includes('Digging aborted')) {
        skipped.add(positionKey(block.position))
        speaker.say('Skipping stuck block.')
      } else {
        skipped.add(positionKey(block.position))
        speaker.say('That block failed, trying another.')
      }
    }
  }

  await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8 }).catch(() => {})
  await depositInventory(bot, memory, config, 'storage', signal).catch(() => {})
  rememberMiningPosition(memory, 'lastMiningPosition', bot.entity.position)
  speaker.say(`Mining done: ${mined}/${amount}.`)
}

async function prospectMine (bot, memory, config, speaker, blockName, amount, signal, maxSteps) {
  const mcData = require('minecraft-data')(bot.version)
  const normalized = blockAlias(normalizeName(blockName))
  const blockIds = blockIdsForName(mcData, normalized)
  if (!blockIds.length) throw new Error(`I do not know block ${blockName}.`)

  const limit = maxSteps || config.mining?.prospectMaxSteps || 192
  let dir = facingDirection(bot)
  const skipped = new Set()
  let mined = 0
  let steps = 0
  const start = bot.entity.position.floored()
  rememberMiningPosition(memory, 'lastProspectStart', start)

  speaker.say(`Prospecting for ${normalized}.`, true)

  while (mined < amount && steps < limit && !signal.cancelled) {
    const unsafe = unsafeMiningState(bot, config, memory)
    if (unsafe) {
      speaker.say(`${unsafe}, stopping prospecting.`)
      break
    }
    if (!await handleMiningInventoryFull(bot, memory, config, speaker, signal, start)) break

    await ensureMiningPickaxe(bot, memory, config, speaker, signal)

    const exposed = await chooseLocalMiningBlock(bot, blockIds, config, signal, skipped)
    if (exposed) {
      try {
        await digBlock(bot, exposed, config, signal)
        mined++
        if (heldPickaxeAlmostBroken(bot, config)) {
          speaker.say('Pickaxe is almost broken, stopping before it breaks.')
          break
        }
        await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8 }).catch(() => {})
        continue
      } catch (err) {
        skipped.add(positionKey(exposed.position))
      }
    }

    let dug = await digTunnelStep(bot, dir, config, signal)
    if (!dug) {
      const alternate = await digAnyTunnelStep(bot, dir, config, signal)
      dug = Boolean(alternate)
      if (alternate) dir = alternate
    }
    if (!dug) {
      speaker.say('Tunnel is blocked or unsafe.')
      break
    }

    steps++
    await collectNearbyItems(bot, config, signal, { radius: 6, attempts: 4 }).catch(() => {})
    if (steps % (config.mining?.prospectProgressEvery || 24) === 0) {
      speaker.say(`Still prospecting: ${mined}/${amount}.`)
    }
  }

  await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8 }).catch(() => {})
  await depositInventory(bot, memory, config, 'storage', signal).catch(() => {})
  speaker.say(`Prospecting done: ${mined}/${amount}, ${steps}/${limit} steps.`, true)
}

async function smartMineResource (bot, memory, config, speaker, blockName, amount, signal) {
  const normalized = blockAlias(normalizeName(blockName))
  const targetY = optimalYFor(normalized)
  if (targetY !== null && shouldMoveToMiningLevel(bot, targetY)) {
    speaker.say(`Heading to Y ${targetY} for ${normalized}.`, true)
    await staircaseMine(bot, memory, config, speaker, targetY, signal)
  }

  rememberMiningPosition(memory, `${normalized}Start`, bot.entity.position)

  if (normalized.includes('diamond')) {
    await branchMineForResource(bot, memory, config, speaker, 'diamond', amount, signal)
    return
  }

  await prospectMine(bot, memory, config, speaker, normalized, amount, signal, config.mining?.prospectMaxSteps || 192)
}

async function stripMine (bot, memory, config, speaker, length, signal, options = {}) {
  await ensureMiningPickaxe(bot, memory, config, speaker, signal)
  const dir = facingDirection(bot)
  const targetIds = options.targetName
    ? blockIdsForName(require('minecraft-data')(bot.version), blockAlias(normalizeName(options.targetName)))
    : []
  const targetSkipped = new Set()
  let mined = 0
  speaker.say('Strip mine started.')
  const start = bot.entity.position.floored()
  rememberMiningPosition(memory, 'lastTunnelStart', start)

  for (let step = 1; step <= length && !signal.cancelled; step++) {
    const unsafe = unsafeMiningState(bot, config, memory)
    if (unsafe) {
      speaker.say(`${unsafe}, stopping strip mine.`)
      break
    }
    if (!await handleMiningInventoryFull(bot, memory, config, speaker, signal, start)) break
    await ensureMiningPickaxe(bot, memory, config, speaker, signal)

    const base = bot.entity.position.floored().offset(dir.x, 0, dir.z)
    mined += await digIfBlock(bot, base, config, signal)
    mined += await digIfBlock(bot, base.offset(0, 1, 0), config, signal)
    if (targetIds.length) mined += await mineVisibleTargets(bot, targetIds, config, signal, targetSkipped, 3)
    if (heldPickaxeAlmostBroken(bot, config)) {
      speaker.say('Pickaxe is almost broken, stopping mining before it breaks.')
      break
    }
    await collectNearbyItems(bot, config, signal, { radius: 5, attempts: 4 }).catch(() => {})
    await gotoWithTimeout(bot, new goals.GoalBlock(base.x, base.y, base.z), signal, config.behavior.minePathTimeoutMs).catch(() => {})

    if ((options.torches || hasTorches(bot)) && step % (config.mining?.torchEverySteps || 6) === 0) {
      const placedTorch = await placeTorch(bot).catch(() => false)
      if (placedTorch) await ensureMiningPickaxe(bot, memory, config, speaker, signal)
    }
  }

  await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8 }).catch(() => {})
  await depositInventory(bot, memory, config, 'storage', signal).catch(() => {})
  rememberMiningPosition(memory, 'lastMiningPosition', bot.entity.position)
  speaker.say(`Strip mine done: ${mined} blocks.`)
}

async function torchMine (bot, memory, config, speaker, length, signal) {
  await stripMine(bot, memory, config, speaker, length, signal, { torches: true })
}

async function branchMine (bot, memory, config, speaker, branches, length, signal) {
  const startYaw = bot.entity.yaw
  speaker.say('Branch mine started.')
  rememberMiningPosition(memory, 'lastBranchMineStart', bot.entity.position)
  for (let i = 0; i < branches && !signal.cancelled; i++) {
    await bot.look(startYaw, 0, true)
    await stripMine(bot, memory, config, speaker, length, signal)
    await bot.look(startYaw + (i % 2 === 0 ? Math.PI / 2 : -Math.PI / 2), 0, true)
    await stripMine(bot, memory, config, speaker, Math.max(3, Math.floor(length / 3)), signal)
    await bot.look(startYaw, 0, true)
  }
  rememberMiningPosition(memory, 'lastMiningPosition', bot.entity.position)
  speaker.say('Branch mine done.')
}

async function branchMineForResource (bot, memory, config, speaker, blockName, amount, signal) {
  const branches = config.mining?.diamondBranches || 4
  const length = config.mining?.diamondBranchLength || 32
  const target = blockAlias(normalizeName(blockName))
  speaker.say(`Branch mining for ${target}.`, true)
  const before = countTargetItems(bot, target)
  await stripMine(bot, memory, config, speaker, Math.max(8, Math.floor(length / 2)), signal, { torches: true, targetName: target })
  for (let i = 0; i < branches && !signal.cancelled; i++) {
    await branchMineForTarget(bot, memory, config, speaker, 1, length, target, signal)
    const found = countTargetItems(bot, target) - before
    if (found >= amount) break
  }
}

async function branchMineForTarget (bot, memory, config, speaker, branches, length, target, signal) {
  const startYaw = bot.entity.yaw
  for (let i = 0; i < branches && !signal.cancelled; i++) {
    await bot.look(startYaw, 0, true)
    await stripMine(bot, memory, config, speaker, length, signal, { targetName: target })
    await bot.look(startYaw + (i % 2 === 0 ? Math.PI / 2 : -Math.PI / 2), 0, true)
    await stripMine(bot, memory, config, speaker, Math.max(3, Math.floor(length / 3)), signal, { targetName: target })
    await bot.look(startYaw, 0, true)
  }
}

async function staircaseMine (bot, memory, config, speaker, targetY, signal) {
  await ensureMiningPickaxe(bot, memory, config, speaker, signal)
  let dir = facingDirection(bot)
  const maxSteps = config.mining?.staircaseMaxSteps || 96
  let steps = 0
  speaker.say('Staircase mining.')
  const start = bot.entity.position.floored()
  rememberMiningPosition(memory, 'lastStaircaseStart', start)

  while (!signal.cancelled && Math.floor(bot.entity.position.y) > targetY && steps < maxSteps) {
    assertNotCancelled(signal)
    const unsafe = unsafeMiningState(bot, config, memory)
    if (unsafe) {
      speaker.say(`${unsafe}, stopping staircase.`)
      break
    }
    if (!await handleMiningInventoryFull(bot, memory, config, speaker, signal, start)) break
    await ensureMiningPickaxe(bot, memory, config, speaker, signal)

    const carved = await digStairStep(bot, dir, config, signal)
    if (!carved) {
      const alternate = await digAnyStairStep(bot, dir, config, signal)
      if (!alternate) break
      dir = alternate
    }
    if (steps % 6 === 0) await placeTorch(bot).catch(() => {})
    steps++
  }

  rememberMiningPosition(memory, 'lastStaircase', bot.entity.position)
}

async function safeCaveExplore (bot, memory, config, speaker, steps, signal) {
  speaker.say('Checking cave safely.', true)
  const seen = new Set()
  const start = bot.entity.position.floored()
  rememberMiningPosition(memory, 'lastCaveExploreStart', start)
  for (let i = 0; i < steps && !signal.cancelled; i++) {
    const unsafe = unsafeMiningState(bot, config, memory)
    if (unsafe) {
      speaker.say(`${unsafe}, stopping cave explore.`)
      break
    }
    if (!await handleMiningInventoryFull(bot, memory, config, speaker, signal, start)) break
    const ore = findInterestingExposedOre(bot, config, seen)
    if (ore) {
      seen.add(positionKey(ore.position))
      await digBlock(bot, ore, config, signal).catch(() => {})
      await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8 }).catch(() => {})
      continue
    }
    const next = findSafeCaveStep(bot)
    if (!next) break
    await gotoWithTimeout(bot, new goals.GoalBlock(next.x, next.y, next.z), signal, config.behavior.pathTimeoutMs).catch(() => {})
    if (i % 8 === 0) await placeTorch(bot).catch(() => {})
  }
  rememberMiningPosition(memory, 'lastCaveExplore', bot.entity.position)
}

async function mineArea (bot, memory, config, speaker, width, height, depth, signal) {
  await ensureMiningPickaxe(bot, memory, config, speaker, signal)
  const dir = facingDirection(bot)
  const side = new Vec3(-dir.z, 0, dir.x)
  const origin = bot.entity.position.floored()
  let mined = 0
  speaker.say('Area mining started.')
  rememberMiningPosition(memory, 'lastAreaMineStart', origin)

  for (let z = 1; z <= depth && !signal.cancelled; z++) {
    const unsafe = unsafeMiningState(bot, config, memory)
    if (unsafe) {
      speaker.say(`${unsafe}, stopping area mine.`)
      break
    }
    if (!await handleMiningInventoryFull(bot, memory, config, speaker, signal, origin)) break
    await ensureMiningPickaxe(bot, memory, config, speaker, signal)
    for (let y = 0; y < height && !signal.cancelled; y++) {
      for (let x = -Math.floor(width / 2); x <= Math.floor(width / 2) && !signal.cancelled; x++) {
        const pos = origin.offset(dir.x * z + side.x * x, y, dir.z * z + side.z * x)
        mined += await digIfBlock(bot, pos, config, signal)
      }
    }
    await collectNearbyItems(bot, config, signal, { radius: 8, attempts: 8 }).catch(() => {})
  }

  await depositInventory(bot, memory, config, 'storage', signal).catch(() => {})
  speaker.say(`Area mining done: ${mined} blocks.`)
}

async function findExposedBlocks (bot, config, speaker, blockName) {
  const mcData = require('minecraft-data')(bot.version)
  const normalized = blockAlias(normalizeName(blockName))
  const blockInfo = mcData.blocksByName[normalized]
  if (!blockInfo) throw new Error(`I do not know block ${blockName}.`)
  const blocks = findSafeBlocks(bot, blockInfo.id, localMiningConfig(config), new Set())
  if (!blocks.length) {
    speaker.say(`No exposed ${normalized} nearby.`, true)
    return
  }
  const nearest = blocks[0].position
  speaker.say(`Found ${blocks.length} exposed ${normalized}; nearest ${nearest.x} ${nearest.y} ${nearest.z}.`, true)
}

async function chooseLocalMiningBlock (bot, blockId, config, signal, skipped) {
  const immediate = findImmediateDiggableBlock(bot, blockId, config, skipped)
  if (immediate) return immediate

  const local = await findReachableSafeBlock(bot, blockId, localMiningConfig(config), signal, skipped)
  if (local) return local

  if (config.behavior.mineAllowTravel === true) {
    return findReachableSafeBlock(bot, blockId, config, signal, skipped)
  }

  return null
}

async function findReachableSafeBlock (bot, blockId, config, signal, skipped = new Set()) {
  const blocks = findSafeBlocks(bot, blockId, config, skipped)
  for (const block of blocks) {
    assertNotCancelled(signal)
    try {
      await gotoWithTimeout(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }), signal, config.behavior.minePathTimeoutMs)
      assertNotCancelled(signal)
      if (bot.canDigBlock(block)) return block
    } catch (err) {
      if (signal.cancelled) throw err
      bot.pathfinder.stop()
    }
  }
  return null
}

function findSafeBlock (bot, blockId, config) {
  return findSafeBlocks(bot, blockId, config, new Set())[0] || null
}

function findSafeBlocks (bot, blockId, config, skipped = new Set()) {
  const blockIds = Array.isArray(blockId) ? blockId : [blockId]
  const blocks = bot.findBlocks({
    matching: block => blockIds.includes(block.type),
    maxDistance: config.behavior.mineSearchRadius,
    count: config.behavior.mineCandidateLimit || 24
  })

  return blocks
    .map(pos => bot.blockAt(pos))
    .filter(block => block && !skipped.has(positionKey(block.position)) && isSafeToDig(bot, block) && isExposed(bot, block))
    .sort((a, b) => {
      return a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
    })
}

function findImmediateDiggableBlock (bot, blockId, config, skipped = new Set()) {
  const blockIds = Array.isArray(blockId) ? blockId : [blockId]
  const lookedAt = bot.blockAtCursor(5, block => blockIds.includes(block.type))
  if (lookedAt && !skipped.has(positionKey(lookedAt.position)) && isSafeToDig(bot, lookedAt) && bot.canDigBlock(lookedAt)) return lookedAt

  return findSafeBlocks(bot, blockId, localMiningConfig(config), skipped)
    .find(block => bot.canDigBlock(block)) || null
}

async function digBlock (bot, block, config, signal) {
  assertNotCancelled(signal)
  await equipBestToolForBlock(bot, block).catch(() => null)
  if (needsPickaxe(block) && !hasPickaxeInHand(bot)) throw new Error('No pickaxe equipped')
  if (needsPickaxe(block) && heldPickaxeAlmostBroken(bot, config)) throw new Error('Pickaxe is almost broken')
  if (!bot.canDigBlock(block)) {
    await approachDigBlock(bot, block, config, signal).catch(() => {})
  }
  if (!bot.canDigBlock(block)) throw new Error('Block not reachable')
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
  await withTimeout(bot.dig(block, true, 'raycast'), config.behavior.digTimeoutMs || 15000, () => {
    try {
      bot.stopDigging()
    } catch {}
  })
  assertNotCancelled(signal)
}

function isExposed (bot, block) {
  const offsets = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]
  ]
  return offsets.some(([x, y, z]) => {
    const near = bot.blockAt(block.position.offset(x, y, z))
    return near && isPassable(near)
  })
}

function getMiningStandPositions (bot, block) {
  const offsets = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
    [0, 1, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]
  ]

  return offsets
    .map(([x, y, z]) => block.position.offset(x, y, z))
    .filter(pos => isStandable(bot, pos))
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
}

function isStandable (bot, pos) {
  const feet = bot.blockAt(pos)
  const head = bot.blockAt(pos.offset(0, 1, 0))
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  if (!feet || !head || !floor) return false
  if (!isPassable(feet) || !isPassable(head)) return false
  if (isPassable(floor)) return false
  if (floor.name.includes('lava') || floor.name.includes('water')) return false
  return true
}

function isPassable (block) {
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'
}

function isSafeToDig (bot, block) {
  if (!block || isFallingBlock(block)) return false
  const above = bot.blockAt(block.position.offset(0, 1, 0))
  if (above && isFallingBlock(above)) return false
  const offsets = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]
  ]
  for (const [x, y, z] of offsets) {
    const near = bot.blockAt(block.position.offset(x, y, z))
    if (near && (near.name.includes('lava') || near.name.includes('water'))) return false
  }
  const belowBot = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  if (!belowBot || belowBot.name === 'air') return false
  return true
}

async function digIfBlock (bot, pos, config, signal) {
  const block = bot.blockAt(pos)
  if (!block || block.name === 'air' || !block.diggable || !isSafeToDig(bot, block)) return 0
  await equipBestToolForBlock(bot, block).catch(() => null)
  if (needsPickaxe(block) && !hasPickaxeInHand(bot)) throw new Error('No pickaxe equipped')
  if (needsPickaxe(block) && heldPickaxeAlmostBroken(bot, config)) throw new Error('Pickaxe is almost broken')
  if (!bot.canDigBlock(block)) {
    await approachDigBlock(bot, block, config, signal).catch(() => {})
  }
  if (!bot.canDigBlock(block)) return 0
  await digBlock(bot, block, config, signal)
  return 1
}

async function mineVisibleTargets (bot, blockIds, config, signal, skipped, limit = 3) {
  let mined = 0
  for (let i = 0; i < limit && !signal.cancelled; i++) {
    const block = await chooseLocalMiningBlock(bot, blockIds, config, signal, skipped)
    if (!block) break
    skipped.add(positionKey(block.position))
    try {
      await digBlock(bot, block, config, signal)
      mined++
      await collectNearbyItems(bot, config, signal, { radius: 6, attempts: 4 }).catch(() => {})
    } catch {
      // Try another exposed ore next pass.
    }
  }
  return mined
}

async function approachDigBlock (bot, block, config, signal) {
  await gotoWithTimeout(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }), signal, config.behavior.minePathTimeoutMs)
    .catch(async () => {
      const stands = getMiningStandPositions(bot, block).slice(0, 6)
      for (const stand of stands) {
        assertNotCancelled(signal)
        await gotoWithTimeout(bot, new goals.GoalNear(stand.x, stand.y, stand.z, 1), signal, config.behavior.minePathTimeoutMs).catch(() => {})
        if (bot.canDigBlock(block)) return
      }
    })
}

function needsPickaxe (block) {
  return Boolean(block?.name && (
    block.name.includes('stone') ||
    block.name.includes('deepslate') ||
    block.name.includes('ore') ||
    block.name === 'cobblestone' ||
    block.name === 'netherrack' ||
    block.name === 'blackstone'
  ))
}

function hasPickaxeInHand (bot) {
  return Boolean(bot.heldItem?.name?.endsWith('_pickaxe'))
}

async function digTunnelStep (bot, dir, config, signal) {
  const base = bot.entity.position.floored().offset(dir.x, 0, dir.z)
  let dug = 0
  await ensureFloorOrBridge(bot, base, config, signal)
  dug += await digIfBlock(bot, base, config, signal)
  dug += await digIfBlock(bot, base.offset(0, 1, 0), config, signal)
  if (dug === 0 && !isPassable(bot.blockAt(base))) return false
  if (!isPassable(bot.blockAt(base.offset(0, 1, 0)))) return false
  await gotoWithTimeout(bot, new goals.GoalBlock(base.x, base.y, base.z), signal, config.behavior.minePathTimeoutMs).catch(() => {})
  return true
}

async function digAnyTunnelStep (bot, preferred, config, signal) {
  for (const dir of miningDirections(preferred)) {
    assertNotCancelled(signal)
    const dug = await digTunnelStep(bot, dir, config, signal).catch(() => false)
    if (dug) return dir
  }
  return null
}

async function digStairStep (bot, dir, config, signal) {
  const feet = bot.entity.position.floored()
  const forward = feet.offset(dir.x, 0, dir.z)
  const head = forward.offset(0, 1, 0)
  const lower = forward.offset(0, -1, 0)
  const floor = lower.offset(0, -1, 0)
  const floorBlock = bot.blockAt(floor)
  if (!floorBlock || isPassable(floorBlock) || floorBlock.name.includes('lava') || floorBlock.name.includes('water')) return false

  const clear = [head, forward, lower]
  for (const pos of clear) {
    assertNotCancelled(signal)
    const block = bot.blockAt(pos)
    if (!block || isPassable(block)) continue
    if (!block.diggable || !isSafeToDig(bot, block)) return false
    const dug = await digIfBlock(bot, pos, config, signal).catch(() => 0)
    if (!dug && !isPassable(bot.blockAt(pos))) return false
  }

  if (!isStandable(bot, lower)) return false
  await gotoWithTimeout(bot, new goals.GoalBlock(lower.x, lower.y, lower.z), signal, config.behavior.minePathTimeoutMs).catch(() => {})
  return isStandable(bot, bot.entity.position.floored()) || bot.entity.position.distanceTo(lower) < 1.6
}

async function digAnyStairStep (bot, preferred, config, signal) {
  for (const dir of miningDirections(preferred)) {
    assertNotCancelled(signal)
    const dug = await digStairStep(bot, dir, config, signal).catch(() => false)
    if (dug) return dir
  }
  return null
}

async function ensureFloorOrBridge (bot, pos, config, signal) {
  const below = bot.blockAt(pos.offset(0, -1, 0))
  if (below && !isPassable(below) && !below.name.includes('lava') && !below.name.includes('water')) return true
  const placeable = bot.inventory.items().find(item => ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'].includes(item.name))
  if (!placeable) return false
  const support = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!support || isPassable(support)) return false
  await bot.equip(placeable, 'hand')
  await bot.placeBlock(support, new Vec3(Math.sign(pos.x - bot.entity.position.x), 0, Math.sign(pos.z - bot.entity.position.z))).catch(() => {})
  return true
}

function findInterestingExposedOre (bot, config, skipped) {
  const oreNames = ['diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'redstone_ore', 'lapis_ore', 'gold_ore']
  const blocks = bot.findBlocks({
    matching: block => oreNames.includes(block.name),
    maxDistance: config.behavior.mineSearchRadius || 10,
    count: 32
  })
  return blocks
    .map(pos => bot.blockAt(pos))
    .filter(block => block && !skipped.has(positionKey(block.position)) && isSafeToDig(bot, block) && isExposed(bot, block))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
}

function findSafeCaveStep (bot) {
  const base = bot.entity.position.floored()
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  return offsets
    .map(([x, z]) => base.offset(x, 0, z))
    .find(pos => isStandable(bot, pos)) || null
}

function isFallingBlock (block) {
  return ['gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel'].includes(block?.name)
}

function optimalYFor (name) {
  const variants = oreVariants(name)
  for (const variant of variants) {
    if (typeof OPTIMAL_Y[variant] === 'number') return OPTIMAL_Y[variant]
  }
  return null
}

function shouldMoveToMiningLevel (bot, targetY) {
  return Math.abs(Math.floor(bot.entity.position.y) - targetY) > 8
}

function countTargetItems (bot, target) {
  const aliases = {
    diamond_ore: ['diamond', 'diamond_ore', 'deepslate_diamond_ore'],
    iron_ore: ['raw_iron', 'iron_ingot', 'iron_ore', 'deepslate_iron_ore'],
    coal_ore: ['coal', 'coal_ore', 'deepslate_coal_ore']
  }
  const names = aliases[target] || [target]
  return bot.inventory.items()
    .filter(item => names.includes(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

function rememberMiningPosition (memory, key, pos) {
  memory.ai = memory.ai || {}
  memory.ai.knownMining = memory.ai.knownMining || {}
  memory.ai.knownMining[key] = {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
    at: new Date().toISOString()
  }
  saveMemory(memory)
}

function withTimeout (promise, timeoutMs, onTimeout) {
  let timer
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout()
        reject(new Error('Dig timed out'))
      }, timeoutMs)
    })
  ])
}

function positionKey (pos) {
  return `${pos.x},${pos.y},${pos.z}`
}

function blockAlias (name) {
  const aliases = {
    iron: 'iron_ore',
    coal: 'coal_ore',
    diamond: 'diamond_ore',
    gold: 'gold_ore',
    copper: 'copper_ore',
    redstone: 'redstone_ore',
    lapis: 'lapis_ore',
    emerald: 'emerald_ore',
    cobble: 'stone'
  }
  return aliases[name] || name
}

function blockIdsForName (mcData, name) {
  const names = oreVariants(name)
  return names
    .map(blockName => mcData.blocksByName[blockName]?.id)
    .filter(id => typeof id === 'number')
}

function oreVariants (name) {
  const variants = {
    iron_ore: ['iron_ore', 'deepslate_iron_ore'],
    coal_ore: ['coal_ore', 'deepslate_coal_ore'],
    diamond_ore: ['diamond_ore', 'deepslate_diamond_ore'],
    gold_ore: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
    copper_ore: ['copper_ore', 'deepslate_copper_ore'],
    redstone_ore: ['redstone_ore', 'deepslate_redstone_ore'],
    lapis_ore: ['lapis_ore', 'deepslate_lapis_ore'],
    emerald_ore: ['emerald_ore', 'deepslate_emerald_ore']
  }
  return variants[name] || [name]
}

function facingDirection (bot) {
  const yaw = bot.entity.yaw
  const x = Math.round(-Math.sin(yaw))
  const z = Math.round(-Math.cos(yaw))
  if (Math.abs(x) > Math.abs(z)) return new Vec3(Math.sign(x), 0, 0)
  return new Vec3(0, 0, Math.sign(z || 1))
}

function miningDirections (preferred) {
  const dirs = [
    preferred,
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1)
  ]
  const seen = new Set()
  return dirs.filter(dir => {
    const key = `${dir.x},${dir.z}`
    if (seen.has(key)) return false
    seen.add(key)
    return !(dir.x === 0 && dir.z === 0)
  })
}

async function placeTorch (bot) {
  const torch = bot.inventory.items().find(item => item.name === 'torch')
  if (!torch) return false
  await bot.equip(torch, 'hand')
  const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!floor) return false
  await bot.placeBlock(floor, new Vec3(0, 1, 0))
  return true
}

async function ensureMiningPickaxe (bot, memory, config, speaker, signal) {
  const pickaxe = await ensurePickaxe(bot, memory, config, speaker, signal)
  if (!pickaxe || !hasPickaxeInHand(bot)) throw new Error('No usable pickaxe equipped')
  if (heldPickaxeAlmostBroken(bot, config)) throw new Error('Pickaxe is almost broken')
  return pickaxe
}

function heldPickaxeAlmostBroken (bot, config) {
  const item = bot.heldItem
  if (!item?.name?.endsWith('_pickaxe')) return false
  return durabilityRatio(item) <= pickaxeStopRatio(config)
}

function pickaxeStopRatio (config) {
  return Math.max(config.behavior?.toolDurabilityThreshold ?? 0.08, config.mining?.pickaxeStopRatio ?? 0.08)
}

async function handleMiningInventoryFull (bot, memory, config, speaker, signal, start) {
  if (hasInventorySpace(bot)) return true
  speaker.say('Inventory full, depositing junk first.')
  try {
    await depositInventory(bot, memory, config, 'storage', signal)
    if (hasInventorySpace(bot)) return true
    speaker.say('Inventory is still full after deposit, returning to mine start.')
  } catch (err) {
    speaker.say(`Inventory full and I could not deposit: ${shortError(err)}. Returning to mine start.`)
  }
  await returnToMiningStart(bot, start, config, signal).catch(() => {})
  return false
}

async function returnToMiningStart (bot, start, config, signal) {
  if (!start || bot.entity.position.distanceTo(start) <= 3) return
  await gotoWithTimeout(bot, new goals.GoalNear(start.x, start.y, start.z, 2), signal, config.behavior?.pathTimeoutMs || 6000)
}

function unsafeMiningState (bot, config, memory) {
  if (bot.health <= miningLowHealth(config)) return 'Low health'
  if ((bot.oxygenLevel ?? 20) < 8) return 'Low air'
  if (hostileNearby(bot, miningThreatRange(config), config, memory)) return 'Threat nearby'
  const feet = bot.blockAt(bot.entity.position.floored())
  if (feet && feet.name.includes('lava')) return 'Standing in lava'
  if (feet && feet.name.includes('water') && (bot.oxygenLevel ?? 20) < 18) return 'Water is unsafe'
  const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!floor || isPassable(floor) || floor.name.includes('lava')) return 'Bad footing'
  return null
}

function miningLowHealth (config) {
  return Math.max(config.behavior?.lowHealth || 0, config.mining?.lowHealth || 8)
}

function miningThreatRange (config) {
  return config.behavior?.miningMobPauseRange || config.modded?.miningThreatPauseRange || 8
}

function hasTorches (bot) {
  return bot.inventory.items().some(item => item.name === 'torch')
}

function localMiningConfig (config) {
  return {
    ...config,
    behavior: {
      ...config.behavior,
      mineSearchRadius: config.behavior.mineLocalRadius || 6,
      mineCandidateLimit: Math.min(config.behavior.mineCandidateLimit || 24, 24)
    }
  }
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)
}

module.exports = {
  mineBlocks,
  findSafeBlock,
  findImmediateDiggableBlock,
  findReachableSafeBlock,
  chooseLocalMiningBlock,
  prospectMine,
  smartMineResource,
  stripMine,
  branchMine,
  branchMineForResource,
  staircaseMine,
  safeCaveExplore,
  mineArea,
  torchMine,
  findExposedBlocks,
  getMiningStandPositions,
  isSafeToDig,
  blockAlias,
  blockIdsForName,
  oreVariants
}

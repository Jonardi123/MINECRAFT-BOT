const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { dangerousBlockNear, hostileNearby } = require('./safety')

function setupMovement (bot, config = {}) {
  const mcData = require('minecraft-data')(bot.version)
  const movements = new Movements(bot, mcData)
  bot._teammateNavConfig = config
  movements.canDig = config.behavior?.pathfinderCanDig !== false
  movements.allow1by1towers = false
  movements.allowParkour = config.behavior?.allowParkour !== false
  movements.allowSprinting = config.behavior?.allowSprinting !== false
  movements.canOpenDoors = config.behavior?.canOpenDoors === true
  movements.maxDropDown = Math.min(config.behavior?.maxDropDown ?? 2, 2)
  addBlockId(movements.blocksCantBreak, mcData.blocksByName.chest)
  addBlockId(movements.blocksCantBreak, mcData.blocksByName.trapped_chest)
  addBlockId(movements.blocksCantBreak, mcData.blocksByName.barrel)
  addBlockId(movements.liquids, mcData.blocksByName.water)
  addBlockId(movements.liquids, mcData.blocksByName.lava)
  bot.pathfinder.thinkTimeout = config.behavior?.pathThinkTimeoutMs ?? 1500
  bot.pathfinder.tickTimeout = config.behavior?.pathTickTimeoutMs ?? 45
  bot.pathfinder.searchRadius = config.behavior?.pathSearchRadius ?? 64
  bot.pathfinder.setMovements(movements)
  setupAutoJump(bot, config)
}

async function goNear (bot, pos, range = 2, signal, timeoutMs = 6000) {
  assertNotCancelled(signal)
  await gotoWithTimeout(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), signal, timeoutMs)
  assertNotCancelled(signal)
}

async function followPlayer (bot, player, signal, config = {}) {
  const tickMs = config.behavior?.followTickMs ?? 300
  const followDistance = Math.max(config.behavior?.followDistance ?? 3, 3)
  const comfortDistance = followDistance + 0.7
  const tooCloseDistance = Math.max(1.8, followDistance - 1)
  const stuckAfterMs = Math.max(config.behavior?.stuckAfterMs ?? 5000, 5000)
  let lastPosition = bot.entity.position.clone()
  let lastMovedAt = Date.now()
  let lastGoalAt = 0

  setFollowGoal(bot, player, followDistance)

  while (!signal.cancelled && player.isValid) {
    const moved = bot.entity.position.distanceTo(lastPosition)
    if (moved > 0.35) {
      lastPosition = bot.entity.position.clone()
      lastMovedAt = Date.now()
    }

    const distance = bot.entity.position.distanceTo(player.position)
    if (distance < tooCloseDistance) {
      bot.pathfinder.stop()
      if (safeBehind(bot)) await backAwayFrom(bot, player.position, 350)
      lastMovedAt = Date.now()
    } else if (distance > comfortDistance && Date.now() - lastGoalAt > 1200) {
      setFollowGoal(bot, player, followDistance)
      lastGoalAt = Date.now()
    }

    if (distance > comfortDistance && Date.now() - lastMovedAt > stuckAfterMs) {
      await recoverFromStuck(bot, signal, { jump: usefulJumpNearby(bot), backMs: 400 })
      setFollowGoal(bot, player, followDistance)
      lastMovedAt = Date.now()
    }

    await sleep(tickMs)
  }
  stopMoving(bot)
}

async function rushToPlayer (bot, player, signal, config = {}) {
  const timeoutAt = Date.now() + (config.behavior?.comeTimeoutMs || 20000)
  const range = config.behavior?.comeDistance || 2
  while (!signal.cancelled && player.isValid && Date.now() < timeoutAt) {
    const distance = bot.entity.position.distanceTo(player.position)
    if (distance <= range + 0.5) return
    bot.pathfinder.setGoal(new goals.GoalFollow(player, range), true)
    bot.setControlState('sprint', true)
    bot.setControlState('jump', usefulJumpNearby(bot))
    await sleep(200)
    bot.setControlState('jump', false)
  }
  stopMoving(bot)
  if (player.isValid && bot.entity.position.distanceTo(player.position) > range + 1) {
    throw new Error('I could not reach you.')
  }
}

async function wanderNearHome (bot, memory, config, speaker, signal = { cancelled: false }) {
  const home = getHomePosition(memory, config)
  if (!home) return
  const radius = config.behavior.idleWanderRadius
  const target = home.offset(randomInt(-radius, radius), 0, randomInt(-radius, radius))
  if (hostileNearby(bot, 10) || dangerousBlockNear(bot, target)) return
  const block = bot.blockAt(target)
  const safeY = block ? block.position.y + 1 : home.y
  await goNear(bot, new Vec3(target.x, safeY, target.z), 2, signal, config.behavior.pathTimeoutMs)
    .catch(() => {})
}

function getHomePosition (memory, config) {
  const home = memory.home || config.positions.home
  if (!home) return null
  return new Vec3(home.x, home.y, home.z)
}

function stopMoving (bot) {
  if (bot.pathfinder) bot.pathfinder.stop()
  bot.setControlState('jump', false)
  bot.setControlState('sprint', false)
  bot.setControlState('back', false)
  bot.setControlState('forward', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.clearControlStates()
}

async function gotoWithTimeout (bot, goal, signal, timeoutMs = 6000) {
  assertNotCancelled(signal)
  const config = bot._teammateNavConfig || {}
  const attempts = config.behavior?.pathRecoveryAttempts ?? 2
  const startedAt = Date.now()
  let lastError = null

  for (let attempt = 0; attempt <= attempts; attempt++) {
    assertNotCancelled(signal)
    const elapsed = Date.now() - startedAt
    const remaining = timeoutMs - elapsed
    if (remaining <= 0) break
    try {
      await gotoOnce(bot, goal, signal, remaining, config)
      assertNotCancelled(signal)
      return
    } catch (err) {
      if (signal?.cancelled) throw err
      lastError = err
      stopMoving(bot)
      if (attempt < attempts) await recoverFromStuck(bot, signal, { jump: usefulJumpNearby(bot), backMs: 350 })
    }
  }

  throw new Error(`Cannot reach target: ${shortError(lastError || 'path timed out')}`)
}

function randomInt (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function assertNotCancelled (signal) {
  if (signal?.cancelled) throw new Error('Task cancelled')
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function addBlockId (set, block) {
  if (block && typeof block.id === 'number') set.add(block.id)
}

function setupAutoJump (bot, config = {}) {
  if (config.behavior?.autoJump === false || bot._teammateAutoJumpTimer) return

  const tickMs = config.behavior?.autoJumpTickMs ?? 180
  const stuckMs = config.behavior?.autoJumpStuckMs ?? 700
  const holdMs = config.behavior?.autoJumpHoldMs ?? 350
  let lastPos = bot.entity.position.clone()
  let lastMovedAt = Date.now()
  let jumpUntil = 0

  bot._teammateAutoJumpTimer = setInterval(() => {
    try {
      if (!bot.entity) return

      const moved = bot.entity.position.distanceTo(lastPos)
      if (moved > 0.08) {
        lastPos = bot.entity.position.clone()
        lastMovedAt = Date.now()
      }

      const pathing = Boolean(bot.pathfinder?.goal || bot.pathfinder?.isMoving?.())
      const moving = getControl(bot, 'forward') || getControl(bot, 'sprint') || pathing
      const stuck = moving && Date.now() - lastMovedAt > stuckMs
      const stepNearby = hasClimbableStepNearby(bot)

      if (bot.entity.onGround && (stepNearby || stuck)) jumpUntil = Date.now() + holdMs

      const jumping = moving && Date.now() < jumpUntil
      safeSetControl(bot, 'jump', jumping)
    } catch (err) {
      console.error('[autojump]', err.message)
      safeSetControl(bot, 'jump', false)
    }
  }, tickMs)

  bot.once('end', () => {
    clearInterval(bot._teammateAutoJumpTimer)
    bot._teammateAutoJumpTimer = null
  })
}

async function gotoOnce (bot, goal, signal, timeoutMs, config = {}) {
  let timer = null
  let monitor = null
  let lastPosition = bot.entity.position.clone()
  let lastMovedAt = Date.now()
  const stuckAfterMs = Math.max(config.behavior?.stuckAfterMs ?? 5000, 5000)

  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      bot.pathfinder.stop()
      reject(new Error('Path timed out'))
    }, timeoutMs)
  })

  const stuckPromise = new Promise((resolve, reject) => {
    monitor = setInterval(() => {
      try {
        if (signal?.cancelled) {
          clearInterval(monitor)
          reject(new Error('Task cancelled'))
          return
        }
        const moved = bot.entity.position.distanceTo(lastPosition)
        if (moved > 0.25) {
          lastPosition = bot.entity.position.clone()
          lastMovedAt = Date.now()
          return
        }
        if (Date.now() - lastMovedAt > stuckAfterMs) {
          bot.pathfinder.stop()
          reject(new Error('Path stuck'))
        }
      } catch (err) {
        reject(err)
      }
    }, 500)
  })

  try {
    await Promise.race([bot.pathfinder.goto(goal), timeoutPromise, stuckPromise])
  } finally {
    if (timer) clearTimeout(timer)
    if (monitor) clearInterval(monitor)
  }
}

async function recoverFromStuck (bot, signal = { cancelled: false }, options = {}) {
  assertNotCancelled(signal)
  stopMoving(bot)
  const backMs = options.backMs ?? 350
  if (backMs > 0 && safeBehind(bot)) {
    bot.setControlState('back', true)
    if (nearDangerousBlock(bot)) bot.setControlState('sneak', true)
    await sleep(backMs)
    bot.setControlState('back', false)
    bot.setControlState('sneak', false)
  }
  if (options.jump && bot.entity.onGround) {
    bot.setControlState('jump', true)
    await sleep(180)
    bot.setControlState('jump', false)
  }
  assertNotCancelled(signal)
}

async function backAwayFrom (bot, pos, ms = 300) {
  const dx = bot.entity.position.x - pos.x
  const dz = bot.entity.position.z - pos.z
  const yaw = Math.atan2(-dx, -dz)
  await bot.look(yaw, 0, true).catch(() => {})
  bot.setControlState('back', true)
  await sleep(ms)
  bot.setControlState('back', false)
}

function setFollowGoal (bot, player, distance) {
  bot.pathfinder.setGoal(new goals.GoalFollow(player, distance), true)
}

function usefulJumpNearby (bot) {
  return bot.entity?.onGround && hasClimbableStepNearby(bot)
}

function safeBehind (bot) {
  const yaw = bot.entity.yaw
  const backX = Math.round(Math.sin(yaw))
  const backZ = Math.round(Math.cos(yaw))
  const pos = bot.entity.position.floored().offset(backX, 0, backZ)
  return isSafeStandPosition(bot, pos)
}

function isSafeStandPosition (bot, pos) {
  const feet = bot.blockAt(pos)
  const head = bot.blockAt(pos.offset(0, 1, 0))
  const floor = bot.blockAt(pos.offset(0, -1, 0))
  if (!feet || !head || !floor) return false
  if (!isPassable(feet) || !isPassable(head)) return false
  if (isPassable(floor) || isLiquid(floor) || floor.name === 'magma_block') return false
  if (dangerousBlockNear(bot, pos)) return false
  return true
}

function nearDangerousBlock (bot) {
  return dangerousBlockNear(bot, bot.entity.position.floored())
}

function hasStepInFront (bot) {
  const yaw = bot.entity.yaw
  const dirX = Math.round(-Math.sin(yaw))
  const dirZ = Math.round(-Math.cos(yaw))
  if (dirX === 0 && dirZ === 0) return false

  const base = bot.entity.position.floored()
  const frontFeet = bot.blockAt(base.offset(dirX, 0, dirZ))
  const frontHead = bot.blockAt(base.offset(dirX, 1, dirZ))
  const aboveFront = bot.blockAt(base.offset(dirX, 2, dirZ))
  const currentHead = bot.blockAt(base.offset(0, 1, 0))

  if (!frontFeet || !frontHead || !aboveFront || !currentHead) return false
  if (isPassable(frontFeet)) return false
  return isPassable(frontHead) && isPassable(aboveFront) && isPassable(currentHead)
}

function hasClimbableStepNearby (bot) {
  if (hasStepInFront(bot)) return true

  const base = bot.entity.position.floored()
  const checks = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1]
  ]

  return checks.some(([x, z]) => {
    const feet = bot.blockAt(base.offset(x, 0, z))
    const head = bot.blockAt(base.offset(x, 1, z))
    const above = bot.blockAt(base.offset(x, 2, z))
    if (!feet || !head || !above) return false
    return !isPassable(feet) && isPassable(head) && isPassable(above)
  })
}

function isPassable (block) {
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'
}

function isLiquid (block) {
  const name = block?.name || ''
  return name.includes('water') || name.includes('lava')
}

function getControl (bot, control) {
  if (typeof bot.getControlState === 'function') return bot.getControlState(control)
  return Boolean(bot.controlState?.[control])
}

function safeSetControl (bot, control, state) {
  if (typeof bot.setControlState === 'function') bot.setControlState(control, state)
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)
}

module.exports = {
  setupMovement,
  goNear,
  followPlayer,
  rushToPlayer,
  wanderNearHome,
  getHomePosition,
  stopMoving,
  gotoWithTimeout,
  recoverFromStuck,
  isSafeStandPosition,
  sleep,
  assertNotCancelled
}

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

const { loadConfig } = require('./lib/configLoader')
const config = loadConfig()
const { loadMemory, saveMemory, rememberPlayer, setPosition, setChest } = require('./lib/memory')
const { createSpeaker } = require('./lib/speaker')
const { createTaskManager } = require('./lib/taskManager')
const { setupMovement, goNear, followPlayer, rushToPlayer, stopMoving, wanderNearHome, getHomePosition } = require('./lib/navigation')
const { summarizeInventory, dropItemToPlayer, findItem, normalizeName } = require('./lib/inventory')
const { findChestPositionNearLook, depositInventory, checkSupplies } = require('./lib/chest')
const { ensurePickaxe, equipBestArmor, equipBestArmorFromInventory } = require('./lib/equipment')
const { mineBlocks, prospectMine, smartMineResource, stripMine, branchMine, branchMineForResource, staircaseMine, safeCaveExplore, mineArea, torchMine, findExposedBlocks } = require('./lib/mining')
const { farmTarget } = require('./lib/farming')
const { createProtector } = require('./lib/protection')
const { getStatus } = require('./lib/status')
const { createBrain } = require('./lib/brain')
const { createSelfModel } = require('./lib/selfModel')
const { bootstrapSurvival, survivalLoop, gatherWood, gatherStarterStone, craftStarterKit } = require('./lib/survival')
const { createPvpController } = require('./lib/pvp')
const { equipBestWeapon, equipBestShield, equipBestTotem, recoverDangerousFall, createFallRecoveryState } = require('./lib/combat')
const { buildStarterCamp, buildEmergencyShelter, buildBase, buildFancyBase } = require('./lib/building')
const { normalizePaletteName } = require('./lib/baseBlueprints')
const { cookFood, makeBedAndSetSpawn, sleepInOwnBed } = require('./lib/domestic')
const { runDiamondBeaconObjective, beaconStatus, setBeaconSite } = require('./lib/beaconObjective')
const { createMobDefenseController } = require('./lib/mobDefense')
const { createSurvivalDispatcher } = require('./lib/survivalDispatcher')
const { createAiController } = require('./lib/aiController')
const { getLlmStatus } = require('./lib/llmStatus')
const { executeAiAction } = require('./lib/aiActions')
const { startAutopilot, autoplayStatus } = require('./lib/autopilot')
const { recordDamage, recordDeath, rewardSummary } = require('./lib/rewardSystem')
const { adaptiveThreatSummary, recordDamageMemory } = require('./lib/modThreat')
const { loadOptionalPlugins } = require('./lib/pluginLoader')
const { createDashboardServer } = require('./lib/dashboard')
const { createGoalPlanner, formatPlannerStatus } = require('./lib/goalPlanner')
const { runPlannerRecommendation } = require('./lib/goalExecutor')
const { scanStockpiles, formatStockpileScan } = require('./lib/stockpile')
const {
  extractServerVersionMismatch,
  extractUnsupportedVersion,
  isSupportedJavaVersion,
  serverRequiresVersionMessage,
  unsupportedVersionMessage
} = require('./lib/versionSupport')

let bot
let reconnectTimer = null
let idleTimer = null
let shuttingDown = false
let fatalStartupError = false
let fatalMessagePrinted = false
let dashboardServer = null

const memory = loadMemory(config)
const recentCommands = new Map()

function createBot () {
  if (!isSupportedJavaVersion(config.server.version)) {
    fatalStartupError = true
    console.error(`[config] ${unsupportedVersionMessage(config.server.version)}`)
    return
  }

  bot = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    version: config.server.version === 'auto' ? false : config.server.version,
    username: config.bot.username,
    auth: config.bot.auth || 'offline',
    hideErrors: true,
    logErrors: false
  })

  bot.loadPlugin(pathfinder)
  loadOptionalPlugins(bot, config)

  const speaker = createSpeaker(bot, config)
  const tasks = createTaskManager(bot, speaker, config)
  const protector = createProtector(bot, speaker, config, memory)
  const brain = createBrain(bot, config, memory, speaker, tasks, protector)
  const selfModel = createSelfModel(bot, memory, config, tasks, { protector })
  const pvp = createPvpController(bot, speaker, config, tasks)
  const mobDefense = createMobDefenseController(bot, speaker, config, tasks, memory, async signal => {
    await startAutopilot(bot, memory, config, speaker, tasks, signal, {})
  })
  const ai = createAiController(bot, config, memory, speaker, tasks, protector, pvp)
  const dispatcher = createSurvivalDispatcher(bot, memory, config, speaker, tasks, {
    pvp,
    mobDefense,
    resumeAutoplay: async signal => startAutopilot(bot, memory, config, speaker, tasks, signal, {})
  })
  const planner = createGoalPlanner(bot, memory, config, tasks)
  const dashboardContext = {
    bot,
    memory,
    config,
    tasks,
    protector,
    pvp,
    mobDefense,
    dispatcher,
    ai,
    planner,
    runCommand: async (username, message) => {
      if (!isAllowed(username)) throw new Error(`${username} is not in allowedPlayers.`)
      await runCommand(username, message, speaker, tasks, protector, brain, pvp, mobDefense, dispatcher, ai, planner)
    }
  }
  if (dashboardServer) dashboardServer.updateContext(dashboardContext)
  else dashboardServer = createDashboardServer(dashboardContext)
  let lastHealth = 20
  let gearTimer = null
  let beaconResumeTimer = null
  let realPlayerSpawnedAt = 0
  let lastRealPlayerAutoplayAt = 0
  const globalFallRecovery = {
    state: createFallRecoveryState(),
    busy: false,
    lastErrorAt: 0
  }

  bot.once('spawn', () => {
    setupMovement(bot, config)
    applyKeepInventoryRecoveryPatch(memory, config)
    speaker.say('I am online.')
    console.log(`[bot] Spawned as ${bot.username}`)
    ai.start()
    dispatcher.start()
    realPlayerSpawnedAt = Date.now()
    if (realPlayerModeEnabled()) {
      pvp.start()
      if (config.mobDefense?.enabledByDefault !== false) mobDefense.start()
      ensureRealPlayerGoal()
    }
    gearTimer = setInterval(() => {
      if (!isFallRecoveryActive(bot)) {
        equipBestArmorFromInventory(bot, config).catch(err => console.error('[armor]', err.message))
      }
      if (shouldPreferTotemLoadout(bot, config) || bot.health <= (config.pvp?.totemHealth || 7)) {
        equipBestTotem(bot).catch(err => console.error('[totem]', err.message))
      } else {
        equipBestShield(bot).catch(err => console.error('[shield]', err.message))
      }
    }, 2000)
    beaconResumeTimer = setInterval(() => {
      resumeBeaconObjectiveIfNeeded(tasks, speaker, pvp, mobDefense, dispatcher).catch(err => console.error('[beacon resume]', err.message))
    }, config.beaconObjective?.resumeCheckMs || 15000)
    lastHealth = bot.health || 20
  })

  bot.on('chat', async (username, message) => {
    if (username === bot.username) return
    if (!message.startsWith('!')) {
      await runChat(username, message, brain, ai, speaker, tasks, mobDefense)
      return
    }
    await runCommand(username, message, speaker, tasks, protector, brain, pvp, mobDefense, dispatcher, ai, planner)
  })

  bot.on('messagestr', async message => {
    const parsed = parseChatLine(message)
    if (!parsed || parsed.username === bot.username) return
    if (!parsed.message.startsWith('!')) {
      await runChat(parsed.username, parsed.message, brain, ai, speaker, tasks, mobDefense)
      return
    }
    await runCommand(parsed.username, parsed.message, speaker, tasks, protector, brain, pvp, mobDefense, dispatcher, ai, planner)
  })

  async function runChat (username, message, brain, ai, speaker, tasks, mobDefense) {
    if (!isAllowed(username)) return
    if (isDuplicateCommand(username, message)) return
    rememberPlayer(memory, username, bot.players[username]?.entity?.position)
    if (naturalAutoplay(message)) {
      ai.pause('Autoplay requested')
      await tasks.start('autoplay', async signal => {
        await startAutopilot(bot, memory, config, speaker, tasks, signal, {})
      })
      return
    }
    const directTask = naturalDirectTask(message, username, mobDefense)
    if (directTask) {
      ai.pause(`Natural task ${directTask.name}`)
      try {
        await tasks.start(directTask.name, async signal => {
          if (directTask.say) speaker.say(directTask.say, true)
          await directTask.run(signal, speaker)
        })
      } catch (err) {
        console.error(`[natural task] ${directTask.name} failed`, err)
        speaker.say(`I hit a problem: ${shortError(err)}`, true)
      }
      return
    }
    const goal = naturalObjective(message)
    if (goal) {
      ai.setGoal(goal)
      speaker.say('Got it. I will work on that.', true)
      return
    }
    await brain.handleChat(username, message)
  }

  async function runCommand (username, message, speaker, tasks, protector, brain, pvp, mobDefense, dispatcher, ai, planner) {
    if (isDuplicateCommand(username, message)) return
    rememberPlayer(memory, username, bot.players[username]?.entity?.position)

    if (!isAllowed(username)) {
      speaker.whisper(username, 'Sorry, I only take commands from allowed players.')
      return
    }

    const args = message.trim().split(/\s+/)
    const command = args.shift().slice(1).toLowerCase()
    const player = bot.players[username]?.entity
    console.log(`[chat] ${username}: !${command} ${args.join(' ')}`.trim())

    if (command === 'chat') {
      const said = await brain.handleChat(username, args.join(' '), true)
      if (!said) speaker.say('Say something after !chat.', true)
      return
    }

    if (![
      'status',
      'notes',
      'botstash',
      'aistatus',
      'llmstatus',
      'autoplaystatus',
      'brainstatus',
      'rewardstatus',
      'realplayer',
      'realplayeron',
      'realplayeroff',
      'realplayerstatus',
      'self',
      'reflect',
      'risk',
      'modstatus',
      'beaconstatus',
      'pvpon',
      'pvpoff',
      'mobdefenseon',
      'mobdefenseoff',
      'mobdefensestatus',
      'dispatcherstatus',
      'plannerstatus',
      'stockpiles',
      'goals',
      'protect',
      'protectoff'
    ].includes(command)) {
      ai.pause(`Manual command !${command}`)
    }

    try {
      await handleCommand({ command, args, username, player, speaker, tasks, protector, pvp, mobDefense, dispatcher, ai, planner })
    } catch (err) {
      console.error(`[command] ${command} failed`, err)
      speaker.say(`I hit a problem: ${shortError(err)}`, true)
      tasks.stop()
    }
  }

  bot.on('death', () => {
    speaker.say('I died. Regrouping.')
    rememberDeathLesson(memory, bot, tasks, config)
    recordDeath(memory, bot, tasks, guessDeathCause(bot))
    tasks.recordDeath()
    setTimeout(() => {
      try {
        bot.respawn()
      } catch (err) {
        console.error('[respawn]', err.message)
      }
    }, 1200)
  })

  bot.on('health', () => {
    recordDamage(memory, bot, lastHealth, bot.health)
    recordDamageMemory(bot, memory, lastHealth, bot.health, config)
    lastHealth = bot.health || lastHealth
    // This server uses keepInventory, so low health must not become an infinite flee/stop loop.
    // Let combat/mining/autopilot continue unless a specific skill decides lava/void/etc. is unsafe.
    if (isKeepInventoryMode(config)) return
    if (bot.health <= config.behavior.criticalHealth && tasks.currentTask && tasks.currentTask !== 'autoplay') {
      speaker.say('Low health, stopping.')
      tasks.stop()
    }
  })

  bot.on('physicsTick', () => {
    if (config.pvp?.globalFallRecovery === false) return
    if (!bot.entity || bot.entity.onGround || bot.health <= 0) return
    if (pvp.active || globalFallRecovery.busy) return
    const fallingFast = (bot.entity.velocity?.y || 0) < -0.14
    const fallingFar = Number(bot.entity.fallDistance || 0) > 2.2
    const glidingDown = Boolean(bot.entity.elytraFlying)
    if (!fallingFast && !fallingFar && !glidingDown) return

    globalFallRecovery.busy = true
    recoverDangerousFall(bot, config, null, { state: globalFallRecovery.state })
      .catch(err => {
        const now = Date.now()
        if (now - globalFallRecovery.lastErrorAt > 5000) {
          console.error('[fall recovery]', err.message)
          globalFallRecovery.lastErrorAt = now
        }
      })
      .finally(() => {
        globalFallRecovery.busy = false
      })
  })

  bot.on('playerCollect', collector => {
    if (collector?.id !== bot.entity?.id) return
    setTimeout(() => {
      if (!isFallRecoveryActive(bot)) {
        equipBestArmorFromInventory(bot, config).catch(err => console.error('[armor]', err.message))
      }
      if (bot.health <= (config.pvp?.totemHealth || 7)) {
        equipBestTotem(bot).catch(err => console.error('[totem]', err.message))
      } else {
        equipBestShield(bot).catch(err => console.error('[shield]', err.message))
      }
      if (pvp.active || mobDefense.active || dispatcher.active) {
        equipBestWeapon(bot).catch(err => console.error('[weapon]', err.message))
      }
    }, 250)
  })

  bot.on('kicked', reason => {
    const mismatch = extractServerVersionMismatch(reason)
    if (mismatch) {
      stopForFatalVersionError(serverRequiresVersionMessage(mismatch.serverVersion, mismatch.clientVersion || config.server.version))
      return
    }
    console.log('[bot] Kicked:', reason)
  })
  bot.on('error', err => {
    const unsupportedVersion = extractUnsupportedVersion(err)
    if (unsupportedVersion) {
      stopForFatalVersionError(unsupportedVersionMessage(unsupportedVersion))
      return
    }
    const mismatch = extractServerVersionMismatch(err)
    if (mismatch) {
      stopForFatalVersionError(serverRequiresVersionMessage(mismatch.serverVersion, mismatch.clientVersion || config.server.version))
      return
    }
    console.error('[bot] Error:', err.message)
  })
  bot.on('end', () => {
    console.log('[bot] Disconnected.')
    tasks.stop()
    protector.stop()
    pvp.stop()
    mobDefense.stop()
    dispatcher.stop()
    ai.shutdown()
    if (idleTimer) clearInterval(idleTimer)
    if (gearTimer) clearInterval(gearTimer)
    if (beaconResumeTimer) clearInterval(beaconResumeTimer)
    if (!shuttingDown && !fatalStartupError && config.bot.reconnect) scheduleReconnect()
  })

  if (idleTimer) clearInterval(idleTimer)
  idleTimer = setInterval(() => {
    if (!bot?.entity || tasks.currentTask || protector.enabled) return
    brain.maybeIdleThought()
    maybeStartRealPlayerAutonomy(ai, speaker, tasks, pvp, mobDefense).catch(err => console.error('[real-player]', err.message))
    if (config.behavior.idleWander && Math.random() < 0.2) {
      wanderNearHome(bot, memory, config, speaker).catch(() => {})
    }
  }, 15000)

  async function maybeStartRealPlayerAutonomy (ai, speaker, tasks, pvp, mobDefense) {
    if (!realPlayerModeEnabled()) return
    if (config.autonomy?.autoStartAutoplay === false) return
    if (!bot?.entity || tasks.currentTask || pvp.active || mobDefense.active) return
    const realPlayer = ensureRealPlayerMemory()
    if (Date.now() < (realPlayer.suppressedUntil || 0)) return
    const delayMs = config.autonomy?.idleAutoplayDelayMs ?? 20000
    if (Date.now() - realPlayerSpawnedAt < delayMs) return
    const cooldownMs = config.autonomy?.idleAutoplayCooldownMs ?? 45000
    if (Date.now() - lastRealPlayerAutoplayAt < cooldownMs) return

    lastRealPlayerAutoplayAt = Date.now()
    realPlayer.lastStartedAt = new Date().toISOString()
    realPlayer.lastMode = 'idle_autoplay'
    ensureRealPlayerGoal()
    saveMemory(memory)

    pvp.start()
    mobDefense.start()
    ai.pause('Real-player idle autonomy')
    tasks.start('autoplay', async signal => {
      speaker.say('Real-player mode: working on survival progress.', true)
      await startAutopilot(bot, memory, config, speaker, tasks, signal, { minutes: realPlayerMinutes() })
    }).catch(err => {
      const current = ensureRealPlayerMemory()
      current.lastError = shortError(err)
      current.lastFailedAt = new Date().toISOString()
      saveMemory(memory)
      console.error('[real-player autoplay]', err)
    })
  }

  function realPlayerModeEnabled () {
    const stored = memory.ai?.realPlayer?.enabled
    if (stored === true) return true
    if (stored === false) return false
    return config.autonomy?.enabledByDefault === true
  }

  function setRealPlayerMode (enabled) {
    const realPlayer = ensureRealPlayerMemory()
    realPlayer.enabled = Boolean(enabled)
    realPlayer.lastChangedAt = new Date().toISOString()
    if (enabled) realPlayer.suppressedUntil = 0
    saveMemory(memory)
  }

  function ensureRealPlayerMemory () {
    memory.ai = memory.ai || {}
    memory.ai.realPlayer = memory.ai.realPlayer || {}
    return memory.ai.realPlayer
  }

  function ensureRealPlayerGoal () {
    const goal = config.autonomy?.defaultObjective
    if (!goal) return
    memory.ai = memory.ai || {}
    const current = String(memory.ai.currentGoal || '').trim().toLowerCase()
    if (!current || current === 'get an axe') {
      memory.ai.currentGoal = goal
      saveMemory(memory)
    }
  }

  function realPlayerMinutes () {
    return clampNumber(Number(config.autonomy?.idleAutoplayMinutes || 10), 1, 240)
  }

  function realPlayerStatus () {
    const realPlayer = ensureRealPlayerMemory()
    return [
      `real-player ${realPlayerModeEnabled() ? 'on' : 'off'}`,
      `autostart ${config.autonomy?.autoStartAutoplay === false ? 'off' : 'on'}`,
      `minutes ${realPlayerMinutes()}`,
      memory.ai?.currentGoal ? `goal ${String(memory.ai.currentGoal).slice(0, 80)}` : null,
      realPlayer.lastError ? `last error ${realPlayer.lastError}` : null
    ].filter(Boolean).join(', ')
  }

  async function handleCommand (ctx) {
    const { command, args, username, player, speaker, tasks, protector, pvp, mobDefense, dispatcher, ai, planner } = ctx

    if (command === 'stop') {
      protector.stop()
      pvp.cancel()
      mobDefense.cancel()
      dispatcher.cancel(30000)
      ai.pause('Stopped by player')
      tasks.stop()
      memory.ai = memory.ai || {}
      memory.ai.realPlayer = memory.ai.realPlayer || {}
      memory.ai.realPlayer.suppressedUntil = Date.now() + 60000
      memory.ai.director = memory.ai.director || {}
      memory.ai.director.mode = 'stopped'
      memory.ai.director.currentStep = null
      memory.ai.director.resumeAfterInterrupt = null
      memory.ai.beaconPyramid = memory.ai.beaconPyramid || {}
      memory.ai.beaconPyramid.mode = 'stopped'
      memory.ai.beaconPyramid.blockedReason = null
      saveMemory(memory)
      speaker.say('Stopping.', true)
      return
    }

    if (command === 'stopbuild') {
      if (tasks.currentTask && tasks.currentTask.includes('build')) {
        tasks.stop()
        speaker.say('Build stopped.', true)
      } else {
        speaker.say('No build is running.', true)
      }
      return
    }

    if (command === 'dispatcheroff') {
      dispatcher.disable()
      speaker.say('Survival dispatcher off.', true)
      return
    }

    if (command === 'dispatcheron') {
      dispatcher.enable()
      speaker.say('Survival dispatcher on.', true)
      return
    }

    if (command === 'autoplay' || command === 'selfplay') {
      const minutes = args[0] ? clampNumber(parseInt(args[0], 10) || 0, 1, 240) : 0
      ai.pause('Autoplay running')
      await tasks.start('autoplay', async signal => {
        await startAutopilot(bot, memory, config, speaker, tasks, signal, { minutes })
      })
      return
    }

    if (command === 'autoplayoff' || command === 'selfplayoff') {
      if (tasks.currentTask === 'autoplay') tasks.stop()
      memory.ai = memory.ai || {}
      memory.ai.autopilot = memory.ai.autopilot || {}
      memory.ai.autopilot.mode = 'stopped'
      memory.ai.autopilot.activeSkill = null
      saveMemory(memory)
      speaker.say('Autoplay off.', true)
      return
    }

    if (command === 'autoplaystatus' || command === 'selfplaystatus' || command === 'brainstatus') {
      speaker.say(autoplayStatus(memory), true)
      return
    }

    if (command === 'realplayer' || command === 'realplayeron') {
      setRealPlayerMode(true)
      pvp.start()
      mobDefense.start()
      ensureRealPlayerGoal()
      const minutes = args[0] ? clampNumber(parseInt(args[0], 10) || 0, 1, 240) : realPlayerMinutes()
      ai.pause('Real-player self-play running')
      await tasks.start('realplayer', async signal => {
        speaker.say(`Real-player mode on for ${minutes} min.`, true)
        await startAutopilot(bot, memory, config, speaker, tasks, signal, { minutes })
      })
      return
    }

    if (command === 'realplayeroff') {
      setRealPlayerMode(false)
      if (tasks.currentTask === 'autoplay' || tasks.currentTask === 'realplayer') tasks.stop()
      speaker.say('Real-player mode off.', true)
      return
    }

    if (command === 'realplayerstatus') {
      speaker.say(realPlayerStatus(), true)
      return
    }

    if (command === 'rewardstatus') {
      const summary = rewardSummary(memory)
      speaker.say(`Rewards food ${summary.priorities.foodPriority}, safety ${summary.priorities.safetyPriority}, stuck ${summary.priorities.avoidStuckBehavior}.`, true)
      return
    }

    if (command === 'self' || command === 'selfstatus') {
      speaker.say(selfModel.line(), true)
      selfModel.rememberReflection('self command')
      saveMemory(memory)
      return
    }

    if (command === 'reflect') {
      speaker.say(selfModel.reflection(), true)
      selfModel.rememberReflection('reflect command')
      saveMemory(memory)
      return
    }

    if (command === 'risk') {
      const self = selfModel.snapshot()
      const risks = self.risks.slice(0, 4).map(risk => `${risk.name}:${risk.detail}`)
      speaker.say(risks.length ? `Risks: ${risks.join(', ')}. Next: ${self.nextBestAction}.` : `Risks: stable. Next: ${self.nextBestAction}.`, true)
      return
    }

    if (command === 'modstatus') {
      const threats = adaptiveThreatSummary(bot, config, memory, config.modded?.threatScanRange || 24)
      const observed = Object.entries(memory.ai?.moddedThreats?.observed || {})
        .sort((a, b) => (b[1].maxScore || 0) - (a[1].maxScore || 0))
        .slice(0, 3)
        .map(([name, info]) => `${name}:${info.level || 'watch'}:${info.maxScore || 0}`)
      const live = threats.slice(0, 3).map(threat => `${threat.name}:${threat.level}:${threat.score}`)
      speaker.say(`Mod threats live ${live.join(', ') || 'none'} | learned ${observed.join(', ') || 'none'}.`, true)
      return
    }

    if (command === 'beaconstatus' || command === 'diamondbeaconstatus') {
      speaker.say(beaconStatus(memory), true)
      return
    }

    if (command === 'come') {
      requirePlayer(player)
      await tasks.start('come', async signal => {
        speaker.say('Coming now.', true)
        await rushToPlayer(bot, player, signal, config)
      })
      return
    }

    if (command === 'aion') {
      ai.resume()
      speaker.say('AI control on.', true)
      return
    }

    if (command === 'aioff') {
      ai.pause('AI disabled by player')
      speaker.say('AI control off.', true)
      return
    }

    if (command === 'objective' || command === 'goal') {
      const goal = args.join(' ').trim()
      if (!goal) {
        speaker.say('Use !objective <what you want me to do>.', true)
        return
      }
      ai.setGoal(goal)
      speaker.say('Objective saved. I will work on it.', true)
      return
    }

    if (command === 'clearobjective' || command === 'cleargoal') {
      ai.clearGoal()
      speaker.say('Objective cleared.', true)
      return
    }

    if (command === 'aistatus') {
      speaker.say(`AI ${ai.enabled ? 'on' : 'paused'}${ai.goal ? `, goal: ${ai.goal}` : ', no goal'}.`, true)
      return
    }

    if (command === 'plannerstatus' || command === 'stockpiles' || command === 'goals') {
      speaker.say(formatPlannerStatus(planner.status()), true)
      return
    }

    if (command === 'stockpilescan' || command === 'scanstockpiles') {
      await tasks.start('stockpile scan', async signal => {
        const report = await scanStockpiles(bot, memory, config, signal)
        speaker.say(formatStockpileScan(report), true)
      })
      return
    }

    if (command === 'plannerrun' || command === 'runplanner' || command === 'rungoal') {
      await tasks.start('planner run', async signal => {
        if (config.goalPlanner?.scanBeforeRun !== false) {
          const report = await scanStockpiles(bot, memory, config, signal).catch(err => {
            speaker.say(`Stockpile scan skipped: ${shortError(err)}.`, true)
            return null
          })
          if (report) speaker.say(formatStockpileScan(report), true)
        }
        await runPlannerRecommendation({ bot, memory, config, speaker, planner }, signal)
      })
      return
    }

    if (command === 'llmstatus') {
      speaker.say(await getLlmStatus(config), true)
      return
    }

    if (command === 'follow') {
      requirePlayer(player)
      await tasks.start('follow', async signal => {
        speaker.say(`Following ${username}.`, true)
        await followPlayer(bot, player, signal, config)
      })
      return
    }

    if (command === 'sethome') {
      setPosition(memory, 'home', bot.entity.position)
      saveMemory(memory)
      speaker.say('Home saved.', true)
      return
    }

    if (command === 'setchest') {
      const kind = (args[0] || '').toLowerCase()
      if (!['storage', 'farm'].includes(kind)) {
        speaker.say('Use !setChest storage or !setChest farm.', true)
        return
      }
      const pos = findChestPositionNearLook(bot, config)
      if (!pos) {
        speaker.say('I need to look at or stand near a chest.', true)
        return
      }
      setChest(memory, kind, pos)
      saveMemory(memory)
      speaker.say(`${kind} chest saved.`, true)
      return
    }

    if (command === 'inventory') {
      speaker.say(summarizeInventory(bot), true)
      return
    }

    if (command === 'drop') {
      requirePlayer(player)
      const itemName = args.join(' ')
      if (!itemName) {
        speaker.say('Use !drop <item>.', true)
        return
      }
      await tasks.start('drop', async signal => {
        await dropItemToPlayer(bot, player, itemName, signal)
        speaker.say('Dropped it.', true)
      })
      return
    }

    if (command === 'deposit') {
      await tasks.start('deposit', async signal => {
        const report = await depositInventory(bot, memory, config, 'storage', signal)
        speaker.say(formatDepositReport(report), true)
      })
      return
    }

    if (command === 'explore') {
      const radius = clampNumber(parseInt(args[0], 10) || config.behavior.idleWanderRadius, 8, config.behavior.maxTaskDistanceFromHome)
      await tasks.start('explore', async signal => {
        speaker.say(`Exploring ${radius} blocks from home.`, true)
        const endAt = Date.now() + 120000
        while (!signal.cancelled && Date.now() < endAt) {
          await wanderNearHome(bot, memory, { ...config, behavior: { ...config.behavior, idleWanderRadius: radius } }, speaker, signal)
        }
      })
      return
    }

    if (command === 'bootstrap' || command === 'startfromscratch' || command === 'getbasics') {
      await tasks.start('bootstrap survival', async signal => {
        await bootstrapSurvival(bot, memory, config, speaker, signal)
      })
      return
    }

    if (command === 'survive' || command === 'autosurvive') {
      const minutes = clampNumber(parseInt(args[0], 10) || config.survival?.defaultSurvivalMinutes || 10, 1, 60)
      await tasks.start('survival loop', async signal => {
        await survivalLoop(bot, memory, config, speaker, signal, minutes)
      })
      return
    }

    if (command === 'botstash') {
      const base = memory.botBase
      const chest = memory.chests?.botStorage || memory.chests?.storage
      if (!base && !chest) {
        speaker.say('I have no bot base or stash yet. Use !bootstrap.', true)
        return
      }
      const parts = []
      if (base) parts.push(`base ${base.x} ${base.y} ${base.z}`)
      if (chest) parts.push(`stash ${chest.x} ${chest.y} ${chest.z}`)
      speaker.say(parts.join(' | '), true)
      return
    }

    if (command === 'diamondbeacon' || command === 'beaconobjective' || command === 'beacon') {
      const minutes = args[0] ? clampNumber(parseInt(args[0], 10) || 0, 1, 240) : (config.beaconObjective?.defaultMinutes || 20)
      await tasks.start('diamond beacon objective', async signal => {
        await runDiamondBeaconObjective(bot, memory, config, speaker, signal, { minutes })
      })
      return
    }

    if (command === 'setbeaconsite') {
      const site = setBeaconSite(bot, memory)
      speaker.say(`Beacon site saved at ${site.x} ${site.y} ${site.z}.`, true)
      return
    }

    if (command === 'buildcamp' || command === 'camp') {
      await tasks.start('build camp', async signal => {
        await buildStarterCamp(bot, memory, config, speaker, signal)
      })
      return
    }

    if (command === 'buildbase' || command === 'buildhouse') {
      const request = parseBuildBaseRequest(args, 'fancy')
      await tasks.start(`build ${request.variant} base`, async signal => {
        await buildBase(bot, memory, config, speaker, signal, {
          variant: request.variant,
          palette: request.palette,
          player
        })
      })
      return
    }

    if (command === 'fancybase' || command === 'builderbase' || command === 'bobbase' || command === 'fancyhouse') {
      const request = parseBuildBaseRequest(args, 'fancy')
      await tasks.start(`build ${request.variant} base`, async signal => {
        await buildBase(bot, memory, config, speaker, signal, {
          variant: request.variant,
          palette: request.palette,
          player
        })
      })
      return
    }

    if (command === 'buildshelter' || command === 'shelter') {
      await tasks.start('build shelter', async signal => {
        await buildEmergencyShelter(bot, memory, config, speaker, signal)
      })
      return
    }

    if (command === 'cookfood' || command === 'cook' || command === 'smeltfood') {
      const amount = clampNumber(parseInt(args[0], 10) || 64, 1, 64)
      await tasks.start('cook food', async signal => {
        await cookFood(bot, memory, config, speaker, signal, amount)
        saveMemory(memory)
      })
      return
    }

    if (command === 'makebed' || command === 'bed' || command === 'setspawn') {
      await tasks.start('make bed', async signal => {
        await makeBedAndSetSpawn(bot, memory, config, speaker, signal)
        saveMemory(memory)
      })
      return
    }

    if (command === 'sleep') {
      await tasks.start('sleep', async signal => {
        await sleepInOwnBed(bot, memory, speaker, signal)
        saveMemory(memory)
      })
      return
    }

    if (command === 'getwood') {
      const amount = clampNumber(parseInt(args[0], 10) || 16, 1, 128)
      await tasks.start('get wood', async signal => {
        speaker.say('Getting wood.', true)
        await gatherWood(bot, config, speaker, signal, amount, { requireFreshLogs: true })
      })
      return
    }

    if (command === 'getstone' || command === 'getcobble') {
      const amount = clampNumber(parseInt(args[0], 10) || 24, 1, 256)
      await tasks.start('get stone', async signal => {
        speaker.say('Getting stone.', true)
        await gatherStarterStone(bot, memory, config, speaker, signal, amount)
      })
      return
    }

    if (command === 'gomine') {
      const blockName = args[0]
      const amount = clampNumber(parseInt(args[1], 10) || 16, 1, 256)
      if (!blockName) {
        speaker.say('Use !goMine <block> <amount>.', true)
        return
      }
      await tasks.start(`mine ${blockName}`, async signal => {
        await prepareForMiningCommand(signal, speaker)
        await mineBlocks(bot, memory, config, speaker, blockName, amount, signal)
      })
      return
    }

    if (command === 'smartmine') {
      const blockName = args[0] || 'diamond'
      const amount = clampNumber(parseInt(args[1], 10) || 1, 1, 256)
      await tasks.start(`smart mine ${blockName}`, async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: true })
        await smartMineResource(bot, memory, config, speaker, blockName, amount, signal)
      })
      return
    }

    if (command === 'prospect' || command === 'mineuntil') {
      const blockName = args[0]
      const amount = clampNumber(parseInt(args[1], 10) || 1, 1, 64)
      const maxSteps = clampNumber(parseInt(args[2], 10) || config.mining?.prospectMaxSteps || 192, 8, config.mining?.prospectHardLimit || 512)
      if (!blockName) {
        speaker.say('Use !prospect <block> <amount> [steps].', true)
        return
      }
      await tasks.start(`prospect ${blockName}`, async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: true })
        await prospectMine(bot, memory, config, speaker, blockName, amount, signal, maxSteps)
      })
      return
    }

    if (command === 'stripmine') {
      const length = clampNumber(parseInt(args[0], 10) || 24, 1, 128)
      await tasks.start('strip mine', async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: length > 12 })
        await stripMine(bot, memory, config, speaker, length, signal)
      })
      return
    }

    if (command === 'torchmine') {
      const length = clampNumber(parseInt(args[0], 10) || 24, 1, 128)
      await tasks.start('torch mine', async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: length > 12 })
        await torchMine(bot, memory, config, speaker, length, signal)
      })
      return
    }

    if (command === 'branchmine') {
      const branches = clampNumber(parseInt(args[0], 10) || 3, 1, 16)
      const length = clampNumber(parseInt(args[1], 10) || 16, 3, 96)
      await tasks.start('branch mine', async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: true })
        await branchMine(bot, memory, config, speaker, branches, length, signal)
      })
      return
    }

    if (command === 'diamondmine') {
      const amount = clampNumber(parseInt(args[0], 10) || 1, 1, 64)
      await tasks.start('diamond branch mine', async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: true })
        await branchMineForResource(bot, memory, config, speaker, 'diamond', amount, signal)
      })
      return
    }

    if (command === 'staircasemine') {
      const targetY = clampNumber(parseInt(args[0], 10) || -58, -59, 120)
      await tasks.start('staircase mine', async signal => {
        await prepareForMiningCommand(signal, speaker, { longTrip: true })
        await staircaseMine(bot, memory, config, speaker, targetY, signal)
      })
      return
    }

    if (command === 'caveexplore') {
      const steps = clampNumber(parseInt(args[0], 10) || 32, 4, 128)
      await tasks.start('safe cave explore', async signal => {
        await safeCaveExplore(bot, memory, config, speaker, steps, signal)
      })
      return
    }

    if (command === 'minearea') {
      const width = clampNumber(parseInt(args[0], 10) || 3, 1, 9)
      const height = clampNumber(parseInt(args[1], 10) || 2, 1, 4)
      const depth = clampNumber(parseInt(args[2], 10) || 8, 1, 32)
      await tasks.start('area mine', async signal => {
        await mineArea(bot, memory, config, speaker, width, height, depth, signal)
      })
      return
    }

    if (command === 'findexposed') {
      const blockName = args[0]
      if (!blockName) {
        speaker.say('Use !findExposed <block>.', true)
        return
      }
      await findExposedBlocks(bot, config, speaker, blockName)
      return
    }

    if (command === 'returnhome' || command === 'home') {
      const home = getHomePosition(memory, config)
      if (!home) {
        speaker.say('No home saved.', true)
        return
      }
      await tasks.start('return home', async signal => {
        speaker.say('Returning home.', true)
        await goNear(bot, home, 2, signal, config.behavior.pathTimeoutMs)
      })
      return
    }

    if (command === 'farm') {
      const target = args[0]
      const amount = clampNumber(parseInt(args[1], 10) || 10, 1, 100)
      if (!target) {
        speaker.say('Use !farm <target> <amount>.', true)
        return
      }
      await tasks.start(`farm ${target}`, async signal => {
        await equipBestArmor(bot, memory, config, speaker, signal)
        await farmTarget(bot, memory, config, speaker, target, amount, signal)
      })
      return
    }

    if (command === 'protect') {
      protector.start()
      speaker.say('Protect mode on.', true)
      return
    }

    if (command === 'protectoff') {
      protector.stop()
      speaker.say('Protect mode off.', true)
      return
    }

    if (command === 'pvpon') {
      pvp.start()
      speaker.say('PVP retaliation on.', true)
      return
    }

    if (command === 'pvpoff') {
      pvp.stop()
      return
    }

    if (command === 'mobdefenseon') {
      mobDefense.start()
      speaker.say('Mob defense on.', true)
      return
    }

    if (command === 'mobdefenseoff') {
      mobDefense.stop()
      speaker.say('Mob defense off.', true)
      return
    }

    if (command === 'mobdefensestatus') {
      speaker.say(`Mob defense ${mobDefense.enabled ? 'on' : 'off'}${mobDefense.active ? `, fighting ${mobDefense.targetName || 'mob'}` : ''}; ${dispatcher.status()}.`, true)
      return
    }

    if (command === 'dispatcherstatus') {
      speaker.say(dispatcher.status(), true)
      return
    }

    if (command === 'fight') {
      const targetName = args[0]
      if (!targetName) {
        speaker.say('Use !fight <player>.', true)
        return
      }
      const target = bot.players[targetName]?.entity
      if (!target) {
        speaker.say('I cannot see that player.', true)
        return
      }
      mobDefense.stop()
      dispatcher.disable()
      pvp.start()
      pvp.forceFight(target)
      return
    }

    if (command === 'status') {
      speaker.say(getStatus(bot, tasks, protector, pvp, ai, mobDefense, dispatcher), true)
      return
    }

    if (command === 'checksupplies') {
      await tasks.start('check supplies', async signal => {
        const report = await checkSupplies(bot, memory, config, signal)
        speaker.say(report, true)
      })
      return
    }

    if (command === 'remember') {
      const note = args.join(' ').trim()
      if (!note) {
        speaker.say('Use !remember <note>.', true)
        return
      }
      memory.notes = memory.notes || []
      memory.notes.push(note.slice(0, 180))
      memory.notes = memory.notes.slice(-30)
      saveMemory(memory)
      speaker.say('I will remember that.', true)
      return
    }

    if (command === 'notes') {
      const notes = (memory.notes || []).slice(-5)
      speaker.say(notes.length ? notes.join(' | ') : 'No notes yet.', true)
      return
    }

    speaker.say('Unknown command.', true)
  }

  async function resumeBeaconObjectiveIfNeeded (tasks, speaker, pvp, mobDefense, dispatcher) {
    if (config.beaconObjective?.enabled === false) return
    const beacon = memory.ai?.beaconPyramid
    if (!beacon || beacon.mode !== 'running') return
    if (!bot?.entity || tasks.currentTask || pvp.active || mobDefense.active || dispatcher.active) return
    if (bot.health < (config.beaconObjective?.minResumeHealth || 12)) return
    if ((bot.food ?? 20) < (config.beaconObjective?.minResumeFood || 12)) return
    if (isDangerousNightForBeacon(bot) && !beaconNightReady(bot)) return
    await tasks.start('diamond beacon objective', async signal => {
      await runDiamondBeaconObjective(bot, memory, config, speaker, signal, { minutes: config.beaconObjective?.resumeMinutes || 5 })
    })
  }
}


function isKeepInventoryMode (config) {
  return config?.server?.keepInventory === true ||
    config?.behavior?.keepInventory === true ||
    config?.aiControl?.keepInventoryMode === true
}

function isFallRecoveryActive (bot) {
  if (!bot?.entity || bot.entity.onGround) return false
  return Boolean(bot.entity.elytraFlying) ||
    (bot.entity.velocity?.y || 0) < -0.12 ||
    Number(bot.entity.fallDistance || 0) > 2
}

function isDangerousNightForBeacon (bot) {
  const time = bot.time?.timeOfDay
  return typeof time === 'number' && time >= 13000 && time <= 23500
}

function beaconNightReady (bot) {
  const weapon = bot.inventory.items().some(item => /^(stone|iron|diamond|netherite)_(sword|axe)$/.test(item.name))
  return bot.health >= 18 && (bot.food ?? 20) >= 18 && weapon
}

function applyKeepInventoryRecoveryPatch (memory, config) {
  if (!isKeepInventoryMode(config)) return
  memory.ai = memory.ai || {}
  memory.ai.retryCounts = memory.ai.retryCounts || {}

  // The uploaded memory showed flee: 221 and craft_wood_tools: 64.
  // Reset the poison counters so the bot can actually try a fresh plan.
  for (const key of Object.keys(memory.ai.retryCounts)) {
    if (key.startsWith('flee') || key.startsWith('idle') || key.startsWith('llm_unavailable')) {
      memory.ai.retryCounts[key] = 0
    }
  }

  memory.ai.failedActions = (memory.ai.failedActions || [])
    .filter(entry => !['flee', 'idle', 'llm_unavailable'].includes(entry.action))
    .slice(-20)

  memory.ai.recentDecisions = (memory.ai.recentDecisions || [])
    .filter(entry => !['flee', 'idle'].includes(entry.action))
    .slice(-20)

  memory.ai.lessons = memory.ai.lessons || []
  const alreadyLearned = memory.ai.lessons.some(lesson => String(lesson.lesson || '').includes('keepInventory'))
  if (!alreadyLearned) {
    memory.ai.lessons.push({
      at: new Date().toISOString(),
      type: 'server_rule',
      lesson: 'Server has keepInventory. Do not repeatedly flee or cancel objectives only because health is low. Prefer eat, fight, continue, return_home, or respawn/retry.'
    })
    memory.ai.lessons = memory.ai.lessons.slice(-30)
  }

  saveMemory(memory)
}

function rememberDeathLesson (memory, bot, tasks, config) {
  memory.ai = memory.ai || {}
  memory.ai.deaths = memory.ai.deaths || []
  memory.ai.lessons = memory.ai.lessons || []

  const pos = bot?.entity?.position
  const taskName = tasks?.currentTask || memory.ai.shortTermTask || null
  const likelyCause = guessDeathCause(bot)
  const entry = {
    at: new Date().toISOString(),
    position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
    task: taskName,
    goal: memory.ai.currentGoal || null,
    likelyCause
  }

  memory.ai.deaths.push(entry)
  memory.ai.deaths = memory.ai.deaths.slice(-25)

  let lesson = 'Death is feedback. Retry the objective instead of giving up.'
  if (likelyCause === 'mob') lesson = 'Died near mobs. Next attempt should equip armor/weapon, eat first, and fight or ignore mobs instead of flee-looping.'
  if (likelyCause === 'lava') lesson = 'Died near lava. Next attempt should avoid exposed lava, carry/place blocks, and use safer mining paths.'
  if (likelyCause === 'fall') lesson = 'Died from fall risk. Prefer staircase mining and avoid unsafe drops.'
  if (likelyCause === 'drowning') lesson = 'Died from water risk. Avoid long underwater paths and surface sooner.'

  memory.ai.lessons.push({ at: entry.at, type: 'death', cause: likelyCause, lesson })
  memory.ai.lessons = memory.ai.lessons.slice(-30)

  if (isKeepInventoryMode(config)) {
    memory.ai.retryCounts = memory.ai.retryCounts || {}
    memory.ai.retryCounts['flee:'] = 0
    memory.ai.failedActions = (memory.ai.failedActions || []).filter(entry => entry.action !== 'flee').slice(-20)
  }

  saveMemory(memory)
}

function guessDeathCause (bot) {
  const entity = bot?.entity
  if (!entity) return 'unknown'

  const pos = entity.position
  if ((bot.food ?? 20) <= 0) return 'starvation'
  const nearbyHostile = Object.values(bot.entities || {}).some(e => {
    if (!e || !e.position || e.type !== 'mob') return false
    const name = String(e.name || '').toLowerCase()
    const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'slime', 'phantom'].some(x => name.includes(x))
    return hostile && e.position.distanceTo(pos) < 12
  })
  if (nearbyHostile) return 'mob'

  const feet = bot.blockAt(pos)
  const below = bot.blockAt(pos.offset(0, -1, 0))
  const names = [feet?.name, below?.name].filter(Boolean).join(' ')
  if (names.includes('lava')) return 'lava'
  if (names.includes('water')) return 'drowning'
  if (pos.y < -55) return 'fall'
  return 'unknown'
}

function scheduleReconnect () {
  if (reconnectTimer) return
  const delay = config.bot.reconnectDelayMs || 10000
  console.log(`[bot] Reconnecting in ${delay}ms...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    createBot()
  }, delay)
}

function isAllowed (username) {
  return config.allowedPlayers.includes(username)
}

function isDuplicateCommand (username, message) {
  const key = `${username}:${message}`
  const now = Date.now()
  const lastSeen = recentCommands.get(key) || 0
  recentCommands.set(key, now)
  for (const [oldKey, timestamp] of recentCommands.entries()) {
    if (now - timestamp > 3000) recentCommands.delete(oldKey)
  }
  return now - lastSeen < 750
}

function parseChatLine (line) {
  const text = String(line)
  let match = text.match(/^<([^>]+)>\s+(.+)$/)
  if (match) return { username: match[1], message: match[2] }

  match = text.match(/^([^:\s]+):\s+(.+)$/)
  if (match) return { username: match[1], message: match[2] }

  return null
}

function naturalObjective (message) {
  const text = String(message || '').trim()
  const lower = text.toLowerCase()
  const mentionsBot = lower.includes('bot') || lower.includes(String(config.bot.username || '').toLowerCase())
  if (!mentionsBot) return null
  const objectiveWords = ['get ', 'collect ', 'gather ', 'work on ', 'your goal is ', 'objective ']
  if (!objectiveWords.some(word => lower.includes(word))) return null
  if (lower.includes('what') || lower.includes('?')) return null
  return text.replace(/^(yo\s+)?(teammatebot|bot)[,:\s-]*/i, '').slice(0, 240)
}

function naturalDirectTask (message, username, mobDefense) {
  const text = String(message || '').trim()
  const lower = text.toLowerCase()
  const mentionsBot = lower.includes('bot') || lower.includes(String(config.bot.username || '').toLowerCase())
  if (!mentionsBot) return null
  const amount = clampNumber(firstNumber(lower) || 16, 1, 128)

  if (/\b(get|gather|collect|chop)\b/.test(lower) && /\b(wood|logs?|tree)\b/.test(lower)) {
    return {
      name: 'get wood',
      say: 'Getting wood.',
      run: (signal, speaker) => gatherWood(bot, config, speaker, signal, amount, { requireFreshLogs: true })
    }
  }

  if (/\b(get|gather|collect|mine)\b/.test(lower) && /\b(stone|cobble|cobblestone)\b/.test(lower)) {
    return {
      name: 'get stone',
      say: 'Getting stone.',
      run: (signal, speaker) => gatherStarterStone(bot, memory, config, speaker, signal, amount)
    }
  }

  if (/\b(get|gather|collect|find)\b/.test(lower) && /\b(food|meat|pork|beef|chicken|mutton)\b/.test(lower)) {
    return {
      name: 'get food',
      say: 'Getting food.',
      run: (signal, speaker) => require('./lib/survival').gatherStarterFood(bot, memory, config, speaker, signal)
    }
  }

  if (/\b(get|make|craft)\b/.test(lower) && /\b(axe|pickaxe|sword|tools?|weapon)\b/.test(lower)) {
    return {
      name: 'craft tools',
      say: null,
      run: (signal, speaker) => craftRequestedTool(lower, speaker, signal)
    }
  }

  if ((/\b(build|make)\b/.test(lower) && /\b(base|house|cabin|home)\b/.test(lower)) || /\bbob the builder\b/.test(lower)) {
    const request = parseBuildBaseRequest(lower.split(/\s+/), /\b(small|starter|basic)\b/.test(lower) ? 'small' : 'fancy')
    return {
      name: `build ${request.variant} base`,
      say: null,
      run: (signal, speaker) => buildBase(bot, memory, config, speaker, signal, {
        variant: request.variant,
        palette: request.palette,
        player: bot.players[username]?.entity
      })
    }
  }

  if (/\b(build|make)\b/.test(lower) && /\b(camp|base|starter base)\b/.test(lower)) {
    return {
      name: 'build camp',
      say: null,
      run: (signal, speaker) => buildStarterCamp(bot, memory, config, speaker, signal)
    }
  }

  if (/\b(build|make)\b/.test(lower) && /\b(shelter|hut|house|safe room)\b/.test(lower)) {
    return {
      name: 'build shelter',
      say: null,
      run: (signal, speaker) => buildEmergencyShelter(bot, memory, config, speaker, signal)
    }
  }

  if (/\b(beacon|diamond beacon|diamond pyramid)\b/.test(lower)) {
    return {
      name: 'diamond beacon objective',
      say: null,
      run: (signal, speaker) => runDiamondBeaconObjective(bot, memory, config, speaker, signal, { minutes: config.beaconObjective?.defaultMinutes || 20 })
    }
  }

  if (/\b(cook|smelt)\b/.test(lower) && /\b(food|meat|beef|pork|porkchop|chicken|mutton|potato)\b/.test(lower)) {
    return {
      name: 'cook food',
      say: null,
      run: (signal, speaker) => cookFood(bot, memory, config, speaker, signal)
    }
  }

  if (/\b(make|craft|get|place)\b/.test(lower) && /\b(bed)\b/.test(lower)) {
    return {
      name: 'make bed',
      say: null,
      run: (signal, speaker) => makeBedAndSetSpawn(bot, memory, config, speaker, signal)
    }
  }

  if (/\b(set)\b/.test(lower) && /\b(spawn)\b/.test(lower)) {
    return {
      name: 'set spawn',
      say: null,
      run: (signal, speaker) => makeBedAndSetSpawn(bot, memory, config, speaker, signal)
    }
  }

  if (/\b(sleep)\b/.test(lower)) {
    return {
      name: 'sleep',
      say: null,
      run: (signal, speaker) => sleepInOwnBed(bot, memory, speaker, signal)
    }
  }

  if (/\b(equip|hold|use)\b/.test(lower)) {
    const requested = requestedEquipName(lower)
    if (requested) {
      return {
        name: 'equip item',
        say: `Equipping ${requested.replace(/_/g, ' ')}.`,
        run: async () => equipNamedItem(requested)
      }
    }
  }

  if (/\b(defend|protect|fight back)\b/.test(lower) && /\b(yourself|self|you|bot)\b/.test(lower)) {
    return {
      name: 'mob defense',
      say: 'Mob defense on.',
      run: async () => { mobDefense?.start?.() }
    }
  }

  if (/\b(come|come here|follow me)\b/.test(lower)) {
    return {
      name: 'come',
      say: 'Coming now.',
      run: signal => {
        const player = bot.players[username]?.entity
        if (!player) throw new Error('I cannot see you.')
        return rushToPlayer(bot, player, signal, config)
      }
    }
  }

  return null
}

async function craftRequestedTool (text, speaker, signal) {
  const survival = require('./lib/survival')
  if (text.includes('pickaxe')) {
    await ensurePickaxe(bot, memory, config, speaker, signal)
    speaker.say('Pickaxe ready.', true)
    return
  }
  if (text.includes('axe')) {
    const axe = await survival.ensureStarterAxe(bot, memory, config, speaker, signal)
    await bot.equip(axe, 'hand').catch(() => {})
    speaker.say('Axe ready.', true)
    return
  }
  if (text.includes('sword') || text.includes('weapon')) {
    const sword = await survival.ensureStarterSword(bot, memory, config, speaker, signal)
    await bot.equip(sword, 'hand').catch(() => {})
    speaker.say('Sword ready.', true)
    return
  }
  const result = await craftStarterKit(bot, memory, config, speaker, signal)
  const made = [
    result.pickaxe ? 'pickaxe' : null,
    result.axe ? 'axe' : null,
    result.sword ? 'sword' : null
  ].filter(Boolean)
  if (!made.length) throw new Error('No starter tools were crafted.')
  speaker.say(`${made.join(', ')} ready.`, true)
}

async function prepareForMiningCommand (signal, speaker, options = {}) {
  const minFood = options.longTrip
    ? (config.director?.minFoodBeforeMining || 8)
    : Math.max(6, Math.floor((config.director?.minFoodBeforeMining || 8) / 2))

  if ((bot.food ?? 20) < 18 && findFoodForMining()) {
    await eatFoodForMining()
  }

  if ((bot.food ?? 20) < minFood && !findFoodForMining()) {
    speaker.say('I need food before mining safely.', true)
    await gatherStarterFood(bot, memory, config, speaker, signal).catch(() => {})
  }

  if ((bot.food ?? 20) < minFood && !findFoodForMining()) {
    throw new Error('No food for mining. Get food first or bring me some.')
  }

  if ((bot.food ?? 20) < 18 && findFoodForMining()) {
    await eatFoodForMining().catch(() => {})
  }

  await ensurePickaxe(bot, memory, config, speaker, signal)
}

function findFoodForMining () {
  const foods = new Set([
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
    'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton',
    'potato', 'mushroom_stew', 'sweet_berries'
  ])
  return bot.inventory.items().find(item => foods.has(item.name))
}

async function eatFoodForMining () {
  const food = findFoodForMining()
  if (!food) return false
  await bot.equip(food, 'hand')
  await bot.consume()
  return true
}

async function equipNamedItem (requested) {
  const exact = bot.inventory.items().find(item => item.name === requested)
  const item = exact || findItem(bot, requested)
  if (!item) throw new Error(`I do not have ${requested.replace(/_/g, ' ')}.`)
  await bot.equip(item, 'hand')
}

function requestedEquipName (text) {
  let cleaned = String(text)
    .toLowerCase()
    .replace(/\b(teammatebot|bot|yo|please|plz|equip|hold|use|the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  cleaned = cleaned
    .replace(/\bdiamon\b/g, 'diamond')
    .replace(/\bpikaxe\b/g, 'pickaxe')
    .replace(/\bpick axe\b/g, 'pickaxe')
  return normalizeName(cleaned)
}

function firstNumber (text) {
  const match = String(text).match(/\b(\d{1,3})\b/)
  return match ? Number(match[1]) : null
}

function formatDepositReport (report) {
  const deposited = formatItemCounts(report.deposited, 4)
  const failed = formatItemCounts(report.failed, 3)
  if (deposited && failed) return `Deposited ${deposited}. Could not deposit ${failed}${report.full ? '; chest looks full' : ''}.`
  if (deposited) return `Deposited ${deposited}.`
  if (failed) return `Could not deposit ${failed}${report.full ? '; chest looks full' : ''}.`
  return 'No junk to deposit; I kept tools, armor, food, torches, and rare items.'
}

function formatItemCounts (counts, limit) {
  const entries = Object.entries(counts || {}).filter(([, count]) => count > 0)
  if (!entries.length) return ''
  const shown = entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${count} ${name}`)
  const extra = entries.length > limit ? ` +${entries.length - limit} more` : ''
  return shown.join(', ') + extra
}

function naturalAutoplay (message) {
  const text = String(message || '').trim()
  const lower = text.toLowerCase()
  const mentionsBot = lower.includes('bot') || lower.includes(String(config.bot.username || '').toLowerCase())
  if (!mentionsBot) return false
  return [
    'survive by yourself',
    'survive on your own',
    'play by yourself',
    'play on your own',
    'act like a normal player',
    'act like a real player',
    'be a real player',
    'play like a real player',
    'compete with itzrealme',
    'beat itzrealme',
    'train like itzrealme',
    'progress by yourself',
    'progress on your own',
    'get smart',
    'be smart',
    'make yourself smarter',
    'do survival yourself',
    'bot survive',
    'survive',
    'start from scratch',
    'do basics yourself',
    'autoplay',
    'self play'
  ].some(phrase => lower.includes(phrase))
}

function parseBuildBaseRequest (args = [], defaultVariant = 'fancy') {
  let variant = defaultVariant
  let palette = null
  for (const raw of args) {
    const value = String(raw || '').toLowerCase()
    if (['small', 'starter', 'basic'].includes(value)) {
      variant = 'small'
      continue
    }
    if (['fancy', 'large', 'nice'].includes(value)) {
      variant = 'fancy'
      continue
    }
    const paletteName = normalizePaletteName(value)
    if (paletteName) palette = paletteName
  }
  return { variant, palette }
}

function shouldPreferTotemLoadout (bot, config = {}) {
  if (config.pvp?.crystalKitTotemOffhand === false) return false
  if (config.pvp?.crystalsEnabled === false) return false
  const items = bot.inventory?.items?.() || []
  const hasTotem = items.some(item => item.name === 'totem_of_undying')
  const hasCrystals = items.some(item => item.name === 'end_crystal')
  const hasObsidian = items.some(item => item.name === 'obsidian')
  return hasTotem && hasCrystals && hasObsidian
}

function requirePlayer (player) {
  if (!player) throw new Error('I cannot see you.')
}

function clampNumber (value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function shortError (err) {
  return (err?.message || String(err)).slice(0, 80)
}

function stopForFatalVersionError (message) {
  fatalStartupError = true
  if (fatalMessagePrinted) return
  fatalMessagePrinted = true
  console.error(`[bot] ${message}`)
  console.error('[bot] Stopping reconnects. This cannot be fixed in config unless the server accepts an older client.')
}

process.on('SIGINT', () => {
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (bot) {
    if (idleTimer) clearInterval(idleTimer)
    stopMoving(bot)
    bot.quit('Goodbye')
  }
  if (dashboardServer) dashboardServer.stop()
  process.exit(0)
})

createBot()

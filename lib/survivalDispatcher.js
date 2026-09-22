const { hostileNearby } = require('../safety')

function createSurvivalDispatcher (bot, memory, config, speaker, tasks, options = {}) {
  const settings = config.dispatcher || {}
  let enabled = settings.enabled === true
  let timer = null
  let suppressedUntil = 0
  let lastTriggerAt = 0

  function check () {
    if (!enabled || !bot.entity || Date.now() < suppressedUntil || tasks?.currentTask || options.pvp?.active || options.mobDefense?.active) return
    if (Date.now() - lastTriggerAt < (settings.cooldownMs || 600)) return
    const range = settings.rangedHostileRange || settings.hostileRange || 9
    if (!hostileNearby(bot, range, config, memory)) return
    lastTriggerAt = Date.now()
    options.mobDefense?.start?.()
  }

  function start () {
    if (!enabled || timer) return
    timer = setInterval(check, Math.max(100, settings.tickMs || 350))
  }

  function stop () {
    if (timer) clearInterval(timer)
    timer = null
  }

  bot.once('end', stop)

  return {
    get active () { return Boolean(options.mobDefense?.active) },
    start,
    stop,
    cancel (milliseconds = 0) {
      suppressedUntil = Date.now() + Math.max(0, milliseconds)
      options.mobDefense?.cancel?.()
    },
    disable () { enabled = false; stop(); options.mobDefense?.stop?.() },
    enable () { enabled = true; start() },
    status () {
      if (!enabled) return 'survival dispatcher off'
      return options.mobDefense?.active ? `survival dispatcher defending ${options.mobDefense.targetName || 'nearby'}` : 'survival dispatcher on'
    }
  }
}

function createSpeaker (bot, config) {
  let lastChat = 0
  const recentMessages = new Map()

  function canSpeak () {
    const now = Date.now()
    if (now - lastChat < config.behavior.chatCooldownMs) return false
    lastChat = now
    return true
  }

  return {
    say (message, force = false) {
      if (!bot.chat) return
      const text = trim(message)
      if (isDuplicate(text)) return
      if (force || canSpeak()) bot.chat(text)
    },
    routine (message) {
      if (config.chat?.routineMessages === false) return
      this.say(message, false)
    },
    autopilot (message, important = false) {
      const chatConfig = config.chat || {}
      if (!important && chatConfig.autopilotRoutineMessages === false) return
      if (important || chatConfig.importantOnlyDuringAutoplay !== true) this.say(message, important)
    },
    whisper (username, message) {
      bot.chat(`/msg ${username} ${trim(message)}`)
    }
  }

  function isDuplicate (message) {
    const now = Date.now()
    const windowMs = config.chat?.duplicateWindowMs || 10000
    const last = recentMessages.get(message) || 0
    recentMessages.set(message, now)
    for (const [text, timestamp] of recentMessages.entries()) {
      if (now - timestamp > windowMs) recentMessages.delete(text)
    }
    return now - last < windowMs
  }
}

function trim (message) {
  return String(message).replace(/\s+/g, ' ').slice(0, 220)
}

module.exports = { createSpeaker }

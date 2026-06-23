const { saveMemory } = require('./memory')
const { selectKnowledge, knowledgePrompt } = require('./knowledge')
const { rewardSummary } = require('./rewardSystem')
const { createSelfModel } = require('./selfModel')

function createBrain (bot, config, memory, speaker, tasks, protector) {
  const aiConfig = config.ai || {}
  const botName = config.bot?.username || bot.username || 'TeammateBot'
  const wakeWords = (aiConfig.wakeWords || [botName.toLowerCase(), 'bot']).map(word => String(word).toLowerCase())
  let lastAiChat = 0
  let lastIdleThought = 0
  const selfModel = createSelfModel(bot, memory, config, tasks, { protector })

  async function handleChat (username, message, force = false) {
    const text = String(message || '').trim()
    if (!text || !shouldAnswer(text, force)) return false

    rememberChat(username, text)

    const directReply = deterministicReply(username, text)
    if (directReply) {
      speaker.say(directReply, true)
      return true
    }

    if (!aiConfig.enabled) {
      speaker.say(simpleReply(username, text), true)
      return true
    }

    const now = Date.now()
    if (now - lastAiChat < (aiConfig.cooldownMs || 3500)) return true
    lastAiChat = now

    const reply = await askLocalAi(username, text).catch(err => {
      console.error('[brain]', err.message)
      return simpleReply(username, text)
    })

    if (reply) speaker.say(reply, true)
    return true
  }

  function shouldAnswer (message, force = false) {
    if (force) return true
    const lower = message.toLowerCase()
    if (lower.startsWith('!chat ')) return true
    return wakeWords.some(word => lower.includes(word))
  }

  function rememberChat (username, text) {
    memory.conversations = memory.conversations || []
    memory.conversations.push({
      at: new Date().toISOString(),
      username,
      message: text.slice(0, 180)
    })
    memory.conversations = memory.conversations.slice(-20)
    saveMemory(memory)
  }

  function simpleReply (username, text) {
    const lower = text.toLowerCase()
    if (isGreeting(lower)) return casualGreeting()
    if (lower.includes('come')) return `Use !come and I will run to you, ${username}.`
    if (lower.includes('mine')) return 'I can do !stripMine, !torchMine, !mineArea, or !goMine.'
    if (lower.includes('help')) return 'Try !come, !follow, !stripMine 20, !status, or !stop.'
    if (tasks.currentTask) return `I am doing ${taskName()}.`
    if (protector.enabled) return 'I am watching for hostile mobs nearby.'
    return 'I am here. Give me a command or ask for help.'
  }

  function deterministicReply (username, text) {
    const lower = text.toLowerCase()
    if (asksStatus(lower)) return statusReply()
    if (asksLocation(lower)) return locationReply()
    if (asksSelfAwareness(lower)) return selfModel.reflection()
    if (asksHelp(lower)) return 'Try saying: bot what are you doing, or use !come, !follow, !prospect diamond 3 250.'
    if (isGreeting(lower)) return casualGreeting()
    return null
  }

  function asksStatus (lower) {
    return [
      'what are you doing',
      'what r u doing',
      'what you doing',
      'wyd',
      'status',
      'current task',
      'are you busy',
      'u busy',
      'you busy'
    ].some(phrase => lower.includes(phrase))
  }

  function asksLocation (lower) {
    return [
      'where are you',
      'where are u',
      'where r u',
      'where you at',
      'your coords',
      'coordinates',
      'location'
    ].some(phrase => lower.includes(phrase))
  }

  function asksSelfAwareness (lower) {
    return [
      'are you self aware',
      'do you know you are playing',
      'do u know u are playing',
      'do you know this is minecraft',
      'what do you know about yourself',
      'self model',
      'reflect'
    ].some(phrase => lower.includes(phrase))
  }

  function asksHelp (lower) {
    return lower.includes('help') || lower.includes('what can you do')
  }

  function isGreeting (lower) {
    return [
      'hello bot',
      'hey bot',
      'hi bot',
      'yo bot',
      'sup bot',
      'hello teammatebot',
      'hey teammatebot'
    ].some(phrase => lower.includes(phrase))
  }

  function casualGreeting () {
    const task = taskName()
    if (task !== 'idle') return `Hey. I am working on ${task}.`
    return 'Hey. I am here.'
  }

  function statusReply () {
    const task = taskName()
    if (task !== 'idle') return `I am doing ${task}. HP ${bot.health ?? '?'}, food ${bot.food ?? '?'}.`
    if (protector.enabled) return 'I am idle, but protect mode is on.'
    return `I am idle. HP ${bot.health ?? '?'}, food ${bot.food ?? '?'}.`
  }

  function locationReply () {
    const pos = bot.entity?.position?.floored()
    if (!pos) return 'I do not know where I am yet.'
    return `I am at ${pos.x} ${pos.y} ${pos.z}.`
  }

  function taskName () {
    if (!tasks.currentTask) return 'idle'
    if (typeof tasks.currentTask === 'string') return tasks.currentTask
    return tasks.currentTask.name || 'busy'
  }

  async function askLocalAi (username, message) {
    const provider = (aiConfig.provider || 'ollama').toLowerCase()
    const prompt = buildPrompt(username, message)

    if (provider === 'lmstudio' || provider === 'openai-compatible') {
      return askOpenAiCompatible(prompt)
    }

    return askOllama(prompt)
  }

  function buildPrompt (username, message) {
    const visiblePlayers = Object.keys(bot.players || {}).filter(name => name !== bot.username).slice(0, 8)
    const pos = bot.entity?.position
    const recent = (memory.conversations || [])
      .slice(-6)
      .map(item => `${item.username}: ${item.message}`)
      .join('\n')
    const notes = (memory.notes || []).slice(-8).join('; ')
    const guides = selectKnowledge({
      message,
      currentTask: taskName(),
      health: bot.health,
      food: bot.food,
      dimension: bot.game?.dimension || bot.game?.dimensionName || 'unknown',
      inventory: bot.inventory?.items?.().slice(0, 16).map(item => `${item.count} ${item.name}`).join(', '),
      recentDecisions: memory.ai?.recentDecisions,
      failedActions: memory.ai?.failedActions
    })
    const guideText = knowledgePrompt(guides)
    const learning = rewardSummary(memory)

    return [
      aiConfig.systemPrompt || defaultSystemPrompt(botName),
      guideText ? `Relevant Minecraft knowledge:\n${guideText}` : null,
      selfModel.promptContext(),
      `Reward learning summary: ${JSON.stringify(learning)}`,
      `Bot status: task=${taskName()}, health=${bot.health ?? '?'}, food=${bot.food ?? '?'}, protect=${protector.enabled ? 'on' : 'off'}.`,
      `Location: ${pos ? `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}` : 'unknown'}.`,
      `Visible players: ${visiblePlayers.join(', ') || 'none'}.`,
      `Remembered notes: ${notes || 'none'}.`,
      `Recent chat:\n${recent || 'none'}`,
      `${username}: ${message}`,
      `${botName}:`
    ].filter(Boolean).join('\n')
  }

  async function askOllama (prompt) {
    const endpoint = aiConfig.endpoint || 'http://127.0.0.1:11434/api/generate'
    const body = {
      model: aiConfig.model || 'llama3.2',
      prompt,
      stream: false,
      options: {
        temperature: aiConfig.temperature ?? 0.6,
        num_predict: aiConfig.maxTokens || 60
      }
    }

    const json = await postJson(endpoint, body)
    return cleanReply(json.response)
  }

  async function askOpenAiCompatible (prompt) {
    const endpoint = aiConfig.endpoint || 'http://127.0.0.1:1234/v1/chat/completions'
    const model = aiConfig.model === 'auto'
      ? await getOpenAiCompatibleModel(endpoint)
      : (aiConfig.model || 'local-model')
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: aiConfig.temperature ?? 0.6,
      max_tokens: aiConfig.maxTokens || 60
    }

    const json = await postJson(endpoint, body)
    return cleanReply(json.choices?.[0]?.message?.content)
  }

  async function getOpenAiCompatibleModel (chatEndpoint) {
    const modelsEndpoint = chatEndpoint.replace(/\/chat\/completions\/?$/, '/models')
    const json = await getJson(modelsEndpoint)
    const id = json.data?.[0]?.id
    if (!id) throw new Error('No model loaded in local AI server')
    return id
  }

  async function postJson (endpoint, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), aiConfig.timeoutMs || 8000)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`AI server returned ${response.status}`)
      return response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function getJson (endpoint) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), aiConfig.timeoutMs || 8000)
    try {
      const response = await fetch(endpoint, { signal: controller.signal })
      if (!response.ok) throw new Error(`AI server returned ${response.status}`)
      return response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  function cleanReply (reply) {
    return String(reply || '')
      .replace(/\s+/g, ' ')
      .replace(/^["']|["']$/g, '')
      .slice(0, aiConfig.maxChatLength || 160)
  }

  function maybeIdleThought () {
    if (!aiConfig.idleChatter || tasks.currentTask || protector.enabled) return
    const now = Date.now()
    if (now - lastIdleThought < (aiConfig.idleChatterMs || 180000)) return
    lastIdleThought = now

    const options = [
      'I am around base if you need me.',
      'I can mine a tunnel with !stripMine 20.',
      'Use !come if you need me next to you.',
      'I am keeping an eye on the area.'
    ]
    speaker.say(options[Math.floor(Math.random() * options.length)])
  }

  return { handleChat, maybeIdleThought }
}

function defaultSystemPrompt (botName) {
  return [
    `You are ${botName}, a Minecraft teammate bot on a private friends server.`,
    'Reply like a helpful player, not like a customer support agent.',
    'Keep replies under one short Minecraft chat message.',
    'Do not claim you can xray, cheat, dupe, hack, bypass plugins, or see hidden ores.',
    'Suggest normal commands when useful: !come, !follow, !stop, !stripMine, !torchMine, !mineArea, !status.',
      'If asked to do an action, tell the player the exact command to use.'
  ].join(' ')
}

module.exports = { createBrain }

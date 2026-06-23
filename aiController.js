const { createAiState } = require('./aiState')
const { createWorldSummary, summaryForPrompt } = require('./worldSummary')
const { parseDecision, correctionPrompt, fallbackDecision } = require('./jsonDecision')
const { executeAiAction } = require('./aiActions')
const { sleep } = require('./navigation')
const { countInventory } = require('./inventory')
const { selectKnowledge, knowledgePrompt } = require('./knowledge')
const { rewardAction, recordFailureReward, shouldPrioritizeFood } = require('./rewardSystem')

const FOOD_NAMES = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread',
  'baked_potato', 'carrot', 'apple', 'beef', 'porkchop', 'chicken', 'mutton', 'potato',
  'rotten_flesh', 'spider_eye'
])

function createAiController (bot, config, memory, speaker, tasks, protector, pvp) {
  const state = createAiState(memory)
  const aiConfig = config.ai || {}
  const control = config.aiControl || {}
  let running = false
  let loopPromise = null
  let lastDecisionAt = 0
  let aiOfflineUntil = 0

  function start () {
    if (running) return
    running = true
    loopPromise = decisionLoop().catch(err => {
      running = false
      console.error('[ai-controller]', err)
    })
  }

  function stop () {
    running = false
    state.pause('AI stopped')
    tasks.stop()
  }

  function shutdown () {
    running = false
    tasks.stop()
  }

  function pause (reason) {
    state.pause(reason || 'Paused by player')
    tasks.stop()
  }

  function resume () {
    state.resume()
    start()
  }

  function setGoal (goal) {
    state.setGoal(goal)
    start()
  }

  function clearGoal () {
    state.clearGoal()
  }

  async function decisionLoop () {
    while (running) {
      try {
        await sleep(250)
        if (!bot.entity) continue
        if (!aiConfig.enabled || control.enabled === false || state.data.paused) continue
        if (tasks.currentTask) continue
        if (Date.now() < aiOfflineUntil) continue
        if (Date.now() - lastDecisionAt < cooldownMs()) continue

        lastDecisionAt = Date.now()
        const decision = await chooseDecision()
        if (!decision) continue

        if (state.tooManyRepeats(decision, control.maxRepeatedActions || 3)) {
          state.recordFailure(decision, 'repeated action loop')
          recordFailureReward(memory, decision.action, 'repeated action loop')
          await runAction(fallbackDecision('avoiding repeated action loop'))
          continue
        }

        await runAction(decision)
      } catch (err) {
        console.error('[ai-loop]', err.message)
        await sleep(control.errorCooldownMs || 3000)
      }
    }
  }

  async function chooseDecision () {
    if (shouldPrioritizeFood(memory, bot, config)) {
      if (hasFood()) return { action: 'eat_food', reason: 'reward learning: hunger is unsafe' }
      return { action: 'gather_food', amount: 3, reason: 'reward learning: food priority is high' }
    }

    if (bot.health <= (config.behavior?.criticalHealth ?? 6)) {
      const action = bot.food < 18 && hasFood() ? 'eat_food' : 'flee'
      return { action, reason: 'critical health safety override' }
    }

    const summary = createWorldSummary(bot, memory, config, tasks, protector, pvp, state)
    const practical = practicalGoalDecision(summary)
    if (practical) return practical

    const prompt = buildDecisionPrompt(summary)
    const first = await askLocalAi(prompt).catch(err => {
      markAiOffline(err)
      return null
    })
    if (!first) return fallbackDecision('LM Studio unavailable')

    try {
      return parseDecision(first)
    } catch (err) {
      state.recordFailure({ action: 'invalid_json' }, err)
      const retry = await askLocalAi(`${prompt}\n\n${correctionPrompt(first, err)}`).catch(() => null)
      if (!retry) return fallbackDecision('invalid JSON fallback')
      try {
        return parseDecision(retry)
      } catch (retryErr) {
        state.recordFailure({ action: 'invalid_json_retry' }, retryErr)
        return fallbackDecision('invalid JSON fallback')
      }
    }
  }

  async function runAction (decision) {
    if (!decision?.action) return
    console.log(`[ai] ${decision.action}${decision.target ? ` ${decision.target}` : ''}${decision.reason ? ` - ${decision.reason}` : ''}`)
    state.setShortTask(`${decision.action}${decision.target ? ` ${decision.target}` : ''}`)

    try {
      await tasks.start(`ai ${decision.action}`, async signal => {
        await executeAiAction({ bot, memory, config, speaker, protector, pvp }, decision, signal)
      })
      state.recordDecision(decision, 'ok')
      rewardAction(memory, decision.action, { target: decision.target, reason: decision.reason })
    } catch (err) {
      state.recordFailure(decision, err)
      recordFailureReward(memory, decision.action, err)
      console.error('[ai-action]', err.message)
    } finally {
      state.setShortTask(null)
    }
  }

  function cooldownMs () {
    if (bot.health <= (config.behavior?.lowHealth ?? 10)) return control.dangerDecisionCooldownMs ?? 2500
    return control.decisionCooldownMs ?? 7000
  }

  function hasFood () {
    return bot.inventory.items().some(item => FOOD_NAMES.has(item.name))
  }

  function practicalGoalDecision (summary) {
    const goal = String(state.data.currentGoal || '').toLowerCase()
    if (!goal) return null

    const counts = countInventory(bot)
    const wood = sumMatching(counts, ['_log', '_planks', 'planks'])
    const food = sumMatching(counts, ['beef', 'porkchop', 'chicken', 'mutton', 'bread', 'apple', 'carrot', 'potato', 'rotten_flesh', 'spider_eye'])
    const stone = sumMatching(counts, ['cobblestone', 'cobbled_deepslate', 'stone'])
    const iron = sumMatching(counts, ['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore'])
    const diamonds = sumMatching(counts, ['diamond'])

    if (mentions(goal, ['wood', 'log', 'plank', 'tree']) && wood < targetAmount(goal, control.defaultWoodTarget || 64)) {
      return { action: 'gather_wood', amount: 12, reason: 'goal needs wood' }
    }
    if (mentions(goal, ['food', 'eat', 'meat', 'pork', 'beef']) && food < targetAmount(goal, 8)) {
      return { action: 'gather_food', amount: 3, reason: 'goal needs food' }
    }
    if (mentions(goal, ['stone', 'cobble']) && stone < targetAmount(goal, 32)) {
      return { action: 'mine_resource', target: 'stone', amount: 12, reason: 'goal needs stone' }
    }
    if (mentions(goal, ['iron']) && iron < targetAmount(goal, 16)) {
      return { action: 'prospect_resource', target: 'iron', amount: 4, reason: 'goal needs iron' }
    }
    if (mentions(goal, ['diamond']) && diamonds < targetAmount(goal, 4)) {
      return { action: 'branch_mine', target: 'diamond', amount: Math.min(8, targetAmount(goal, 4) - diamonds), reason: 'goal needs diamonds at optimal level' }
    }

    return null
  }

  function mentions (goal, words) {
    return words.some(word => goal.includes(word))
  }

  function targetAmount (goal, fallback) {
    const stackMatch = goal.match(/(\d+)\s*stacks?/)
    if (stackMatch) return Number(stackMatch[1]) * 64
    const numberMatch = goal.match(/(\d+)/)
    return numberMatch ? Number(numberMatch[1]) : fallback
  }

  function sumMatching (counts, needles) {
    return Object.entries(counts).reduce((sum, [name, count]) => {
      return needles.some(needle => name.includes(needle)) ? sum + count : sum
    }, 0)
  }

  function buildDecisionPrompt (summary) {
    const guides = selectKnowledge({
      goal: summary.currentGoal,
      currentTask: summary.currentTask,
      shortTermTask: summary.shortTermTask,
      inventory: summary.inventory,
      heldItem: summary.heldItem,
      dimension: summary.dimension,
      directorStage: summary.director?.stage,
      directorStep: summary.director?.step,
      health: summary.health,
      hostileMobs: summary.hostileMobs,
      adaptiveThreats: summary.adaptiveThreats,
      visibleBlocks: summary.visibleBlocks,
      failedActions: summary.failedActions,
      recentDecisions: summary.recentDecisions,
      rewardLearning: summary.rewardLearning
    })
    const guideText = knowledgePrompt(guides)

    return [
      systemPrompt(),
      guideText ? `Relevant Minecraft knowledge:\n${guideText}` : null,
      'Current game state JSON:',
      summaryForPrompt(summary),
      'Use rewardLearning only as a short bias: raise food/safety/stuck-prevention priorities when scores say so.',
      'Choose exactly one next action. Return strict valid JSON only.'
    ].filter(Boolean).join('\n')
  }

  function markAiOffline (err) {
    const cooldown = control.offlineCooldownMs || 30000
    aiOfflineUntil = Date.now() + cooldown
    const message = String(err?.message || err || 'LM Studio unavailable').slice(0, 120)
    console.error(`[ai] LM Studio unavailable: ${message}`)
    state.recordFailure({ action: 'llm_unavailable' }, message)
  }

  function systemPrompt () {
    return [
      'You are TeammateBot, an LLM-controlled Minecraft survival teammate.',
      'Act like a normal Minecraft Java player using only allowed actions.',
      'You are the planner and strategy brain; Mineflayer skills do the detailed execution.',
      'Use the relevant Minecraft knowledge guide for strategy, but do not micromanage every movement tick.',
      'Prefer skills listed in agent.availableSkills when choosing high-level actions.',
      'Never use cheats, xray, dupes, exploits, server commands, raw JavaScript, or file edits.',
      'Prefer safety: eat when hungry, flee at low health, avoid lava, avoid pointless combat.',
      'In modded worlds, treat unknown mobs, bullets/projectiles, guns, rifles, turrets, soldiers, bandits, and fast damage as high danger. Take cover or flee before mining/fighting.',
      'Work toward the current goal when one exists. If no goal exists, improve survival: food, tools, storage, mining prep.',
      'Keep chat short and casual.',
      'Choose one high-level skill/action and let hardcoded Mineflayer skills execute it.',
      'Return STRICT JSON ONLY with shape:',
      '{"action":"action_name","target":"optional","amount":1,"strategy":"optional","reason":"short","chat":"optional"}',
      'The key "skill" is also accepted as an alias for "action".',
      'Allowed actions: idle, chat, move_to, follow_player, look_at, jump, sprint, sneak, dig_block, place_block, equip_item, eat_food, attack_entity, fight, flee, craft_item, smelt_item, open_chest, deposit_item, withdraw_item, sleep, explore, return_home, mine_resource, prospect_resource, branch_mine, staircase_mine, cave_explore, gather_wood, gather_food, secure_food, prepare_mining, safe_branch_mine, combat_prepare, nether_prepare, survival_progression, recover_from_failure.',
      'For diamonds, prefer branch_mine at Y -58 or staircase_mine toward Y -58 first. For mobs, prefer fight only when fed and geared.',
      'Use small actions. Do not invent unsupported actions.'
    ].join('\n')
  }

  async function askLocalAi (prompt) {
    const endpoint = aiConfig.endpoint || 'http://127.0.0.1:1234/v1/chat/completions'
    const model = aiConfig.model === 'auto'
      ? await getOpenAiCompatibleModel(endpoint)
      : (aiConfig.model || 'local-model')

    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: control.temperature ?? aiConfig.temperature ?? 0.35,
      max_tokens: control.maxTokens || aiConfig.maxTokens || 160
    }

    const json = await postJson(endpoint, body)
    return json.choices?.[0]?.message?.content || ''
  }

  async function getOpenAiCompatibleModel (chatEndpoint) {
    const modelsEndpoint = chatEndpoint.replace(/\/chat\/completions\/?$/, '/models')
    const json = await getJson(modelsEndpoint)
    const id = json.data?.[0]?.id
    if (!id) throw new Error('No model loaded in LM Studio')
    return id
  }

  async function postJson (endpoint, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), aiConfig.timeoutMs || 20000)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`LM Studio returned ${response.status}`)
      return response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function getJson (endpoint) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), aiConfig.timeoutMs || 20000)
    try {
      const response = await fetch(endpoint, { signal: controller.signal })
      if (!response.ok) throw new Error(`LM Studio returned ${response.status}`)
      return response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    start,
    stop,
    shutdown,
    pause,
    resume,
    setGoal,
    clearGoal,
    get enabled () {
      return Boolean(aiConfig.enabled && control.enabled !== false && !state.data.paused)
    },
    get paused () {
      return Boolean(state.data.paused)
    },
    get goal () {
      return state.data.currentGoal
    },
    get state () {
      return state.data
    },
    loopPromise
  }
}

module.exports = { createAiController }

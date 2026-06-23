const ALLOWED_ACTIONS = new Set([
  'idle',
  'chat',
  'move_to',
  'follow_player',
  'look_at',
  'jump',
  'sprint',
  'sneak',
  'dig_block',
  'place_block',
  'equip_item',
  'eat_food',
  'attack_entity',
  'fight',
  'flee',
  'craft_item',
  'smelt_item',
  'open_chest',
  'deposit_item',
  'withdraw_item',
  'sleep',
  'explore',
  'return_home',
  'mine_resource',
  'prospect_resource',
  'branch_mine',
  'staircase_mine',
  'cave_explore',
  'gather_wood',
  'gather_food',
  'secure_food',
  'prepare_mining',
  'safe_branch_mine',
  'combat_prepare',
  'nether_prepare',
  'survival_progression',
  'recover_from_failure'
])

function parseDecision (text) {
  const jsonText = extractJson(text)
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`)
  }

  if (!parsed.action && typeof parsed.skill === 'string') parsed.action = parsed.skill
  validateDecision(parsed)
  return normalizeDecision(parsed)
}

function validateDecision (decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('Decision must be one JSON object.')
  }
  if (typeof decision.action !== 'string') throw new Error('Decision needs action string.')
  if (!ALLOWED_ACTIONS.has(decision.action)) throw new Error(`Unsupported action ${decision.action}.`)
  if (decision.position !== undefined) validatePosition(decision.position)
  if (decision.amount !== undefined && (!Number.isFinite(Number(decision.amount)) || Number(decision.amount) < 0)) {
    throw new Error('amount must be a positive number.')
  }
  if (decision.chat !== undefined && typeof decision.chat !== 'string') throw new Error('chat must be a string.')
  if (decision.target !== undefined && typeof decision.target !== 'string') throw new Error('target must be a string.')
}

function normalizeDecision (decision) {
  return {
    action: decision.action,
    target: decision.target ? String(decision.target).slice(0, 80) : undefined,
    amount: decision.amount === undefined ? undefined : Math.floor(Number(decision.amount)),
    position: decision.position ? {
      x: Math.floor(Number(decision.position.x)),
      y: Math.floor(Number(decision.position.y)),
      z: Math.floor(Number(decision.position.z))
    } : undefined,
    reason: decision.reason ? String(decision.reason).slice(0, 180) : undefined,
    chat: decision.chat ? String(decision.chat).slice(0, 180) : undefined,
    strategy: decision.strategy ? String(decision.strategy).slice(0, 80) : undefined,
    kind: decision.kind ? String(decision.kind).slice(0, 40) : undefined,
    container: decision.container ? String(decision.container).slice(0, 40) : undefined
  }
}

function extractJson (text) {
  const raw = String(text || '').trim()
  if (raw.startsWith('{') && raw.endsWith('}')) return raw

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) return raw.slice(start, end + 1)

  return raw
}

function validatePosition (position) {
  if (!position || typeof position !== 'object') throw new Error('position must be an object.')
  for (const key of ['x', 'y', 'z']) {
    if (!Number.isFinite(Number(position[key]))) throw new Error(`position.${key} must be a number.`)
  }
}

function correctionPrompt (badText, error) {
  return [
    'Your previous response was invalid.',
    `Error: ${String(error?.message || error).slice(0, 160)}`,
    'Return STRICT VALID JSON ONLY. No markdown, no explanation.',
    'Use shape: {"action":"idle","reason":"short reason"}',
    `Previous response: ${String(badText || '').slice(0, 400)}`
  ].join('\n')
}

function fallbackDecision (reason = 'safe fallback') {
  return { action: 'idle', reason }
}

module.exports = {
  ALLOWED_ACTIONS,
  parseDecision,
  correctionPrompt,
  fallbackDecision
}

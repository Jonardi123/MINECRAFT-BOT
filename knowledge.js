const fs = require('fs')
const path = require('path')

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge')
const GUIDE_FILES = {
  survival: 'survival.json',
  mining: 'mining.json',
  combat: 'combat.json',
  pvp: 'pvp.json',
  mobs: 'mobs.json',
  nether: 'nether.json',
  dragon: 'dragon.json',
  crafting: 'crafting.json',
  inventory: 'inventory.json',
  objectives: 'objectives.json',
  recovery: 'recovery.json',
  exploration: 'exploration.json',
  enchanting: 'enchanting.json',
  brewing: 'brewing.json',
  trading: 'trading.json',
  building: 'building.json',
  redstone_utility: 'redstone_utility.json',
  speedrun_basics: 'speedrun_basics.json',
  villages: 'villages.json',
  structures: 'structures.json'
}

function selectKnowledge (context = {}) {
  const text = contextText(context)
  const scores = new Map()

  for (const id of Object.keys(GUIDE_FILES)) {
    const guide = loadGuide(id)
    if (!guide) continue
    const guideText = guideSearchText(guide)
    let score = 0
    for (const token of tokenize(text)) {
      if (guideText.includes(token)) score += token.length > 5 ? 3 : 1
    }
    if ((guide.useWhen || []).some(item => text.includes(String(item).toLowerCase()))) score += 6
    scores.set(id, score)
  }

  boost(scores, context, text)

  let ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)

  if (!ranked.length) ranked = ['objectives', 'survival', 'inventory']
  const limit = Math.max(1, Math.min(context.limit || 4, 5))
  const selected = unique(ranked).slice(0, limit)
  if (context.debug) console.log(`[knowledge] using ${selected.join(', ')}`)
  return selected.map(loadGuide).filter(Boolean)
}

function knowledgePrompt (guides) {
  if (!guides?.length) return ''
  return guides.map(guide => {
    const rules = compactRules(guide).slice(0, 8).map(rule => `- ${rule}`).join('\n')
    return `${guide.title}:\n${rules}`
  }).join('\n\n')
}

function compactRules (guide) {
  const rules = [...(guide.rules || [])]
  for (const section of guide.sections || []) {
    if (section.title && section.rules?.length) rules.push(`${section.title}: ${section.rules.join('; ')}`)
  }
  if (guide.keepInventoryRule) rules.push(guide.keepInventoryRule)
  if (guide.skills?.length) rules.push(`Useful skills: ${guide.skills.join(', ')}.`)
  if (guide.preferredSkills?.length) rules.push(`Prefer skills: ${guide.preferredSkills.join(', ')}.`)
  if (guide.dangerSignals?.length) rules.push(`Danger signals: ${guide.dangerSignals.join(', ')}.`)
  if (guide.preconditions?.length) rules.push(`Preconditions: ${guide.preconditions.join(', ')}.`)
  if (guide.fallbacks?.length) rules.push(`Fallbacks: ${guide.fallbacks.join(', ')}.`)
  return rules
}

function loadGuide (id) {
  const file = GUIDE_FILES[id]
  if (!file) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8'))
  } catch (err) {
    console.error(`[knowledge] Failed to load ${id}: ${err.message}`)
    return null
  }
}

function contextText (context) {
  return [
    context.goal,
    context.message,
    context.currentTask,
    context.shortTermTask,
    context.inventory,
    context.heldItem,
    context.dimension,
    context.directorStage,
    context.directorStep,
    context.rewardLearning,
    JSON.stringify(context.visibleBlocks || []),
    JSON.stringify(context.hostileMobs || []),
    JSON.stringify(context.passiveMobs || []),
    JSON.stringify(context.failedActions || []),
    JSON.stringify(context.recentDecisions || [])
  ].filter(Boolean).join(' ').toLowerCase()
}

function guideSearchText (guide) {
  return JSON.stringify([
    guide.id,
    guide.title,
    guide.useWhen,
    guide.rules,
    guide.skills,
    guide.preferredSkills,
    guide.dangerSignals,
    guide.preconditions,
    guide.fallbacks,
    guide.sections
  ]).toLowerCase()
}

function boost (scores, context, text) {
  const add = (ids, value) => {
    for (const id of ids) scores.set(id, (scores.get(id) || 0) + value)
  }
  if (hasAny(text, ['wood', 'log', 'plank', 'food', 'survive', 'autoplay', 'selfplay', 'base', 'home'])) add(['survival', 'crafting', 'inventory'], 10)
  if (hasAny(text, ['craft', 'recipe', 'stick', 'table', 'furnace', 'smelt', 'shield', 'bucket', 'tool', 'armor'])) add(['crafting', 'inventory', 'survival'], 10)
  if (hasAny(text, ['mine', 'ore', 'diamond', 'iron', 'coal', 'gold', 'redstone', 'lapis', 'cave', 'tunnel', 'branch', 'staircase', 'lava'])) add(['mining', 'inventory', 'recovery'], 12)
  if (hasAny(text, ['fight', 'combat', 'mob', 'creeper', 'skeleton', 'witch', 'zombie', 'spider', 'enderman', 'protect'])) add(['combat', 'mobs', 'recovery'], 12)
  if (hasAny(text, ['pvp', 'player hit', 'player attack', 'retaliate', 'duel', 'enemy player'])) add(['pvp', 'combat', 'inventory'], 12)
  if (hasAny(text, ['nether', 'fortress', 'blaze', 'portal', 'warped', 'barter', 'piglin', 'ghast'])) add(['nether', 'combat', 'inventory', 'structures'], 12)
  if (hasAny(text, ['dragon', 'stronghold', 'ender', 'end ', 'crystal', 'blaze rod', 'ender pearl', 'eye of ender'])) add(['dragon', 'combat', 'inventory'], 12)
  if (hasAny(text, ['objective', 'goal', 'progression', 'beat minecraft', 'beat the game', 'long term', 'next step'])) add(['objectives', 'speedrun_basics', 'survival'], 10)
  if (hasAny(text, ['death', 'died', 'stuck', 'failed', 'failure', 'loop', 'keepinventory', 'retry', 'recover', 'flee'])) add(['recovery'], 16)
  if (hasAny(text, ['village', 'villager', 'trade', 'emerald', 'golem'])) add(['villages', 'trading'], 12)
  if (hasAny(text, ['enchant', 'fortune', 'mending', 'efficiency', 'protection', 'lapis', 'xp'])) add(['enchanting', 'inventory'], 12)
  if (hasAny(text, ['brew', 'potion', 'fire resistance', 'slow falling', 'nether wart'])) add(['brewing', 'nether'], 12)
  if (hasAny(text, ['explore', 'scout', 'travel', 'lost', 'biome'])) add(['exploration', 'recovery'], 10)
  if (hasAny(text, ['build', 'bridge', 'shelter', 'safe home', 'storage'])) add(['building', 'inventory'], 10)
  if (hasAny(text, ['structure', 'mineshaft', 'spawner', 'dungeon', 'bastion', 'temple'])) add(['structures', 'combat', 'exploration'], 10)
  if (context?.health !== undefined && context.health <= 8) add(['recovery', 'combat'], 8)
  if (context?.food !== undefined && context.food <= 10) add(['survival', 'inventory', 'recovery'], 8)
  if (context?.hostileMobs?.length) add(['combat', 'mobs', 'recovery'], 10)
  if (context?.dimension && String(context.dimension).toLowerCase().includes('nether')) add(['nether', 'combat', 'inventory'], 10)
  const reward = JSON.stringify(context?.rewardLearning || '').toLowerCase()
  if (reward.includes('foodpriority') && reward.match(/[7-9]\d|100/)) add(['survival', 'inventory'], 5)
  if (reward.includes('avoidstuckbehavior') && reward.match(/[7-9]\d|100/)) add(['recovery', 'exploration', 'building'], 5)
}

function tokenize (text) {
  return unique(String(text || '').toLowerCase().split(/[^a-z0-9_-]+/).filter(token => token.length >= 3))
}

function hasAny (text, words) {
  return words.some(word => text.includes(word))
}

function unique (items) {
  const out = []
  for (const id of items) {
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function addMany (selected, ids) {
  for (const id of ids) {
    if (!selected.includes(id)) selected.push(id)
  }
}

module.exports = {
  selectKnowledge,
  knowledgePrompt,
  loadGuide
}

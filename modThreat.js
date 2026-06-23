const VANILLA_HOSTILES = new Set([
  'zombie', 'zombie_villager', 'drowned', 'husk', 'skeleton', 'stray', 'spider', 'cave_spider',
  'creeper', 'witch', 'slime', 'phantom', 'pillager', 'vindicator', 'ravager', 'evoker',
  'warden', 'blaze', 'ghast', 'magma_cube', 'wither_skeleton', 'hoglin', 'zoglin'
])

const PASSIVE_MOBS = new Set([
  'pig', 'cow', 'sheep', 'chicken', 'horse', 'donkey', 'mule', 'llama', 'villager',
  'wandering_trader', 'cat', 'wolf', 'fox', 'rabbit', 'bee', 'turtle', 'parrot'
])

const RANGED_WORDS = ['ak', 'ak47', 'ak_47', 'gun', 'rifle', 'pistol', 'shotgun', 'sniper', 'smg', 'bullet', 'ammo', 'grenade', 'rocket', 'launcher', 'turret', 'laser', 'blaster']
const PROJECTILE_WORDS = ['arrow', 'trident', 'fireball', 'bullet', 'grenade', 'rocket', 'missile', 'laser', 'beam', 'shell']
const MODDED_DANGER_WORDS = ['mutant', 'infected', 'soldier', 'bandit', 'raider', 'mercenary', 'hunter', 'shooter', 'robot', 'drone', 'turret', 'boss', 'elite', 'brute', 'assassin', 'sniper']
const NON_THREAT_NAMES = new Set([
  'item', 'experience_orb', 'xp_orb', 'orb', 'falling_block', 'area_effect_cloud',
  'armor_stand', 'boat', 'minecart', 'arrow', 'spectral_arrow', 'egg', 'snowball'
])

function classifyEntityThreat (bot, entity, config = {}, memory = null) {
  if (!entity?.isValid || !bot?.entity || entity === bot.entity) return null
  if (entity.type === 'player' && (config.allowedPlayers || []).includes(entity.username)) return null

  const rawName = String(entity.name || entity.username || entity.displayName || entity.type || 'unknown').toLowerCase()
  if (NON_THREAT_NAMES.has(rawName)) return null
  if (entity.type === 'mob' && PASSIVE_MOBS.has(rawName)) return null

  const combatRelevant = ['mob', 'player', 'projectile'].includes(entity.type) ||
    includesAny(rawName, [...PROJECTILE_WORDS, ...RANGED_WORDS, ...MODDED_DANGER_WORDS])
  if (!combatRelevant) return null

  const distance = entity.position?.distanceTo(bot.entity.position) ?? Infinity
  let score = 0
  const reasons = []

  if (entity.type === 'projectile' || includesAny(rawName, PROJECTILE_WORDS)) {
    score += 85
    reasons.push('projectile_or_bullet')
  }
  if (VANILLA_HOSTILES.has(rawName)) {
    score += vanillaScore(rawName)
    reasons.push('known_hostile')
  } else if (entity.type === 'mob' && !PASSIVE_MOBS.has(rawName)) {
    const unknownHostile = config.modded?.treatUnknownMobsHostile !== false
    score += unknownHostile ? 50 : 20
    reasons.push(unknownHostile ? 'unknown_modded_mob' : 'unknown_mob_watch')
  }
  if (includesAny(rawName, RANGED_WORDS)) {
    score += 55
    reasons.push('ranged_weapon_signal')
  }
  if (includesAny(rawName, MODDED_DANGER_WORDS)) {
    score += 35
    reasons.push('modded_danger_name')
  }
  if (distance <= 4) score += 25
  else if (distance <= 10) score += 12

  const damageSignal = recentDamageSignal(memory)
  if (damageSignal && distance <= (config.modded?.damageAttributionRange || 18)) {
    score += damageSignal.fastDrop ? 40 : 18
    reasons.push(damageSignal.fastDrop ? 'recent_fast_damage' : 'recent_damage')
  }
  if (bot.health <= (config.behavior?.lowHealth ?? 10)) {
    score += 20
    reasons.push('bot_low_health')
  }

  score = Math.max(0, Math.min(100, score))
  if (score <= 0) return null
  const ranged = reasons.includes('ranged_weapon_signal') || reasons.includes('projectile_or_bullet') || ['skeleton', 'stray', 'witch', 'pillager', 'blaze', 'ghast'].includes(rawName)
  return {
    entity,
    name: entity.username || entity.name || entity.type || 'unknown',
    type: entity.type || 'unknown',
    distance: Math.round(distance * 10) / 10,
    score,
    level: threatLevel(score),
    ranged,
    reasons,
    recommendation: recommendation(score, reasons)
  }
}

function listAdaptiveThreats (bot, config = {}, memory = null, range = null) {
  if (!bot?.entity) return []
  const maxRange = range || config.modded?.threatScanRange || 24
  return Object.values(bot.entities || {})
    .map(entity => classifyEntityThreat(bot, entity, config, memory))
    .filter(Boolean)
    .filter(threat => threat.distance <= maxRange)
    .sort((a, b) => (b.score - a.score) || (a.distance - b.distance))
}

function findAdaptiveThreat (bot, config = {}, memory = null, range = null) {
  return listAdaptiveThreats(bot, config, memory, range)[0]?.entity || null
}

function adaptiveThreatSummary (bot, config = {}, memory = null, range = null) {
  return listAdaptiveThreats(bot, config, memory, range).slice(0, 8).map(threat => ({
    name: threat.name,
    type: threat.type,
    distance: threat.distance,
    level: threat.level,
    score: threat.score,
    ranged: threat.ranged,
    reasons: threat.reasons.slice(0, 3),
    recommendation: threat.recommendation
  }))
}

function recordObservedThreats (bot, memory, config = {}) {
  if (!memory || !bot?.entity) return
  memory.ai = memory.ai || {}
  memory.ai.moddedThreats = memory.ai.moddedThreats || {}
  const observed = memory.ai.moddedThreats.observed = memory.ai.moddedThreats.observed || {}
  for (const threat of listAdaptiveThreats(bot, config, memory, config.modded?.threatScanRange || 24).slice(0, 12)) {
    const key = String(threat.name || 'unknown').toLowerCase()
    const entry = observed[key] || { seen: 0, maxScore: 0, reasons: [] }
    entry.seen += 1
    entry.maxScore = Math.max(entry.maxScore || 0, threat.score)
    entry.lastSeenAt = new Date().toISOString()
    entry.level = threat.level
    entry.ranged = threat.ranged
    entry.reasons = Array.from(new Set([...(entry.reasons || []), ...threat.reasons])).slice(0, 8)
    observed[key] = entry
  }
}

function recordDamageMemory (bot, memory, oldHealth, newHealth, config = {}) {
  if (!memory || !Number.isFinite(oldHealth) || !Number.isFinite(newHealth) || newHealth >= oldHealth) return
  memory.ai = memory.ai || {}
  memory.ai.moddedThreats = memory.ai.moddedThreats || {}
  const store = memory.ai.moddedThreats
  store.damageEvents = store.damageEvents || []
  store.damageEvents.push({
    at: Date.now(),
    iso: new Date().toISOString(),
    lost: Math.round((oldHealth - newHealth) * 10) / 10,
    nearby: adaptiveThreatSummary(bot, config, memory, 24)
  })
  store.damageEvents = store.damageEvents.slice(-30)
}

function shouldEvadeThreat (bot, threat, config = {}) {
  if (!threat) return false
  if (threat.score >= (config.modded?.evadeThreatScore || 85)) return true
  if (threat.ranged && bot.health <= (config.modded?.rangedEvadeHealth || 16)) return true
  if (threat.ranged && !bot.inventory?.items?.().some(item => item.name === 'shield')) return true
  return false
}

function recentDamageSignal (memory) {
  const last = (memory?.ai?.moddedThreats?.damageEvents || []).at(-1)
  if (!last || Date.now() - last.at > 5000) return null
  return { fastDrop: last.lost >= 5, lost: last.lost }
}

function includesAny (text, words) {
  return words.some(word => text.includes(word))
}

function vanillaScore (name) {
  if (['creeper', 'warden', 'ghast', 'blaze'].includes(name)) return 80
  if (['skeleton', 'stray', 'witch', 'pillager'].includes(name)) return 70
  if (['zombie', 'zombie_villager', 'husk', 'drowned', 'spider', 'cave_spider'].includes(name)) return 45
  return 50
}

function threatLevel (score) {
  if (score >= 85) return 'critical'
  if (score >= 65) return 'high'
  if (score >= 35) return 'watch'
  return 'low'
}

function recommendation (score, reasons) {
  if (score >= 85 || reasons.includes('projectile_or_bullet')) return 'evade_or_take_cover'
  if (reasons.includes('ranged_weapon_signal')) return 'shield_or_cover_before_fighting'
  if (score >= 65) return 'prepare_before_engaging'
  return 'monitor'
}

module.exports = {
  VANILLA_HOSTILES,
  classifyEntityThreat,
  listAdaptiveThreats,
  findAdaptiveThreat,
  adaptiveThreatSummary,
  recordObservedThreats,
  recordDamageMemory,
  shouldEvadeThreat
}

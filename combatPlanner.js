const { fightEntitySmart, findBestHostileThreat, equipBestWeapon, equipBestShield } = require('./combat')
const { equipBestArmorFromInventory } = require('./equipment')
const { loadoutStatus } = require('./loadouts')

async function prepareForCombat (bot, memory, config, speaker, signal) {
  await equipBestArmorFromInventory(bot, config).catch(() => {})
  await equipBestWeapon(bot).catch(() => {})
  await equipBestShield(bot).catch(() => {})
  const loadout = loadoutStatus(bot, 'combat_trip')
  if (!loadout.ready && loadout.missing.includes('food')) throw new Error('combat loadout missing food')
}

async function fightBestThreat (bot, memory, config, speaker, signal, options = {}) {
  await prepareForCombat(bot, memory, config, speaker, signal)
  const threat = options.target || findBestHostileThreat(bot, config, false)
  if (!threat) throw new Error('no threat visible')
  if (isAllowedPlayer(bot, config, threat)) throw new Error('refusing friendly fire')
  await fightEntitySmart(bot, memory, config, speaker, threat, signal, {
    maxChaseDistance: options.maxChaseDistance || config.behavior?.protectMaxChaseDistance || 12,
    attackRange: options.attackRange || 3.2,
    tickMs: options.tickMs || config.behavior?.protectTickMs || 350
  })
}

function isAllowedPlayer (bot, config, entity) {
  if (entity?.type !== 'player') return false
  return (config.allowedPlayers || []).includes(entity.username)
}

module.exports = {
  prepareForCombat,
  fightBestThreat
}

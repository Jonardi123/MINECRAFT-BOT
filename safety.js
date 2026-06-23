const { VANILLA_HOSTILES, findAdaptiveThreat } = require('./modThreat')

const HOSTILES = VANILLA_HOSTILES

function isLowHealth (bot, config) {
  return bot.health <= config.behavior.lowHealth
}

function hostileNearby (bot, range, config = {}, memory = null) {
  return findAdaptiveThreat(bot, config, memory, range) || bot.nearestEntity(entity => {
    return entity?.isValid && HOSTILES.has(entity.name) && entity.position.distanceTo(bot.entity.position) <= range
  })
}

function dangerousBlockNear (bot, pos) {
  const offsets = [
    [0, 0, 0], [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]
  ]
  return offsets.some(([x, y, z]) => {
    const block = bot.blockAt(pos.offset(x, y, z))
    return block && (block.name.includes('lava') || block.name === 'fire' || block.name === 'magma_block')
  })
}

module.exports = {
  HOSTILES,
  isLowHealth,
  hostileNearby,
  dangerousBlockNear
}

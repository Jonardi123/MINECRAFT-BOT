const { durabilityRatio } = require('./equipment')

function getStatus (bot, tasks, protector, pvp, ai, mobDefense, dispatcher) {
  const armor = ['head', 'torso', 'legs', 'feet']
    .map(slot => bot.inventory.slots[bot.getEquipmentDestSlot(slot)])
    .filter(Boolean).length
  const tool = bot.heldItem ? `${bot.heldItem.name}${durabilityText(bot.heldItem)}` : 'empty hand'
  const pos = bot.entity.position.floored()
  const pvpText = pvp ? `, pvp: ${pvp.enabled ? (pvp.active ? `fighting ${pvp.targetName || 'player'}` : 'on') : 'off'}` : ''
  const mobText = mobDefense ? `, mobs: ${mobDefense.enabled ? (mobDefense.active ? `fighting ${mobDefense.targetName || 'mob'}` : 'armed') : 'off'}` : ''
  const dispatcherText = dispatcher ? `, ${dispatcher.status()}` : ''
  const aiText = ai ? `, ai: ${ai.enabled ? 'on' : 'paused'}${ai.goal ? ` (${ai.goal.slice(0, 35)})` : ''}` : ''
  return `Task: ${tasks.currentTask || 'idle'}, HP: ${bot.health}, food: ${bot.food}, armor: ${armor}/4, tool: ${tool}, protect: ${protector.enabled ? 'on' : 'off'}${pvpText}${mobText}${dispatcherText}${aiText}, loc: ${pos.x} ${pos.y} ${pos.z}.`
}

function durabilityText (item) {
  if (!item?.maxDurability) return ''
  return ` ${Math.round(durabilityRatio(item) * 100)}%`
}

module.exports = { getStatus }

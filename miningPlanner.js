const { smartMineResource, branchMineForResource, staircaseMine, safeCaveExplore } = require('./mining')
const { ensurePickaxe, equipBestArmorFromInventory } = require('./equipment')
const { loadoutStatus } = require('./loadouts')
const { countInventory } = require('./inventory')

async function executeMiningPlan (bot, memory, config, speaker, plan, signal) {
  const target = plan.target || 'iron'
  const amount = Math.max(1, plan.amount || 4)
  const loadout = loadoutStatus(bot, target.includes('diamond') ? 'mining_trip' : 'basic_survival')
  if (!loadout.ready && loadout.missing.includes('food')) throw new Error('mining loadout missing food')
  await ensurePickaxe(bot, memory, config, speaker, signal)
  await equipBestArmorFromInventory(bot, config).catch(() => {})

  if (target.includes('diamond')) {
    await planDiamondMine(bot, memory, config, speaker, amount, signal)
    return
  }

  if (target.includes('coal') || target.includes('iron')) {
    await safeCaveExplore(bot, memory, config, speaker, 16, signal).catch(() => {})
    await smartMineResource(bot, memory, config, speaker, target, amount, signal)
    return
  }

  await smartMineResource(bot, memory, config, speaker, target, amount, signal)
}

async function planDiamondMine (bot, memory, config, speaker, amount, signal) {
  const counts = countInventory(bot)
  if (!counts.iron_pickaxe && !counts.diamond_pickaxe && !counts.netherite_pickaxe) {
    throw new Error('diamond mining needs iron pickaxe or better')
  }
  const targetY = config.director?.diamondSafeY ?? -54
  if (Math.floor(bot.entity.position.y) > targetY + 3) {
    await staircaseMine(bot, memory, config, speaker, targetY, signal)
  }
  memory.ai = memory.ai || {}
  memory.ai.miningPlan = memory.ai.miningPlan || {}
  memory.ai.miningPlan.lastDiamondTunnel = {
    x: Math.floor(bot.entity.position.x),
    y: Math.floor(bot.entity.position.y),
    z: Math.floor(bot.entity.position.z)
  }
  await branchMineForResource(bot, memory, config, speaker, 'diamond', amount, signal)
}

function chooseMiningPlan (goal) {
  const text = String(goal || '').toLowerCase()
  if (text.includes('diamond')) return { strategy: 'safe_branch_mine', target: 'diamond', amount: targetAmount(text, 4) }
  if (text.includes('coal')) return { strategy: 'exposed_then_prospect', target: 'coal', amount: targetAmount(text, 8) }
  if (text.includes('iron')) return { strategy: 'exposed_then_prospect', target: 'iron', amount: targetAmount(text, 8) }
  return { strategy: 'smart_mine', target: 'stone', amount: targetAmount(text, 16) }
}

function targetAmount (text, fallback) {
  const stackMatch = text.match(/(\d+)\s*stacks?/)
  if (stackMatch) return Number(stackMatch[1]) * 64
  const numberMatch = text.match(/(\d+)/)
  return numberMatch ? Number(numberMatch[1]) : fallback
}

module.exports = {
  executeMiningPlan,
  chooseMiningPlan
}

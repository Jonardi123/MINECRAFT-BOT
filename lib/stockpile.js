const { countChestItems } = require('../chest')
const { saveMemory } = require('../memory')

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 80)
}

function mergeInto (target, source) {
  for (const [name, count] of Object.entries(source || {})) {
    target[name] = (target[name] || 0) + count
  }
}

function assertActive (signal) {
  if (signal?.cancelled) throw new Error('Task cancelled')
}

async function scanStockpiles (bot, memory, config, signal) {
  assertActive(signal)
  memory.chests = memory.chests || {}
  const kinds = Object.keys(memory.chests).filter(kind => Boolean(memory.chests[kind]))

  const counts = {}
  const byChest = {}
  const failures = []

  for (const kind of kinds) {
    assertActive(signal)
    try {
      const chestCounts = await countChestItems(bot, memory, config, kind, signal)
      byChest[kind] = chestCounts
      mergeInto(counts, chestCounts)
    } catch (err) {
      failures.push({ chest: kind, reason: shortError(err) })
    }
  }

  const report = { counts, byChest, scannedAt: new Date().toISOString(), failures }
  memory.stockpiles = report
  saveMemory(memory)
  return report
}

function formatStockpileScan (report) {
  if (!report?.scannedAt) return 'Stockpile scan: no data yet.'
  const entries = Object.entries(report.counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
  const chestCount = Object.keys(report.byChest || {}).length
  const failureCount = (report.failures || []).length

  const parts = []
  parts.push(`Stockpile scan: ${entries.map(([name, count]) => `${name} ${count}`).join(', ') || 'empty'}`)
  if (chestCount) parts.push(`${chestCount} chest${chestCount === 1 ? '' : 's'} scanned`)
  if (failureCount) parts.push(`${failureCount} chest${failureCount === 1 ? '' : 's'} failed`)
  return parts.join('. ') + '.'
}

module.exports = {
  scanStockpiles,
  formatStockpileScan
}
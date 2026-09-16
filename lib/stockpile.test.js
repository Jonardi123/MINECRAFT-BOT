const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

function stubModule (resolvedPath, exports) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports }
}

let chestBehavior = {}
let savedCount = 0

stubModule(require.resolve('../chest.js'), {
  countChestItems: async (bot, memory, config, kind, signal) => {
    const handler = chestBehavior[kind]
    if (!handler) throw new Error(`No ${kind} chest saved or nearby.`)
    return handler(signal)
  }
})

stubModule(require.resolve('../memory.js'), {
  saveMemory: () => { savedCount++ }
})

const { scanStockpiles, formatStockpileScan } = require('./stockpile')

beforeEach(() => {
  chestBehavior = {}
  savedCount = 0
})

function memoryWithChests () {
  return {
    ai: {},
    chests: {
      storage: { x: 10, y: 64, z: 20 },
      farm: null,
      botStorage: { x: 15, y: 64, z: 25 }
    }
  }
}

test('scanStockpiles aggregates counts across saved chest kinds and persists the report', async () => {
  const memory = memoryWithChests()
  chestBehavior = {
    storage: async () => ({ iron_ingot: 64, oak_log: 10 }),
    botStorage: async () => ({ iron_ingot: 32, bread: 8 })
  }

  const report = await scanStockpiles({}, memory, {}, { cancelled: false })

  assert.deepEqual(report.counts, { iron_ingot: 96, oak_log: 10, bread: 8 })
  assert.deepEqual(report.byChest, {
    storage: { iron_ingot: 64, oak_log: 10 },
    botStorage: { iron_ingot: 32, bread: 8 }
  })
  assert.equal(typeof report.scannedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(report.scannedAt)))
  assert.deepEqual(report.failures, [])
  assert.equal(memory.stockpiles, report)
  assert.equal(savedCount, 1)
})

test('scanStockpiles skips chests without a saved position', async () => {
  const memory = {
    ai: {},
    chests: {
      storage: { x: 10, y: 64, z: 20 },
      farm: null,
      botStorage: null
    }
  }
  chestBehavior = { storage: async () => ({ oak_log: 4 }) }

  const report = await scanStockpiles({}, memory, {}, { cancelled: false })

  assert.deepEqual(report.counts, { oak_log: 4 })
  assert.deepEqual(Object.keys(report.byChest), ['storage'])
  assert.deepEqual(report.failures, [])
})

test('a failing chest kind is recorded but does not abort the scan', async () => {
  const memory = memoryWithChests()
  chestBehavior = {
    botStorage: async () => ({ dirt: 16 })
  }

  const report = await scanStockpiles({}, memory, {}, { cancelled: false })

  assert.deepEqual(report.counts, { dirt: 16 })
  assert.deepEqual(Object.keys(report.byChest), ['botStorage'])
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].chest, 'storage')
  assert.equal(report.failures[0].reason, 'No storage chest saved or nearby.')
  assert.equal(savedCount, 1)
})

test('scanStockpiles throws immediately when already cancelled', async () => {
  const memory = memoryWithChests()
  await assert.rejects(
    scanStockpiles({}, memory, {}, { cancelled: true }),
    /Task cancelled/
  )
  assert.equal(savedCount, 0)
  assert.equal(memory.stockpiles, undefined)
})

test('cancellation between chests aborts the scan without saving', async () => {
  const memory = memoryWithChests()
  const signal = { cancelled: false }
  chestBehavior = {
    storage: async () => {
      signal.cancelled = true
      return { oak_log: 4 }
    },
    botStorage: async () => ({ dirt: 16 })
  }

  await assert.rejects(scanStockpiles({}, memory, {}, signal), /Task cancelled/)
  assert.equal(savedCount, 0)
  assert.equal(memory.stockpiles, undefined)
})

test('empty chest memory yields an empty report', async () => {
  const memory = { ai: {}, chests: {} }
  const report = await scanStockpiles({}, memory, {}, { cancelled: false })

  assert.deepEqual(report.counts, {})
  assert.deepEqual(report.byChest, {})
  assert.deepEqual(report.failures, [])
  assert.ok(report.scannedAt)
  assert.equal(savedCount, 1)
})

test('formatStockpileScan shows item counts, chest count and failures', () => {
  const text = formatStockpileScan({
    counts: { iron_ingot: 96, oak_log: 10, bread: 8 },
    byChest: { storage: {}, botStorage: {} },
    failures: [{ chest: 'farm', reason: 'No farm chest saved or nearby.' }],
    scannedAt: new Date().toISOString()
  })
  assert.equal(text, 'Stockpile scan: iron_ingot 96, oak_log 10, bread 8. 2 chests scanned. 1 chest failed.')
})

test('formatStockpileScan handles null and empty reports', () => {
  assert.equal(formatStockpileScan(null), 'Stockpile scan: no data yet.')
  assert.equal(formatStockpileScan({}), 'Stockpile scan: no data yet.')
  assert.equal(
    formatStockpileScan({ counts: {}, byChest: {}, failures: [], scannedAt: new Date().toISOString() }),
    'Stockpile scan: empty.'
  )
})
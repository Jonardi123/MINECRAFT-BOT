const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorldSummary, summaryForPrompt } = require('../worldSummary')

class FakeVec {
  constructor (x, y, z) {
    this.x = x
    this.y = y
    this.z = z
  }
  distanceTo (other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

function makeEntity (name, pos, options = {}) {
  return {
    name,
    username: options.username || null,
    displayName: options.displayName || null,
    type: options.type || 'mob',
    isValid: options.isValid !== false,
    position: pos
  }
}

function makeBot (options = {}) {
  const pos = options.pos || new FakeVec(0, 64, 0)
  const worldBlocks = options.blocks || []
  return {
    health: options.health ?? 20,
    food: options.food ?? 20,
    heldItem: options.heldItem || null,
    game: { dimension: options.dimension || 'minecraft:overworld', dimensionName: options.dimension || 'minecraft:overworld' },
    entity: { position: pos },
    inventory: {
      items: () => (options.items || []).map(item => ({ name: item.name, count: item.count }))
    },
    entities: options.entities || {},
    findBlocks ({ matching, maxDistance, count = 40 }) {
      let found = 0
      const out = []
      for (const block of worldBlocks) {
        if (found >= count) break
        const blockPos = new FakeVec(block.x, block.y, block.z)
        if (pos.distanceTo(blockPos) > maxDistance) continue
        if (!matching({ name: block.name, position: blockPos })) continue
        out.push(blockPos)
        found++
      }
      return out
    },
    blockAt (vec) {
      for (const block of worldBlocks) {
        if (block.x === vec.x && block.y === vec.y && block.z === vec.z) {
          return { name: block.name, position: new FakeVec(block.x, block.y, block.z) }
        }
      }
      return null
    }
  }
}

test('createWorldSummary reports goal, task, health, held item, dimension and position', () => {
  const bot = makeBot({
    health: 14,
    food: 7,
    heldItem: { name: 'diamond_pickaxe' },
    dimension: 'minecraft:the_nether',
    pos: new FakeVec(10.7, 20.9, 30.1)
  })
  const memory = {
    ai: {
      currentGoal: 'mine diamonds',
      shortTermTask: 'dig down',
      director: { currentStage: 2, currentStep: 3 }
    }
  }
  const tasks = { currentTask: 'mine_diamonds' }
  const protector = { enabled: true }
  const pvp = { enabled: true, active: true, targetName: 'steve' }
  const summary = createWorldSummary(bot, memory, {}, tasks, protector, pvp, memory)

  assert.equal(summary.currentGoal, 'mine diamonds')
  assert.equal(summary.currentTask, 'mine_diamonds')
  assert.equal(summary.shortTermTask, 'dig down')
  assert.equal(summary.health, 14)
  assert.equal(summary.food, 7)
  assert.deepEqual(summary.position, { x: 10, y: 20, z: 30 })
  assert.equal(summary.dimension, 'minecraft:the_nether')
  assert.equal(summary.heldItem, 'diamond_pickaxe')
  assert.deepEqual(summary.director, { stage: 2, step: 3 })
  assert.deepEqual(summary.combat, {
    pvp: { enabled: true, active: true, target: 'steve' },
    protector: { enabled: true }
  })
})

test('inventory is a count map aggregated across stacks', () => {
  const bot = makeBot({
    items: [
      { name: 'oak_log', count: 12 },
      { name: 'iron_ingot', count: 3 },
      { name: 'oak_log', count: 4 }
    ]
  })
  const summary = createWorldSummary(bot, {}, {}, null, null, null, {})
  assert.deepEqual(summary.inventory, { oak_log: 16, iron_ingot: 3 })
})

test('heldItem falls back to empty hand', () => {
  const summary = createWorldSummary(makeBot(), {}, {}, null, null, null, {})
  assert.equal(summary.heldItem, 'empty hand')
})

test('hostileMobs lists only hostile entities within range, nearest first', () => {
  const zero = new FakeVec(0, 64, 0)
  const bot = makeBot({
    entities: {
      cow: makeEntity('cow', new FakeVec(0, 64, 3), { type: 'passive' }),
      creeper: makeEntity('creeper', new FakeVec(0, 64, 30)),
      zombie: makeEntity('zombie', new FakeVec(0, 64, 5)),
      skeleton: makeEntity('skeleton', new FakeVec(0, 64, 12)),
      steve: makeEntity('steve', new FakeVec(0, 64, 2), { type: 'player', username: 'steve' })
    }
  })
  const summary = createWorldSummary(bot, {}, {}, null, null, null, {})
  assert.equal(summary.hostileMobs.length, 2)
  assert.deepEqual(summary.hostileMobs[0], { name: 'zombie', distance: 5 })
  assert.deepEqual(summary.hostileMobs[1], { name: 'skeleton', distance: 12 })
  assert.equal(zero.distanceTo(new FakeVec(0, 64, 0)), 0)
})

test('adaptiveThreats classifies hostiles but excludes passive mobs', () => {
  const bot = makeBot({
    entities: {
      cow: makeEntity('cow', new FakeVec(0, 64, 3)),
      zombie: makeEntity('zombie', new FakeVec(0, 64, 5))
    }
  })
  const summary = createWorldSummary(bot, {}, {}, null, null, null, {})
  const names = summary.adaptiveThreats.map(entry => entry.name)
  assert.ok(names.includes('zombie'))
  assert.ok(!names.includes('cow'))
})

test('visibleBlocks includes notable blocks sorted by distance', () => {
  const bot = makeBot({
    blocks: [
      { name: 'lava', x: 0, y: 64, z: 50 },
      { name: 'diamond_ore', x: 0, y: 64, z: 10 },
      { name: 'dirt', x: 0, y: 64, z: 2 },
      { name: 'crafting_table', x: -3, y: 64, z: 0 },
      { name: 'iron_ore', x: 0, y: 64, z: 5 }
    ]
  })
  const summary = createWorldSummary(bot, {}, {}, null, null, null, {})
  assert.deepEqual(summary.visibleBlocks, [
    { name: 'crafting_table', distance: 3 },
    { name: 'iron_ore', distance: 5 },
    { name: 'diamond_ore', distance: 10 }
  ])
})

test('visibleBlocks is capped at 20', () => {
  const blocks = []
  for (let i = 1; i <= 25; i++) {
    blocks.push({ name: 'iron_ore', x: 0, y: 64, z: i })
  }
  const summary = createWorldSummary(makeBot({ blocks }), {}, {}, null, null, null, {})
  assert.equal(summary.visibleBlocks.length, 20)
})

test('missing memory and empty world yield safe defaults', () => {
  const summary = createWorldSummary(makeBot(), {}, {}, null, null, null, {})
  assert.deepEqual(summary.hostileMobs, [])
  assert.deepEqual(summary.visibleBlocks, [])
  assert.deepEqual(summary.failedActions, [])
  assert.deepEqual(summary.recentDecisions, [])
  assert.deepEqual(summary.director, { stage: null, step: null })
  assert.deepEqual(summary.combat, {
    pvp: { enabled: false, active: false, target: null },
    protector: { enabled: false }
  })
  assert.ok(summary.rewardLearning.priorities)
})

test('rewardLearning reports best behaviors and lessons from memory', () => {
  const memory = {
    ai: {
      rewards: {
        scores: { mine_diamonds: 50, build_shelter: 80, fight_mobs: 10 },
        lessons: [
          { cause: 'lava', lesson: 'avoid lava without bucket' },
          { cause: 'fall', lesson: 'never dig straight down' }
        ]
      }
    }
  }
  const summary = createWorldSummary(makeBot(), memory, {}, null, null, null, {})
  assert.deepEqual(summary.rewardLearning.bestBehaviors, ['build_shelter:80', 'mine_diamonds:50', 'fight_mobs:10'])
  assert.equal(summary.rewardLearning.recentLessons.length, 2)
})

test('summaryForPrompt returns a JSON string covering key fields', () => {
  const bot = makeBot({
    blocks: [{ name: 'iron_ore', x: 0, y: 64, z: 5 }],
    items: [{ name: 'oak_log', count: 8 }]
  })
  const memory = { ai: { currentGoal: 'get iron', director: { currentStage: 1, currentStep: 2 } } }
  const summary = createWorldSummary(bot, memory, {}, { currentTask: 'mine_iron' }, null, null, memory)
  const text = summaryForPrompt(summary)

  assert.equal(typeof text, 'string')
  const parsed = JSON.parse(text)
  assert.equal(parsed.currentGoal, 'get iron')
  assert.equal(parsed.currentTask, 'mine_iron')
  assert.equal(parsed.heldItem, 'empty hand')
  assert.deepEqual(parsed.director, { stage: 1, step: 2 })
  assert.ok(text.includes('5m iron_ore'))
})
const PALETTES = {
  oak_cobblestone: {
    label: 'oak + cobblestone',
    roles: {
      floor: ['oak_planks'],
      wall: ['oak_planks'],
      pillar: ['oak_log', 'stripped_oak_log'],
      foundation: ['cobblestone', 'stone'],
      trim: ['cobblestone', 'stone'],
      roof: ['oak_planks', 'cobblestone'],
      roof_stair: ['oak_stairs'],
      roof_slab: ['oak_slab'],
      stair: ['oak_stairs'],
      slab: ['oak_slab'],
      fence: ['oak_fence'],
      trapdoor: ['oak_trapdoor'],
      balcony: ['oak_planks'],
      railing: ['oak_fence'],
      path: ['cobblestone', 'stone', 'oak_slab'],
      farm: ['dirt', 'coarse_dirt', 'grass_block'],
      farm_border: ['oak_fence'],
      farm_water: ['blue_stained_glass', 'glass'],
      chimney: ['cobblestone', 'stone'],
      window: ['glass', 'glass_pane'],
      door: ['oak_door'],
      lantern: ['lantern', 'torch'],
      torch: ['torch'],
      chest: ['chest'],
      crafting: ['crafting_table'],
      furnace: ['furnace']
    }
  },
  spruce_stone_bricks: {
    label: 'spruce + stone bricks',
    roles: {
      floor: ['spruce_planks'],
      wall: ['spruce_planks'],
      pillar: ['spruce_log', 'stripped_spruce_log'],
      foundation: ['stone_bricks', 'cobblestone', 'stone'],
      trim: ['stone_bricks', 'cobblestone', 'stone'],
      roof: ['spruce_planks', 'stone_bricks'],
      roof_stair: ['spruce_stairs'],
      roof_slab: ['spruce_slab'],
      stair: ['spruce_stairs'],
      slab: ['spruce_slab'],
      fence: ['spruce_fence'],
      trapdoor: ['spruce_trapdoor'],
      balcony: ['spruce_planks'],
      railing: ['spruce_fence'],
      path: ['stone_bricks', 'cobblestone', 'spruce_slab'],
      farm: ['dirt', 'coarse_dirt', 'grass_block'],
      farm_border: ['spruce_fence'],
      farm_water: ['blue_stained_glass', 'glass'],
      chimney: ['stone_bricks', 'cobblestone', 'stone'],
      window: ['glass', 'glass_pane'],
      door: ['spruce_door'],
      lantern: ['lantern', 'torch'],
      torch: ['torch'],
      chest: ['chest'],
      crafting: ['crafting_table'],
      furnace: ['furnace']
    }
  },
  cherry_quartz: {
    label: 'cherry + quartz',
    roles: {
      floor: ['cherry_planks', 'oak_planks'],
      wall: ['cherry_planks', 'oak_planks'],
      pillar: ['cherry_log', 'stripped_cherry_log', 'oak_log'],
      foundation: ['quartz_block', 'smooth_quartz', 'stone_bricks'],
      trim: ['quartz_block', 'smooth_quartz', 'quartz_pillar', 'stone_bricks'],
      roof: ['cherry_planks', 'quartz_block', 'oak_planks'],
      roof_stair: ['cherry_stairs', 'quartz_stairs', 'oak_stairs'],
      roof_slab: ['cherry_slab', 'quartz_slab', 'oak_slab'],
      stair: ['cherry_stairs', 'quartz_stairs', 'oak_stairs'],
      slab: ['cherry_slab', 'quartz_slab', 'oak_slab'],
      fence: ['cherry_fence', 'oak_fence'],
      trapdoor: ['cherry_trapdoor', 'oak_trapdoor'],
      balcony: ['cherry_planks', 'oak_planks'],
      railing: ['cherry_fence', 'oak_fence'],
      path: ['quartz_block', 'smooth_quartz', 'stone_bricks'],
      farm: ['dirt', 'coarse_dirt', 'grass_block'],
      farm_border: ['cherry_fence', 'oak_fence'],
      farm_water: ['blue_stained_glass', 'glass'],
      chimney: ['quartz_block', 'smooth_quartz', 'stone_bricks'],
      window: ['glass', 'glass_pane'],
      door: ['cherry_door', 'oak_door'],
      lantern: ['lantern', 'torch'],
      torch: ['torch'],
      chest: ['chest'],
      crafting: ['crafting_table'],
      furnace: ['furnace']
    }
  }
}

const ROLE_ORDER = {
  floor: 0,
  foundation: 1,
  pillar: 2,
  wall: 3,
  window: 4,
  door: 5,
  balcony: 6,
  path: 7,
  farm: 8,
  farm_water: 9,
  roof: 10,
  roof_stair: 11,
  roof_slab: 12,
  slab: 13,
  stair: 14,
  fence: 15,
  railing: 16,
  farm_border: 17,
  trapdoor: 18,
  trim: 19,
  chimney: 20,
  crafting: 21,
  chest: 22,
  furnace: 23,
  lantern: 24,
  torch: 25
}

function createBaseBlueprint (variant = 'fancy') {
  return variant === 'small' ? createSmallBase() : createFancyBase()
}

function normalizeBaseVariant (value) {
  const text = String(value || '').toLowerCase()
  if (text === 'small' || text === 'starter' || text === 'basic') return 'small'
  return 'fancy'
}

function normalizePaletteName (value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  if (!text) return null
  if (text === 'oak' || text === 'oak_cobble' || text === 'oak_cobblestone') return 'oak_cobblestone'
  if (text === 'spruce' || text === 'stone' || text === 'stone_brick' || text === 'stone_bricks' || text === 'spruce_stone') return 'spruce_stone_bricks'
  if (text === 'cherry' || text === 'quartz' || text === 'cherry_quartz') return 'cherry_quartz'
  return PALETTES[text] ? text : null
}

function createSmallBase () {
  const b = createBuilder('small', 'small starter base')

  for (let z = -2; z <= 2; z++) {
    for (let x = -2; x <= 2; x++) b.add('floor', x, -1, z)
  }
  for (let x = -1; x <= 1; x++) b.add('floor', x, -1, -3)

  const windows = new Set([
    key(-2, 1, 0), key(2, 1, 0), key(-1, 1, 2), key(1, 1, 2)
  ])
  for (let y = 0; y <= 2; y++) {
    for (let z = -2; z <= 2; z++) {
      for (let x = -2; x <= 2; x++) {
        const perimeter = Math.abs(x) === 2 || Math.abs(z) === 2
        if (!perimeter) continue
        if (x === 0 && z === -2 && y < 2) continue
        if (windows.has(key(x, y, z))) b.add('window', x, y, z)
        else if ((Math.abs(x) === 2 && Math.abs(z) === 2) || (z === -2 && Math.abs(x) === 1)) b.add('pillar', x, y, z)
        else if (y === 0) b.add('foundation', x, y, z)
        else b.add('wall', x, y, z)
      }
    }
  }

  for (let z = -3; z <= 3; z++) {
    for (let x = -3; x <= 3; x++) b.add('roof', x, 3, z)
  }
  for (let x = -1; x <= 1; x++) b.add('roof', x, 4, 0)

  b.add('door', 0, 0, -2)
  b.add('crafting', -1, 0, 1)
  b.add('chest', 1, 0, 1)
  b.add('torch', 0, 0, 0)
  b.add('torch', 0, 0, -3)

  return b.done()
}

function createFancyBase () {
  const b = createBuilder('fancy', 'fancy starter base')

  for (let z = -4; z <= 4; z++) {
    for (let x = -5; x <= 5; x++) b.add('floor', x, -1, z)
  }
  for (let z = -6; z <= -5; z++) {
    for (let x = -3; x <= 3; x++) b.add('floor', x, -1, z)
  }

  const windows = new Set([
    key(-3, 1, -4), key(-3, 2, -4), key(3, 1, -4), key(3, 2, -4),
    key(-5, 1, -2), key(-5, 2, -2), key(-5, 1, 1), key(-5, 2, 1),
    key(5, 1, -2), key(5, 2, -2), key(5, 1, 1), key(5, 2, 1),
    key(-3, 1, 4), key(-3, 2, 4), key(0, 1, 4), key(0, 2, 4), key(3, 1, 4), key(3, 2, 4),
    key(-2, 4, -3), key(2, 4, -3),
    key(-4, 4, 0), key(4, 4, 0),
    key(-2, 4, 3), key(2, 4, 3)
  ])

  for (let y = 0; y <= 2; y++) {
    for (let z = -4; z <= 4; z++) {
      for (let x = -5; x <= 5; x++) {
        const perimeter = Math.abs(x) === 5 || Math.abs(z) === 4
        if (!perimeter) continue
        if (x === 0 && z === -4 && y < 2) continue
        if (windows.has(key(x, y, z))) b.add('window', x, y, z)
        else if ((Math.abs(x) === 5 && Math.abs(z) === 4) || (z === -4 && [1, -1, 5, -5].includes(x))) b.add('pillar', x, y, z)
        else if (y === 0) b.add('foundation', x, y, z)
        else b.add('wall', x, y, z)
      }
    }
  }

  for (let z = -2; z <= 2; z++) {
    for (let x = -3; x <= 3; x++) b.add('floor', x, 2, z)
  }
  for (let y = 3; y <= 4; y++) {
    for (let z = -3; z <= 3; z++) {
      for (let x = -4; x <= 4; x++) {
        const perimeter = Math.abs(x) === 4 || Math.abs(z) === 3
        if (!perimeter) continue
        if (x === 0 && z === -3 && y <= 4) continue
        if (windows.has(key(x, y, z))) b.add('window', x, y, z)
        else if (Math.abs(x) === 4 && Math.abs(z) === 3) b.add('pillar', x, y, z)
        else b.add('wall', x, y, z)
      }
    }
  }

  for (let z = -6; z <= -5; z++) {
    for (let x = -3; x <= 3; x++) b.add('balcony', x, 2, z)
  }
  for (let y = 0; y <= 2; y++) {
    b.add('pillar', -3, y, -6)
    b.add('pillar', 3, y, -6)
  }
  for (let x = -3; x <= 3; x++) {
    if (x !== 0) b.add('railing', x, 3, -6)
  }
  for (let z = -6; z <= -5; z++) {
    b.add('railing', -4, 3, z)
    b.add('railing', 4, 3, z)
  }

  for (let z = -6; z <= -4; z++) {
    for (let x = -4; x <= 4; x++) b.add('roof_slab', x, 5, z)
  }
  for (let z = -4; z <= 4; z++) {
    b.add('roof_stair', -5, 5, z)
    b.add('roof_stair', 5, 5, z)
    for (let x = -4; x <= 4; x++) b.add('roof', x, 5, z)
  }
  for (let z = -2; z <= 2; z++) {
    for (let x = -3; x <= 3; x++) b.add('roof_slab', x, 5, z)
  }
  b.add('chimney', 4, 6, 1)

  b.add('door', 0, 0, -4)
  b.add('door', 0, 3, -3)
  b.add('crafting', -4, 0, 2)
  b.add('furnace', -4, 0, 1)
  b.add('furnace', -4, 0, 0)
  b.add('chest', 4, 0, 2)
  b.add('chest', 4, 0, 1)
  b.add('torch', 0, 0, 0)
  b.add('lantern', 0, 3, -6)
  b.add('lantern', -3, 0, -5)
  b.add('lantern', 3, 0, -5)
  b.add('torch', 3, 0, -1)
  b.add('torch', -3, 0, -1)
  b.add('torch', 0, 3, 0)

  for (let z = -5; z >= -12; z--) b.add('path', 0, -1, z)
  for (let z = -8; z >= -12; z--) {
    b.add('slab', -1, 0, z)
    b.add('slab', 1, 0, z)
  }

  for (let x = 7; x <= 11; x++) {
    for (let z = 0; z <= 4; z++) b.add('farm', x, -1, z)
  }
  b.add('farm_water', 9, 0, 2)
  for (let x = 6; x <= 12; x++) {
    b.add('farm_border', x, 0, -1)
    b.add('farm_border', x, 0, 5)
  }
  for (let z = 0; z <= 4; z++) {
    b.add('farm_border', 6, 0, z)
    b.add('farm_border', 12, 0, z)
  }
  b.add('lantern', 6, 1, -1)
  b.add('lantern', 12, 1, 5)

  for (const [x, y, z] of [
    [-4, 1, -5], [-2, 1, -5], [2, 1, -5], [4, 1, -5],
    [-6, 1, -2], [-6, 1, 1], [6, 1, -2], [6, 1, 1],
    [-4, 1, 5], [-2, 1, 5], [2, 1, 5], [4, 1, 5],
    [-3, 3, 4], [3, 3, 4]
  ]) b.add('trapdoor', x, y, z)

  return b.done()
}

function createBuilder (variant, label) {
  const steps = []
  const used = new Set()
  return {
    add (role, x, y, z) {
      const id = key(x, y, z)
      if (used.has(id)) return
      used.add(id)
      steps.push({ role, x, y, z })
    },
    done () {
      steps.sort((a, b) => a.y - b.y || (ROLE_ORDER[a.role] || 99) - (ROLE_ORDER[b.role] || 99) || a.z - b.z || a.x - b.x)
      return {
        variant,
        label,
        steps,
        bounds: boundsForSteps(steps)
      }
    }
  }
}

function boundsForSteps (steps) {
  return steps.reduce((bounds, step) => ({
    minX: Math.min(bounds.minX, step.x),
    maxX: Math.max(bounds.maxX, step.x),
    minY: Math.min(bounds.minY, step.y),
    maxY: Math.max(bounds.maxY, step.y),
    minZ: Math.min(bounds.minZ, step.z),
    maxZ: Math.max(bounds.maxZ, step.z)
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  })
}

function key (x, y, z) {
  return `${x},${y},${z}`
}

module.exports = {
  PALETTES,
  createBaseBlueprint,
  normalizeBaseVariant,
  normalizePaletteName
}

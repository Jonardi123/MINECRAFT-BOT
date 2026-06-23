const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MEMORY_PATH = process.env.MC_AI_BOT_MEMORY
  ? path.resolve(process.env.MC_AI_BOT_MEMORY)
  : path.join(ROOT, 'memory.json')
const SCENARIOS_PATH = path.join(__dirname, 'training-scenarios.json')
const OUTPUT_PATH = process.env.MC_AI_BOT_REPORT
  ? path.resolve(process.env.MC_AI_BOT_REPORT)
  : path.join(ROOT, 'NEBULA_TRAINING_REPORT.md')

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function count (value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

function topEntries (object, limit = 5, ascending = false) {
  return Object.entries(object || {})
    .sort((a, b) => ascending ? a[1] - b[1] : b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${value}`)
}

function statusFromRisk (risk) {
  if (risk >= 70) return 'needs attention'
  if (risk >= 35) return 'watch'
  return 'ready'
}

function statusRank (status) {
  if (status === 'needs attention') return 3
  if (status === 'watch') return 2
  return 1
}

function buildAgents (memory) {
  const ai = memory.ai || {}
  const rewards = ai.rewards || {}
  const tracker = ai.progressTracker || {}
  const director = ai.director || {}
  const curriculum = ai.curriculum || {}
  const movement = rewards.movement || {}
  const scores = rewards.scores || {}
  const failures = rewards.failurePatterns || {}

  const stuckRisk = count(tracker.pathTimeouts) * 12 + count(tracker.stuckPositions) * 8 + (movement.stuckEvents || 0) * 6
  const survivalRisk = Math.max(0, -(scores.dying || 0)) + Math.max(0, -(scores.failed_to_eat_while_hungry || 0))
  const miningRisk = count(tracker.blockTargetFailures) * 8 + (failures['mine:failed'] || 0) * 10
  const combatRisk = Math.max(0, -(scores.taking_damage || 0)) + Math.max(0, -(scores.dying || 0))
  const inventoryRisk = count(tracker.missingIngredients) * 7
  const memoryRisk = count(failures) * 4

  return [
    {
      name: 'SelfModelAgent',
      status: 'ready',
      focus: 'Tracks identity, embodiment, task, goal, risks, confidence, and next best action.',
      signal: 'commands !self, !reflect, and !risk are available when the bot is online'
    },
    {
      name: 'SessionAgent',
      status: 'ready',
      focus: 'Preflight, startup, bounded private-server sessions.',
      signal: `current goal=${ai.currentGoal || 'none'}, paused=${Boolean(ai.paused)}`
    },
    {
      name: 'MovementAgent',
      status: statusFromRisk(stuckRisk),
      focus: 'Pathfinding success, stuck recovery, route timing.',
      signal: `${count(tracker.pathTimeouts)} path timeouts, ${count(tracker.stuckPositions)} stuck positions, ${movement.stuckEvents || 0} movement stuck events`
    },
    {
      name: 'SurvivalAgent',
      status: statusFromRisk(survivalRisk),
      focus: 'Food, wood, starter tools, shelter, storage, safe recovery.',
      signal: `${count(curriculum.completed)} completed curriculum items, food priority=${rewards.priorities?.foodPriority ?? 'unknown'}`
    },
    {
      name: 'MiningAgent',
      status: statusFromRisk(miningRisk),
      focus: 'Ore gathering, tool readiness, hazard avoidance.',
      signal: `mining score=${scores.mining || 0}, block target failures=${count(tracker.blockTargetFailures)}`
    },
    {
      name: 'CombatAgent',
      status: statusFromRisk(combatRisk),
      focus: 'Controlled mob defense, retreat, shield/armor preparedness.',
      signal: `combat preparedness=${rewards.priorities?.combatPreparedness ?? 'unknown'}, damage score=${scores.taking_damage || 0}`
    },
    {
      name: 'ModdedThreatAgent',
      status: 'ready',
      focus: 'Treats unknown/modded mobs, bullets, guns, rifles, turrets, projectiles, and fast damage as adaptive threats.',
      signal: `${count(ai.moddedThreats?.observed)} observed threat types, ${count(ai.moddedThreats?.damageEvents)} remembered damage events`
    },
    {
      name: 'InventoryAgent',
      status: statusFromRisk(inventoryRisk),
      focus: 'Missing ingredients, inventory pressure, chest memory.',
      signal: `${count(tracker.missingIngredients)} missing ingredient events, ${count(memory.chests)} remembered chests`
    },
    {
      name: 'BuilderAgent',
      status: 'ready',
      focus: 'Player-like camp, shelter, and fancy starter base construction.',
      signal: `known base=${memory.botBase ? 'yes' : 'no'}, remembered chests=${count(memory.chests)}`
    },
    {
      name: 'DirectorAgent',
      status: director.blockedReason ? 'needs attention' : 'ready',
      focus: 'Autopilot objectives, blocked-step recovery, long-run autonomy.',
      signal: `mode=${director.mode || 'idle'}, step=${director.currentStep || 'none'}, blocked=${director.blockedReason || 'no'}`
    },
    {
      name: 'MemoryAgent',
      status: statusFromRisk(memoryRisk),
      focus: 'Reward history, repeated failures, lessons from deaths and stalls.',
      signal: `${count(rewards.lessons)} reward lessons, ${count(failures)} repeated failure patterns`
    }
  ]
}

function buildRecommendations (agents, scenarios, memory) {
  const ai = memory.ai || {}
  const rewards = ai.rewards || {}
  const tracker = ai.progressTracker || {}
  const scenarioByAgent = new Map((scenarios || []).map(scenario => [scenario.agent, scenario]))
  const weakestAgents = [...agents]
    .sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.name.localeCompare(b.name))
    .slice(0, 3)

  const recommendations = weakestAgents.map(agent => {
    const scenario = scenarioByAgent.get(agent.name)
    return {
      agent: agent.name,
      status: agent.status,
      reason: agent.signal,
      scenario: scenario?.id || 'baseline_validation',
      commands: scenario?.commands || ['npm.cmd run check', 'npm.cmd run training:report']
    }
  })

  const failures = topEntries(rewards.failurePatterns, 3)
  const pathProblems = count(tracker.pathTimeouts) + count(tracker.stuckPositions)
  if (pathProblems > 0 && !recommendations.some(item => item.agent === 'MovementAgent')) {
    recommendations.push({
      agent: 'MovementAgent',
      status: 'watch',
      reason: `${pathProblems} path/stuck signals in memory`,
      scenario: 'movement_pathfinding',
      commands: ['!come', '!follow 2', '!autoplay 10', '!autoplaystatus']
    })
  }

  if (failures.length > 0) {
    recommendations.push({
      agent: 'MemoryAgent',
      status: 'watch',
      reason: `top repeated failures: ${failures.join('; ')}`,
      scenario: 'marlow_full_run',
      commands: ['npm.cmd run test:bot -- marlow 420000', 'npm.cmd run training:report']
    })
  }

  return recommendations.slice(0, 5)
}

function markdownReport () {
  const memory = readJson(MEMORY_PATH, {})
  const scenarioFile = readJson(SCENARIOS_PATH, { scenarios: [], policy: 'Private/permitted servers only.' })
  const ai = memory.ai || {}
  const rewards = ai.rewards || {}
  const tracker = ai.progressTracker || {}
  const scenarios = scenarioFile.scenarios || []
  const agents = buildAgents(memory)
  const recommendations = buildRecommendations(agents, scenarios, memory)
  const lines = [
    '# Nebula Minecraft Training Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Safety rule: ${scenarioFile.policy}`,
    '',
    '## Agent Board',
    ''
  ]

  for (const agent of agents) {
    lines.push(`### ${agent.name}`)
    lines.push(`- Status: ${agent.status}`)
    lines.push(`- Focus: ${agent.focus}`)
    lines.push(`- Signal: ${agent.signal}`)
    lines.push('')
  }

  lines.push('## Next Weakness Drills', '')
  for (const item of recommendations) {
    lines.push(`### ${item.agent}`)
    lines.push(`- Status: ${item.status}`)
    lines.push(`- Why: ${item.reason}`)
    lines.push(`- Scenario: ${item.scenario}`)
    lines.push(`- Commands: ${item.commands.join('; ')}`)
    lines.push('')
  }

  lines.push('## Marlow Drill Presets', '')
  lines.push('- Fast check: `npm.cmd run check`')
  lines.push('- Report: `npm.cmd run training:report`')
  lines.push('- Bootstrap drill: `npm.cmd run test:bot -- bootstrap 180000`')
  lines.push('- Iron kit drill: `npm.cmd run test:bot -- ironkit 300000`')
  lines.push('- Cave safety drill: `npm.cmd run test:bot -- cavesafe 240000`')
  lines.push('- Full Marlow drill: `npm.cmd run test:bot -- marlow 420000`')
  lines.push('- Crafting drill: `npm.cmd run test:bot -- craftdrill 180000`')
  lines.push('- Fancy base drill: `npm.cmd run test:bot -- fancybase 180000`')
  lines.push('- PvP duel drill: `npm.cmd run test:bot -- duel 100000`')
  lines.push('- Spawned mob drill: `npm.cmd run test:bot -- mobdrill 130000`')
  lines.push('- Real-player smoke drill: `npm.cmd run test:bot -- realplayer 130000`')
  lines.push('- Full local temp-server suite: `npm.cmd run test:temp-server`')
  lines.push('')

  lines.push('## Scenario Queue', '')
  for (const scenario of scenarios) {
    lines.push(`### ${scenario.id}`)
    lines.push(`- Agent: ${scenario.agent}`)
    lines.push(`- Goal: ${scenario.goal}`)
    lines.push(`- Commands: ${scenario.commands.join('; ')}`)
    lines.push(`- Success metrics: ${scenario.success_metrics.join(', ')}`)
    lines.push(`- Stop conditions: ${scenario.stop_conditions.join(', ')}`)
    lines.push('')
  }

  lines.push('## Reward Snapshot', '')
  const best = topEntries(rewards.scores, 5)
  const worst = topEntries(rewards.scores, 5, true)
  lines.push(`- Best scores: ${best.length ? best.join('; ') : 'none yet'}`)
  lines.push(`- Worst scores: ${worst.length ? worst.join('; ') : 'none yet'}`)
  lines.push(`- Repeated failures: ${topEntries(rewards.failurePatterns, 5).join('; ') || 'none yet'}`)
  lines.push(`- Recent progress events: ${count(tracker.events)}`)
  lines.push('')

  lines.push('## Next Training Order', '')
  lines.push('1. Run `npm.cmd run check` before every session.')
  lines.push('2. Run `npm.cmd run training:report` and fix any agent marked `needs attention`.')
  lines.push('3. Start only a private/permitted server session with `npm.cmd start`.')
  lines.push('4. Train one scenario at a time, then run `npm.cmd run training:report` again.')
  lines.push('5. Record real metrics in Nebula after each session.')
  lines.push('')

  return lines.join('\n')
}

const report = markdownReport()
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
fs.writeFileSync(OUTPUT_PATH, report, 'utf8')
console.log(report)
console.error(`\nWrote ${OUTPUT_PATH}`)

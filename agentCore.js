const { chooseCurriculumObjective, markCurriculumResult, ensureCurriculumMemory } = require('./curriculum')
const { runRegisteredSkill, normalizeSkill, listSkillsForPrompt } = require('./skillRegistry')
const { critiqueSkill } = require('./critic')
const { snapshotProgress, ensureDirectorMemory, markBlocked } = require('./progressTracker')
const { recordFailureReward, rewardSummary } = require('./rewardSystem')

async function runAgentStep (bot, memory, config, speaker, signal, options = {}) {
  const agent = ensureAgentMemory(memory)
  const objective = options.objective || chooseCurriculumObjective(bot, memory, config)
  const skill = normalizeSkill(options.skill || objective.skill)
  agent.mode = 'running'
  agent.currentSkill = skill
  agent.currentObjective = objective
  agent.lastStartedAt = new Date().toISOString()
  ensureDirectorMemory(memory).currentObjective = skill

  const before = snapshotProgress(bot)
  try {
    await runRegisteredSkill(skill, { bot, memory, config, speaker }, signal)
    const after = snapshotProgress(bot)
    const verdict = critiqueSkill(skill, before, after, bot, memory)
    markCurriculumResult(memory, objective, verdict)
    agent.lastVerdict = verdict
    agent.lastFinishedAt = new Date().toISOString()
    if (!verdict.success) markBlocked(memory, skill, verdict.reason)
    return { objective, skill, verdict }
  } catch (err) {
    const verdict = { success: false, reason: String(err?.message || err).slice(0, 160) }
    recordFailureReward(memory, skill, err)
    markCurriculumResult(memory, objective, verdict)
    markBlocked(memory, skill, verdict.reason)
    agent.lastVerdict = verdict
    agent.lastFinishedAt = new Date().toISOString()
    throw err
  } finally {
    agent.currentSkill = null
  }
}

function agentPromptContext (memory) {
  return {
    curriculum: ensureCurriculumMemory(memory),
    rewardLearning: rewardSummary(memory),
    availableSkills: listSkillsForPrompt().slice(0, 24)
  }
}

function agentStatus (memory) {
  const agent = ensureAgentMemory(memory)
  const current = agent.currentObjective?.skill || agent.currentSkill || 'none'
  const verdict = agent.lastVerdict
  return [
    `agent ${agent.mode || 'idle'}`,
    `objective ${current}`,
    verdict ? `last ${verdict.success ? 'ok' : 'failed'}:${verdict.reason || 'none'}` : null
  ].filter(Boolean).join(', ')
}

function ensureAgentMemory (memory) {
  memory.ai = memory.ai || {}
  memory.ai.agent = memory.ai.agent || {}
  const agent = memory.ai.agent
  agent.mode = agent.mode || 'idle'
  agent.currentObjective = agent.currentObjective || null
  agent.currentSkill = agent.currentSkill || null
  agent.lastVerdict = agent.lastVerdict || null
  return agent
}

module.exports = {
  runAgentStep,
  agentPromptContext,
  agentStatus,
  ensureAgentMemory
}

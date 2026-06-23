async function getLlmStatus (config) {
  const ai = config.ai || {}
  if (!ai.enabled) return 'LLM is disabled in config.'

  const endpoint = ai.endpoint || 'http://127.0.0.1:1234/v1/chat/completions'
  const endpoints = modelEndpoints(endpoint)
  const errors = []

  for (const modelsEndpoint of endpoints) {
    try {
      const json = await fetchJson(modelsEndpoint, Math.min(ai.timeoutMs || 8000, 8000))
      const models = (json.data || []).map(model => model.id).filter(Boolean)
      if (!models.length) return 'LM Studio is running, but no model is loaded.'
      const configured = ai.model && ai.model !== 'auto' ? ai.model : null
      if (configured && models.includes(configured)) return `LLM online: ${configured}.`
      if (configured) return `LM Studio online, but ${configured} is not loaded.`
      return `LLM online: ${models[0]}.`
    } catch (err) {
      errors.push(shortError(err))
    }
  }

  return 'LM Studio not reachable. Start its local server on port 1234.'
}

async function fetchJson (endpoint, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  } finally {
    clearTimeout(timer)
  }
}

function modelEndpoints (chatEndpoint) {
  const primary = chatEndpoint.replace(/\/chat\/completions\/?$/, '/models')
  const alternatives = new Set([primary])
  if (primary.includes('127.0.0.1')) alternatives.add(primary.replace('127.0.0.1', 'localhost'))
  if (primary.includes('localhost')) alternatives.add(primary.replace('localhost', '127.0.0.1'))
  return Array.from(alternatives)
}

function shortError (err) {
  const message = err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err))
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) return 'connection refused'
  return message.replace(/\s+/g, ' ').slice(0, 80)
}

module.exports = { getLlmStatus }

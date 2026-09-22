const http = require('http')
const fs = require('fs')
const path = require('path')

const DEFAULT_PORT = 3000
const MAX_PORT_ATTEMPTS = 12
const MAX_LOGS = 250

function createDashboardServer (initialContext) {
  let context = initialContext
  let server = null
  let port = null
  const logs = []
  const seenBotIds = new WeakSet()

  attachBotLogs(context?.bot)

  const api = {
    updateContext (nextContext) {
      context = nextContext
      attachBotLogs(context?.bot)
    },
    get port () {
      return port
    },
    get url () {
      return port ? `http://localhost:${port}/` : null
    },
    stop () {
      if (server) server.close()
      server = null
      port = null
    }
  }

  listenOnAvailablePort(initialContext?.config?.dashboard?.port || DEFAULT_PORT, 0)
  return api

  function listenOnAvailablePort (startPort, attempt) {
    const desiredPort = startPort + attempt
    const nextServer = http.createServer((req, res) => {
      handleRequest(req, res).catch(err => {
        addLog('error', `Dashboard request failed: ${shortError(err)}`)
        sendJson(res, 500, { error: shortError(err) })
      })
    })

    nextServer.on('error', err => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
        listenOnAvailablePort(startPort, attempt + 1)
        return
      }
      addLog('error', `Dashboard failed: ${shortError(err)}`)
      console.error('[dashboard]', err.message)
    })

    nextServer.listen(desiredPort, '127.0.0.1', () => {
      server = nextServer
      port = desiredPort
      addLog('system', `Dashboard listening on http://localhost:${port}/`)
      console.log(`[dashboard] http://localhost:${port}/`)
    })
  }

  async function handleRequest (req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, getStatusPayload())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      sendJson(res, 200, { logs })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      const body = await readJson(req)
      const command = normalizeCommand(body.command)
      if (!command) {
        sendJson(res, 400, { error: 'Missing command.' })
        return
      }
      if (!context?.bot?.entity) {
        sendJson(res, 409, { error: 'Bot is offline; wait for reconnect.' })
        return
      }
      const username = String(body.username || defaultCommander()).trim()
      addLog('command', `${username}: ${command}`)
      await context.runCommand(username, command)
      sendJson(res, 200, { ok: true })
      return
    }
    serveStatic(url.pathname, res)
  }

  function getStatusPayload () {
    const bot = context?.bot
    const tasks = context?.tasks
    const position = bot?.entity?.position?.floored?.()
    const inventory = bot?.inventory?.items?.() || []
    const equipment = ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand']
      .reduce((result, slot) => {
        const item = getEquipment(bot, slot)
        result[slot] = item ? item.name : null
        return result
      }, {})

    return {
      online: Boolean(bot?.entity),
      username: bot?.username || context?.config?.bot?.username || 'bot',
      server: {
        host: context?.config?.server?.host || 'unknown',
        port: context?.config?.server?.port || 25565,
        version: context?.config?.server?.version || 'auto'
      },
      health: bot?.health ?? 0,
      food: bot?.food ?? 0,
      oxygen: bot?.oxygenLevel ?? 20,
      position: position ? { x: position.x, y: position.y, z: position.z } : null,
      task: {
        name: tasks?.currentTask || 'idle',
        startedAt: tasks?.currentTaskStartedAt || 0,
        deadlineAt: tasks?.currentTaskDeadlineAt || 0,
        lastError: tasks?.lastError || null
      },
      modes: {
        protect: Boolean(context?.protector?.enabled),
        pvp: modeState(context?.pvp),
        mobDefense: modeState(context?.mobDefense),
        dispatcher: context?.dispatcher?.status?.() || 'dispatcher unknown',
        ai: {
          enabled: Boolean(context?.ai?.enabled),
          goal: context?.ai?.goal || null
        }
      },
      memory: {
        home: context?.memory?.home || null,
        botBase: context?.memory?.botBase || null,
        chests: context?.memory?.chests || {}
      },
      pvpTraining: typeof context?.pvp?.trainingSummary === 'function'
        ? context.pvp.trainingSummary()
        : null,
      planner: typeof context?.planner?.status === 'function'
        ? context.planner.status()
        : null,
      inventory: summarizeItems(inventory),
      equipment,
      players: visiblePlayers(bot, context?.config),
      mobs: nearbyMobs(bot)
    }
  }

  function serveStatic (pathname, res) {
    const publicDir = path.join(__dirname, 'dashboard')
    const route = pathname === '/' ? '/index.html' : pathname
    const safePath = path.normalize(route).replace(/^(\.\.[/\\])+/, '')
    const filePath = path.join(publicDir, safePath)
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' })
      res.end(data)
    })
  }

  function attachBotLogs (bot) {
    if (!bot || seenBotIds.has(bot)) return
    seenBotIds.add(bot)
    bot.on('messagestr', message => addLog('chat', message))
    bot.on('spawn', () => addLog('system', `${bot.username} spawned`))
    bot.on('death', () => addLog('system', `${bot.username} died`))
    bot.on('kicked', reason => addLog('error', `Kicked: ${shortError(reason)}`))
    bot.on('end', reason => addLog('system', `Disconnected${reason ? `: ${shortError(reason)}` : ''}`))
    bot.on('error', err => addLog('error', shortError(err)))
  }

  function addLog (type, message) {
    logs.push({
      type,
      message: String(message || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      at: Date.now()
    })
    while (logs.length > MAX_LOGS) logs.shift()
  }

  function defaultCommander () {
    const allowed = context?.config?.allowedPlayers || []
    const visible = visiblePlayers(context?.bot, context?.config).find(player => player.allowed)
    return visible?.username || allowed[0] || 'dashboard'
  }
}

function sendJson (res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > 4096) {
        reject(new Error('Request too large.'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

function normalizeCommand (command) {
  const text = String(command || '').trim()
  if (!text) return ''
  return text.startsWith('!') ? text : `!${text}`
}

function getEquipment (bot, slot) {
  if (!bot?.inventory) return null
  if (slot === 'hand') return bot.heldItem || null
  try {
    const dest = bot.getEquipmentDestSlot(slot)
    return bot.inventory.slots[dest] || null
  } catch {
    return null
  }
}

function modeState (controller) {
  if (!controller) return { enabled: false, active: false, target: null }
  return {
    enabled: Boolean(controller.enabled),
    active: Boolean(controller.active),
    target: controller.targetName || null,
    style: typeof controller.combatStyle === 'function' ? controller.combatStyle() : null
  }
}

function summarizeItems (items) {
  const counts = {}
  for (const item of items) counts[item.name] = (counts[item.name] || 0) + item.count
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 48)
    .map(([name, count]) => ({ name, count }))
}

function visiblePlayers (bot, config = {}) {
  const allowed = new Set(config?.allowedPlayers || [])
  const players = new Map()
  for (const username of allowed) {
    players.set(username, { username, player: null })
  }
  for (const [username, player] of Object.entries(bot?.players || {})) {
    if (username !== bot.username) players.set(username, { username, player })
  }
  return [...players.values()]
    .filter(({ username }) => username !== bot?.username)
    .map(({ username, player }) => ({
      username,
      allowed: allowed.has(username),
      visible: Boolean(player?.entity),
      distance: player?.entity && bot?.entity ? Math.round(player.entity.position.distanceTo(bot.entity.position)) : null
    }))
    .sort((a, b) => Number(b.allowed) - Number(a.allowed) || Number(b.visible) - Number(a.visible) || a.username.localeCompare(b.username))
}

function nearbyMobs (bot) {
  if (!bot?.entity) return []
  return Object.values(bot.entities || {})
    .filter(entity => entity?.isValid && entity.type === 'mob' && entity.position)
    .map(entity => ({
      name: entity.name || entity.type,
      distance: Math.round(entity.position.distanceTo(bot.entity.position))
    }))
    .filter(entity => entity.distance <= 24)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10)
}

function contentType (filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

function shortError (err) {
  return String(err?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 120)
}

module.exports = { createDashboardServer }

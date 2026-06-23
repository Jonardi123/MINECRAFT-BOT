const fs = require('fs')
const path = require('path')

const memoryPath = process.env.MC_AI_BOT_MEMORY
  ? path.resolve(process.env.MC_AI_BOT_MEMORY)
  : path.join(__dirname, '..', 'memory.json')

function loadMemory (config) {
  const memory = safeRead()
  if (!memory.home && config.positions.home) memory.home = config.positions.home
  if (!memory.miningArea && config.positions.miningArea) memory.miningArea = config.positions.miningArea
  memory.chests = memory.chests || {}
  if (!memory.chests.storage && config.positions.chests.storage) memory.chests.storage = config.positions.chests.storage
  if (!memory.chests.farm && config.positions.chests.farm) memory.chests.farm = config.positions.chests.farm
  memory.players = memory.players || {}
  memory.notes = memory.notes || []
  return memory
}

function saveMemory (memory) {
  memory.lastUpdated = new Date().toISOString()
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2))
}

function rememberPlayer (memory, username, pos) {
  if (!username) return
  memory.players[username] = {
    lastSeen: new Date().toISOString(),
    position: pos ? positionToJson(pos) : null
  }
  saveMemory(memory)
}

function setPosition (memory, key, pos) {
  memory[key] = positionToJson(pos)
}

function setChest (memory, kind, pos) {
  memory.chests = memory.chests || {}
  memory.chests[kind] = positionToJson(pos)
}

function positionToJson (pos) {
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z)
  }
}

function safeRead () {
  try {
    return JSON.parse(fs.readFileSync(memoryPath, 'utf8'))
  } catch {
    return {}
  }
}

module.exports = {
  loadMemory,
  saveMemory,
  rememberPlayer,
  setPosition,
  setChest,
  positionToJson
}

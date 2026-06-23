const path = require('path')

function loadConfig () {
  const configPath = process.env.MC_AI_BOT_CONFIG
    ? path.resolve(process.env.MC_AI_BOT_CONFIG)
    : path.join(__dirname, '..', 'config.json')
  return require(configPath)
}

function configPathLabel () {
  return process.env.MC_AI_BOT_CONFIG
    ? path.resolve(process.env.MC_AI_BOT_CONFIG)
    : path.join(__dirname, '..', 'config.json')
}

module.exports = {
  loadConfig,
  configPathLabel
}

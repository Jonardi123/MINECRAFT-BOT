function loadOptionalPlugins (bot, config = {}) {
  const loaded = []
  const failed = []

  if (config.plugins?.collectBlock !== false) tryLoad(bot, 'mineflayer-collectblock', 'collectBlock', loaded, failed)
  if (config.plugins?.tool !== false) tryLoad(bot, 'mineflayer-tool', 'tool', loaded, failed)
  if (config.plugins?.autoEat !== false) tryLoad(bot, 'mineflayer-auto-eat', 'autoEat', loaded, failed)

  if (loaded.length) console.log(`[plugins] Loaded optional plugins: ${loaded.join(', ')}`)
  if (failed.length) console.log(`[plugins] Optional plugins unavailable: ${failed.join(', ')}`)
  return { loaded, failed }
}

function tryLoad (bot, packageName, label, loaded, failed) {
  try {
    const mod = require(packageName)
    const plugin = mod.plugin || mod.loader || mod.default || mod
    if (typeof plugin !== 'function') throw new Error('plugin export is not a function')
    bot.loadPlugin(plugin)
    loaded.push(label)
  } catch (err) {
    failed.push(label)
  }
}

module.exports = { loadOptionalPlugins }

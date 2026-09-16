const fs = require('fs')
const path = require('path')
const { loadConfig, configPathLabel } = require('../configLoader')

const root = path.join(__dirname, '..')
const requiredFiles = [
  'package.json',
  'index.js',
  'config.json',
  'README.md',
  'aiActions.js',
  'aiController.js',
  'aiState.js',
  'autopilot.js',
  'beaconObjective.js',
  'chest.js',
  'collection.js',
  'combat.js',
  'brain.js',
  'building.js',
  'crafting.js',
  'domestic.js',
  'equipment.js',
  'farming.js',
  'goalExecutor.js',
  'goalPlanner.js',
  'inventory.js',
  'memory.js',
  'mining.js',
  'mobDefense.js',
  'modThreat.js',
  'navigation.js',
  'protection.js',
  'pvp.js',
  'safety.js',
  'speaker.js',
  'selfModel.js',
  'status.js',
  'jsonDecision.js',
  'llmStatus.js',
  'knowledge.js',
  'rewardSystem.js',
  'progressTracker.js',
  'curriculum.js',
  'skillRegistry.js',
  'critic.js',
  'agentCore.js',
  'miningPlanner.js',
  'combatPlanner.js',
  'loadouts.js',
  'pluginLoader.js',
  'knowledge/survival.json',
  'knowledge/mining.json',
  'knowledge/combat.json',
  'knowledge/pvp.json',
  'knowledge/mobs.json',
  'knowledge/nether.json',
  'knowledge/dragon.json',
  'knowledge/crafting.json',
  'knowledge/inventory.json',
  'knowledge/recovery.json',
  'knowledge/objectives.json',
  'knowledge/exploration.json',
  'knowledge/enchanting.json',
  'knowledge/brewing.json',
  'knowledge/trading.json',
  'knowledge/building.json',
  'knowledge/redstone_utility.json',
  'knowledge/speedrun_basics.json',
  'knowledge/villages.json',
  'knowledge/structures.json'
]

const dependencies = {
  mineflayer: 4,
  'mineflayer-pathfinder': 2,
  'minecraft-data': 3,
  vec3: 0
}

main()

function main () {
  checkNodeVersion()
  checkFiles()
  checkJson()
  checkSyntax()
  checkDependencies()
  checkMinecraftVersion()
  console.log('Preflight OK. The project is ready to start.')
}

function checkNodeVersion () {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) {
    fail(`Node.js ${process.versions.node} is installed, but mineflayer 4.37+ requires Node.js 22 or newer.`)
  }
}

function checkFiles () {
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) fail(`Missing required file: ${file}`)
  }
}

function checkJson () {
  for (const file of requiredFiles.filter(file => file.endsWith('.json'))) {
    try {
      JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    } catch (err) {
      fail(`${file} is not valid JSON: ${err.message}`)
    }
  }
}

function checkSyntax () {
  const files = requiredFiles.filter(file => file.endsWith('.js'))
  for (const file of files) {
    const fullPath = path.join(root, file)
    try {
      // Parse only. Do not require files, because index.js starts the bot.
      new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(fullPath, 'utf8'))
    } catch (err) {
      fail(`${file} has a syntax/startup error: ${err.message}`)
    }
  }
}

function checkDependencies () {
  for (const [name, minimumMajor] of Object.entries(dependencies)) {
    try {
      const packageJsonPath = findPackageJson(require.resolve(name, { paths: [root] }))
      const installed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
      const major = Number(installed.split('.')[0])
      if (major < minimumMajor) {
        fail(`Installed ${name}@${installed} is too old. Run npm install to install the version from package.json.`)
      }
    } catch {
      fail(`Missing dependency: ${name}. Run npm install first.`)
    }
  }
}

function findPackageJson (resolvedModulePath) {
  let dir = path.dirname(resolvedModulePath)
  while (dir && dir !== path.dirname(dir)) {
    const packageJsonPath = path.join(dir, 'package.json')
    if (fs.existsSync(packageJsonPath)) return packageJsonPath
    dir = path.dirname(dir)
  }
  throw new Error(`Could not find package.json for ${resolvedModulePath}`)
}

function checkMinecraftVersion () {
  const config = loadConfig()
  const version = config.server?.version
  if (version === false || version === null || version === undefined || version === 'auto') return

  const pcDataDir = path.join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc')
  const versions = fs.readdirSync(pcDataDir)
    .filter(name => fs.statSync(path.join(pcDataDir, name)).isDirectory())
    .filter(name => /^\d+\.\d+(\.\d+)?$/.test(name))

  if (!versions.includes(String(version))) {
    const latest = versions.sort(compareVersions).at(-1)
    fail(`${configPathLabel()} server.version "${version}" is not supported by installed minecraft-data. Use "${latest}", "auto", or false.`)
  }
}

function compareVersions (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function fail (message) {
  console.error(`Preflight failed: ${message}`)
  process.exit(1)
}

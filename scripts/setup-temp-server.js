const fs = require('fs')
const https = require('https')
const path = require('path')

const VERSION = '1.21.1'
const ROOT = path.resolve(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'temp-server', VERSION)
const SERVER_JAR = path.join(SERVER_DIR, 'server.jar')
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

main().catch(err => {
  console.error(`[temp-server setup] ${err.message}`)
  process.exit(1)
})

async function main () {
  fs.mkdirSync(SERVER_DIR, { recursive: true })
  if (!fs.existsSync(SERVER_JAR)) {
    console.log(`[temp-server setup] Downloading Minecraft server ${VERSION}...`)
    const manifest = await getJson(MANIFEST_URL)
    const entry = manifest.versions.find(item => item.id === VERSION)
    if (!entry?.url) throw new Error(`Could not find ${VERSION} in Mojang manifest.`)
    const versionMeta = await getJson(entry.url)
    const serverUrl = versionMeta.downloads?.server?.url
    if (!serverUrl) throw new Error(`No server download for ${VERSION}.`)
    await download(serverUrl, SERVER_JAR)
  }

  writeFile('eula.txt', 'eula=true\n')
  writeFile('server.properties', [
    'server-port=25566',
    'online-mode=false',
    'difficulty=normal',
    'gamemode=survival',
    'spawn-monsters=false',
    'spawn-protection=0',
    'max-players=8',
    'enable-command-block=true',
    'allow-flight=true',
    'view-distance=6',
    'level-type=flat',
    'generate-structures=false',
    'motd=Codex temp training server',
    ''
  ].join('\n'))

  console.log(`[temp-server setup] Ready: ${SERVER_DIR}`)
}

function writeFile (name, content) {
  fs.writeFileSync(path.join(SERVER_DIR, name), content, 'utf8')
}

function getJson (url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if (isRedirect(response)) return resolve(getJson(response.headers.location))
      if (response.statusCode !== 200) return reject(new Error(`${url} returned ${response.statusCode}`))
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (err) {
          reject(err)
        }
      })
    }).on('error', reject)
  })
}

function download (url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination)
    https.get(url, response => {
      if (isRedirect(response)) {
        file.close()
        fs.rmSync(destination, { force: true })
        return resolve(download(response.headers.location, destination))
      }
      if (response.statusCode !== 200) {
        file.close()
        fs.rmSync(destination, { force: true })
        return reject(new Error(`${url} returned ${response.statusCode}`))
      }
      response.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', err => {
      file.close()
      fs.rmSync(destination, { force: true })
      reject(err)
    })
  })
}

function isRedirect (response) {
  return response.statusCode >= 300 && response.statusCode < 400 && response.headers.location
}

module.exports = {
  SERVER_DIR,
  SERVER_JAR,
  VERSION
}

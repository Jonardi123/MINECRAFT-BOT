const SUPPORTED_VERSIONS = ['1.16.5', '1.21.1']

const OUTDATED_SERVER_RE = /Outdated server[!.] I'm still on ([\d.]+)/
const OUTDATED_CLIENT_RE = /Outdated client[!.] Please use ([\d.]+)/
const NO_DATA_RE = /No data available for version ([\d.]+)/

function isSupportedJavaVersion (version) {
  if (version === false || version === undefined || version === null || version === 'auto') return true
  return SUPPORTED_VERSIONS.includes(String(version))
}

function extractServerVersionMismatch (reason) {
  const text = messageOf(reason)
  const outdatedServer = text.match(OUTDATED_SERVER_RE)
  if (outdatedServer) return { serverVersion: outdatedServer[1], clientVersion: null }
  const outdatedClient = text.match(OUTDATED_CLIENT_RE)
  if (outdatedClient) return { serverVersion: outdatedClient[1], clientVersion: null }
  return null
}

function extractUnsupportedVersion (err) {
  const text = messageOf(err)
  const match = text.match(NO_DATA_RE)
  return match ? match[1] : null
}

function serverRequiresVersionMessage (serverVersion, clientVersion) {
  if (clientVersion) return `The server requires Java ${serverVersion}, but I am running ${clientVersion}.`
  return `The server requires Java ${serverVersion}.`
}

function unsupportedVersionMessage (version) {
  return `No data available for version ${version}. Set server.version in config.json to a supported Java version like "1.21.1".`
}

function messageOf (input) {
  if (typeof input === 'string') return input
  if (input && typeof input.message === 'string') return input.message
  return ''
}

module.exports = {
  extractServerVersionMismatch,
  extractUnsupportedVersion,
  isSupportedJavaVersion,
  serverRequiresVersionMessage,
  unsupportedVersionMessage
}
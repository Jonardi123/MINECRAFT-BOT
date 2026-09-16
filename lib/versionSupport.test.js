const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  extractServerVersionMismatch,
  extractUnsupportedVersion,
  isSupportedJavaVersion,
  serverRequiresVersionMessage,
  unsupportedVersionMessage
} = require('./versionSupport')

test('isSupportedJavaVersion accepts versions the bot is known to run on', () => {
  assert.equal(isSupportedJavaVersion('1.21.1'), true)
  assert.equal(isSupportedJavaVersion('1.16.5'), true)
})

test('isSupportedJavaVersion rejects unknown explicit versions', () => {
  assert.equal(isSupportedJavaVersion('26.1.2'), false)
  assert.equal(isSupportedJavaVersion('1.20.4'), false)
})

test('isSupportedJavaVersion lets auto/false pass through to mineflayer negotiation', () => {
  assert.equal(isSupportedJavaVersion('auto'), true)
  assert.equal(isSupportedJavaVersion(false), true)
  assert.equal(isSupportedJavaVersion(undefined), true)
  assert.equal(isSupportedJavaVersion(null), true)
})

test('extractServerVersionMismatch parses the too-new-client kick', () => {
  const mismatch = extractServerVersionMismatch('Outdated client! Please use 26.1.2')
  assert.deepEqual(mismatch, { serverVersion: '26.1.2', clientVersion: null })
})

test('extractServerVersionMismatch parses the too-old-client kick', () => {
  const mismatch = extractServerVersionMismatch("Outdated server! I'm still on 1.16.5")
  assert.deepEqual(mismatch, { serverVersion: '1.16.5', clientVersion: null })
})

test('extractServerVersionMismatch works with Error objects and returns null otherwise', () => {
  const mismatch = extractServerVersionMismatch(new Error('Outdated client! Please use 1.21.1'))
  assert.equal(mismatch.serverVersion, '1.21.1')
  assert.equal(extractServerVersionMismatch('kicked: banned'), null)
  assert.equal(extractServerVersionMismatch(undefined), null)
})

test('extractUnsupportedVersion parses the minecraft-data version error', () => {
  assert.equal(extractUnsupportedVersion('No data available for version 26.1.2'), '26.1.2')
  assert.equal(extractUnsupportedVersion(new Error('No data available for version 1.21.1')), '1.21.1')
  assert.equal(extractUnsupportedVersion('some other error'), null)
})

test('serverRequiresVersionMessage includes both sides when the client version is known', () => {
  const message = serverRequiresVersionMessage('26.1.2', '1.21.1')
  assert.match(message, /26\.1\.2/)
  assert.match(message, /1\.21\.1/)
})

test('serverRequiresVersionMessage mentions only the server version otherwise', () => {
  assert.match(serverRequiresVersionMessage('1.16.5', null), /1\.16\.5/)
})

test('unsupportedVersionMessage names the rejected version and suggests the fix', () => {
  const message = unsupportedVersionMessage('1.20.4')
  assert.match(message, /1\.20\.4/)
  assert.match(message, /server\.version/)
})
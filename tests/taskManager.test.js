const assert = require('node:assert/strict')
const test = require('node:test')
const { createTaskManager } = require('../lib/taskManager')

test('stop prevents a queued task from starting', async () => {
  const tasks = createTaskManager({}, {}, {})
  let called = false
  const pending = tasks.start('mine', () => { called = true })
  tasks.stop()
  await pending
  assert.equal(called, false)
  assert.equal(tasks.currentTask, null)
})

test('a replacement task prevents the superseded task from starting', async () => {
  const tasks = createTaskManager({}, {}, {})
  const seen = []
  const old = tasks.start('mine', () => seen.push('mine'))
  const replacement = tasks.start('follow', () => seen.push('follow'))
  await Promise.all([old, replacement])
  assert.deepEqual(seen, ['follow'])
})

test('an active task receives cancellation without clearing its replacement', async () => {
  const tasks = createTaskManager({}, {}, {})
  let finish
  let signal
  const old = tasks.start('mine', value => {
    signal = value
    return new Promise(resolve => { finish = resolve })
  })
  await Promise.resolve()
  let finishReplacement
  const replacement = tasks.start('follow', () => new Promise(resolve => { finishReplacement = resolve }))
  await Promise.resolve()
  assert.equal(signal.cancelled, true)
  finish()
  await old
  assert.equal(tasks.currentTask, 'follow')
  finishReplacement('done')
  assert.equal(await replacement, 'done')
  assert.equal(tasks.currentTask, null)
})

test('an uncancelled task failure still reaches its caller', async () => {
  const tasks = createTaskManager({}, {}, {})
  await assert.rejects(tasks.start('mine', () => { throw new Error('blocked') }), /blocked/)
  assert.equal(tasks.currentTask, null)
})

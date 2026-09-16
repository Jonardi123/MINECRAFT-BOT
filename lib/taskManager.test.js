const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTaskManager } = require('./taskManager')

function makeTasks () {
  return createTaskManager({}, {}, {})
}

test('currentTask is null before any task starts', () => {
  const tasks = makeTasks()
  assert.equal(tasks.currentTask, null)
})

test('start sets currentTask, exposes a live signal, resolves with fn result', async () => {
  const tasks = makeTasks()
  let seenSignal = null
  const result = await tasks.start('work', async signal => {
    seenSignal = signal
    assert.equal(signal.cancelled, false)
    assert.equal(tasks.currentTask, 'work')
    return 42
  })
  assert.equal(result, 42)
  assert.ok(seenSignal)
  assert.equal(seenSignal.cancelled, false)
  assert.equal(tasks.currentTask, null)
})

test('start passes a signal that flips cancelled on stop()', async () => {
  const tasks = makeTasks()
  let capturedSignal = null
  const started = tasks.start('cooperative', signal => new Promise((resolve, reject) => {
    capturedSignal = signal
    setTimeout(() => {
      if (signal.cancelled) reject(new Error('Task cancelled'))
      else resolve('done')
    }, 10)
  }))
  await Promise.resolve()
  assert.equal(tasks.currentTask, 'cooperative')
  assert.equal(capturedSignal.cancelled, false)
  tasks.stop()
  assert.equal(tasks.currentTask, null)
  assert.equal(capturedSignal.cancelled, true)
  await started
})

test('start resolves quietly when the running task is cancelled', async () => {
  const tasks = makeTasks()
  const started = tasks.start('long', signal => new Promise((resolve, reject) => {
    setTimeout(() => {
      if (signal.cancelled) reject(new Error('Task cancelled'))
      else resolve('done')
    }, 10)
  }))
  tasks.stop()
  assert.equal(await started, undefined)
  assert.equal(tasks.currentTask, null)
})

test('start rejects with the task error when it fails without cancellation', async () => {
  const tasks = makeTasks()
  await assert.rejects(
    tasks.start('boom', async () => { throw new Error('nope') }),
    /nope/
  )
  assert.equal(tasks.currentTask, null)
})

test('start cancels a previous running task and currentTask points to the newest', async () => {
  const tasks = makeTasks()
  let firstSignal = null
  const first = tasks.start('first', signal => {
    firstSignal = signal
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (signal.cancelled) reject(new Error('Task cancelled'))
        else resolve('first done')
      }, 10)
    })
  })
  assert.equal(tasks.currentTask, 'first')
  await Promise.resolve()
  const second = tasks.start('second', async () => 'second done')
  assert.equal(tasks.currentTask, 'second')
  assert.equal(firstSignal.cancelled, true)
  assert.equal(await first, undefined)
  assert.equal(await second, 'second done')
  assert.equal(tasks.currentTask, null)
})

test('recordDeath cancels the current task the same way stop() does', async () => {
  const tasks = makeTasks()
  const started = tasks.start('fight', signal => new Promise((resolve, reject) => {
    setTimeout(() => {
      if (signal.cancelled) reject(new Error('Task cancelled'))
      else resolve('ok')
    }, 10)
  }))
  await Promise.resolve()
  assert.equal(tasks.currentTask, 'fight')
  tasks.recordDeath()
  assert.equal(tasks.currentTask, null)
  assert.equal(await started, undefined)
})

test('stop and recordDeath are no-ops when idle', () => {
  const tasks = makeTasks()
  tasks.stop()
  tasks.recordDeath()
  assert.equal(tasks.currentTask, null)
})
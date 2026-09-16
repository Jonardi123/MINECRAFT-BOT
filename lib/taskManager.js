function createTaskManager (bot, speaker, config) {
  let current = null
  let nextId = 1

  function cancelCurrent () {
    const run = current
    current = null
    if (run) run.signal.cancelled = true
  }

  return {
    get currentTask () {
      return current ? current.name : null
    },

    start (name, fn) {
      cancelCurrent()
      const run = { id: nextId++, name, signal: { cancelled: false } }
      current = run

      return new Promise((resolve, reject) => {
        Promise.resolve()
          .then(() => fn(run.signal))
          .then(value => {
            if (current === run) current = null
            resolve(value)
          })
          .catch(err => {
            if (current === run) current = null
            if (run.signal.cancelled) resolve()
            else reject(err)
          })
      })
    },

    stop () {
      cancelCurrent()
    },

    recordDeath () {
      cancelCurrent()
    }
  }
}

module.exports = { createTaskManager }
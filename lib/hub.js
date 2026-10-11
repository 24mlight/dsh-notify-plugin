// The notice queue the phone long-polls. Notices are numbered in order; the phone
// sends the last number it has and gets every newer notice, or waits until one
// arrives. `boot` changes on every server start, so a phone holding a number from an
// earlier run starts over instead of waiting for a number that will never come.
import { randomUUID } from 'node:crypto'

export function createHub({ keep = 100 } = {}) {
  const boot = randomUUID()
  let seq = 0
  let notices = []
  const waiters = new Set()

  function push(notice) {
    seq += 1
    notices = [...notices, { ...notice, seq, at: Date.now() }].slice(-keep)
    for (const waiter of [...waiters]) waiter()
  }

  const newer = since => notices.filter(notice => notice.seq > since)

  /**
   * Notices after `since`, waiting up to `waitMs` for one. A phone that is new
   * (no `since`) or from another server run gets no backlog, only the current
   * number to continue from.
   */
  function poll({ boot: theirs, since, waitMs = 0 } = {}) {
    const answer = events => ({ boot, seq, events })
    if (theirs !== boot || !Number.isInteger(since) || since > seq) return Promise.resolve(answer([]))
    const ready = newer(since)
    if (ready.length > 0 || waitMs <= 0) return Promise.resolve(answer(ready))
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve(answer(newer(since)))
      }
      const timer = setTimeout(done, waitMs)
      waiters.add(done)
    })
  }

  /** Answers every waiting phone now (plugin stop). */
  function close() {
    for (const waiter of [...waiters]) waiter()
  }

  return { boot, push, poll, close, get seq() { return seq } }
}

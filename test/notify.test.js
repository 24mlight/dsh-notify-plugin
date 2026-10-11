import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../lib/hub.js'
import { sessionKind, memberLines } from '../lib/team.js'
import { createTracker, clip } from '../lib/tracker.js'
import { apply, ROUTE } from '../index.js'

/* ---------------- hub ---------------- */

test('a new phone gets no backlog, only the number to continue from', async () => {
  const hub = createHub()
  hub.push({ text: 'old' })
  const first = await hub.poll({})
  assert.deepEqual(first.events, [])
  assert.equal(first.seq, 1)
  assert.equal(first.boot, hub.boot)
})

test('notices after `since` come back at once; a waiting poll wakes on the next one', async () => {
  const hub = createHub()
  hub.push({ text: 'a' })
  const now = await hub.poll({ boot: hub.boot, since: 0, waitMs: 1000 })
  assert.deepEqual(now.events.map(e => e.text), ['a'])
  const waiting = hub.poll({ boot: hub.boot, since: 1, waitMs: 5000 })
  setTimeout(() => hub.push({ text: 'b' }), 10)
  const woke = await waiting
  assert.deepEqual(woke.events.map(e => e.text), ['b'])
  assert.equal(woke.seq, 2)
})

test('an empty wait times out with no notices; another server run starts over', async () => {
  const hub = createHub()
  const quiet = await hub.poll({ boot: hub.boot, since: 0, waitMs: 20 })
  assert.deepEqual(quiet.events, [])
  hub.push({ text: 'x' })
  const other = await hub.poll({ boot: 'an-earlier-run', since: 0, waitMs: 1000 })
  assert.deepEqual(other.events, [], 'no replay for a number from another run')
  assert.equal(other.boot, hub.boot)
})

test('close answers every waiting phone', async () => {
  const hub = createHub()
  const waiting = hub.poll({ boot: hub.boot, since: 0, waitMs: 60_000 })
  hub.close()
  assert.deepEqual((await waiting).events, [])
})

/* ---------------- team ---------------- */

const STATE = {
  bots: {
    chief: { id: 'chief', name: 'Chief', sessionId: 's-chief-2', segments: [{ sessionId: 'chief' }] },
    quant: { id: 's-quant', name: '量化研究员' },
  },
  rooms: {
    'r-1': { id: 'r-1', name: '投研小组', sessions: { chief: 'g-chief' }, segments: { chief: [{ sessionId: 'g-chief-old' }] }, log: [
      { seq: 1, who: 'User', text: '整理自选股' },
      { seq: 2, who: 'Chief', botId: 'chief', text: '好，我来安排' },
      { seq: 3, who: 'Chief', kind: 'lookup', text: 'internal' },
    ] },
  },
  agents: { a1: { id: 'a1', name: 'DSH Agent', sessions: ['s-agent'] } },
  exchangeTurns: { 's-chief-2': [7] },
}

test('sessions are told apart: own chat, group, agent, archived, plain', () => {
  assert.equal(sessionKind(STATE, 's-chief-2').kind, 'chat')
  assert.equal(sessionKind(STATE, 's-quant').bot.name, '量化研究员', 'a Bot without sessionId chats in its id')
  assert.equal(sessionKind(STATE, 'r-1').kind, 'room')
  assert.equal(sessionKind(STATE, 'g-chief').room.name, '投研小组')
  assert.equal(sessionKind(STATE, 's-agent').kind, 'agent')
  assert.equal(sessionKind(STATE, 'chief').kind, 'archived')
  assert.equal(sessionKind(STATE, 'g-chief-old').kind, 'archived')
  assert.equal(sessionKind(STATE, 'other').kind, 'plain')
})

test('group lines: members only, no user lines, no lookups', () => {
  assert.deepEqual(memberLines(STATE.rooms['r-1'], 0).map(l => l.seq), [2])
  assert.deepEqual(memberLines(STATE.rooms['r-1'], 2), [])
})

/* ---------------- tracker ---------------- */

function rig(initial = STATE) {
  let state = structuredClone(initial)
  const sent = []
  const pending = []
  const tracker = createTracker({
    team: { load: async () => structuredClone(state) },
    emit: notice => sent.push(notice),
    setTimer: fn => { pending.push(fn); return pending.length },
    clearTimer: () => {},
  })
  const flush = async () => {
    await tracker.ready
    while (pending.length) await pending.shift()()
    await new Promise(r => setImmediate(r))
  }
  const turn = (id, { n = 1, kind = 'user', text = '', reason = 'completed' } = {}) => {
    tracker.onEvent(id, { type: 'turn/start', data: { turn: n } })
    tracker.onEvent(id, { type: 'user/message', data: { source: { kind } } })
    if (text) tracker.onEvent(id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    tracker.onEvent(id, { type: 'turn/end', data: { turn: n, reason: { kind: reason } } })
  }
  return { tracker, sent, flush, turn, setState: fn => { state = fn(state) ?? state } }
}

test('a Bot reply in its own chat notifies with its name and text', async () => {
  const r = rig()
  r.turn('s-chief-2', { n: 3, text: '已经安排好了' })
  await r.flush()
  assert.deepEqual(r.sent.map(({ kind, title, text }) => ({ kind, title, text })), [{ kind: 'reply', title: 'Chief', text: '已经安排好了' }])
})

test('a message reported before its turn still counts as the user starting it', async () => {
  const r = rig()
  r.tracker.onEvent('other', { type: 'user/message', data: { source: { kind: 'user' } } })
  r.tracker.onEvent('other', { type: 'turn/start', data: { turn: 1 } })
  r.tracker.onEvent('other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'bash 跑完了' }] } } })
  r.tracker.onEvent('other', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // The next turn has no early message of its own: an internal turn stays quiet.
  r.tracker.onEvent('other', { type: 'turn/start', data: { turn: 2 } })
  r.tracker.onEvent('other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'internal' }] } } })
  r.tracker.onEvent('other', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await r.flush()
  assert.deepEqual(r.sent.map(({ title, text }) => ({ title, text })), [{ title: 'DSH', text: 'bash 跑完了' }])
})

test('hidden Bot-to-Bot turns, empty replies and stopped turns stay quiet', async () => {
  const r = rig()
  r.turn('s-chief-2', { n: 7, kind: 'bot', text: 'between bots' })
  r.turn('s-chief-2', { n: 8, text: '' })
  r.turn('s-chief-2', { n: 9, text: 'half', reason: 'aborted' })
  await r.flush()
  assert.deepEqual(r.sent, [])
})

test('a failed reply in a Bot chat says so', async () => {
  const r = rig()
  r.turn('s-chief-2', { n: 4, reason: 'error' })
  await r.flush()
  assert.equal(r.sent[0].kind, 'error')
  assert.equal(r.sent[0].text, '回复失败')
})

test('group: each new member line is its own notice, sent once, old lines never', async () => {
  const r = rig()
  r.setState(s => { s.rooms['r-1'].log.push({ seq: 4, who: 'User', text: '你就创建一个吗' }, { seq: 5, who: 'Chief', text: '再建三个' }, { seq: 6, who: '盯盘员', text: '我来盯盘' }) })
  r.turn('g-chief', { n: 2, kind: 'bot', text: '再建三个' })
  r.turn('r-1', { n: 2, text: '' })
  await r.flush()
  assert.deepEqual(r.sent.map(({ title, who, text }) => ({ title, who, text })), [
    { title: '投研小组', who: 'Chief', text: '再建三个' },
    { title: '投研小组', who: '盯盘员', text: '我来盯盘' },
  ])
})

test('a group created after start notifies its first lines too', async () => {
  const r = rig()
  r.setState(s => { s.rooms['r-2'] = { id: 'r-2', name: '新群', sessions: {}, log: [{ seq: 1, who: 'Chief', text: '大家好' }] } })
  r.turn('r-2', { text: '' })
  await r.flush()
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].title, '新群')
})

test('DSH Agent and plain Sessions notify only for turns the user or a schedule started', async () => {
  const r = rig()
  r.turn('s-agent', { text: '改好了' })
  r.turn('plain-1', { kind: 'schedule', text: '定时任务完成' })
  r.turn('sub-agent', { kind: 'subagent', text: 'internal' })
  r.turn('chief', { text: 'archived' })
  await r.flush()
  assert.deepEqual(r.sent.map(n => n.title), ['DSH Agent', 'DSH'])
})

test('each decision is kept for the app\'s 诊断记录, with why a turn stayed quiet', async () => {
  const r = rig()
  r.turn('s-agent', { text: '改好了' })
  r.turn('sub-agent', { kind: 'subagent', text: 'internal' })
  r.turn('s-chief-2', { n: 9, text: 'half', reason: 'aborted' })
  await r.flush()
  assert.deepEqual(r.tracker.decisions.map(d => [d.sessionId, d.kind, d.result]), [
    ['s-agent', 'agent', 'sent'],
    ['sub-agent', 'plain', 'skip: not started by the user'],
    ['s-chief-2', 'chat', 'skip: stopped'],
  ])
  assert.equal(r.tracker.counts.turnEnds, 3)
})

test('ask_user notifies at once with the question', async () => {
  const r = rig()
  r.tracker.onEvent('s-quant', { type: 'tool/call', data: { name: 'ask_user', arguments: JSON.stringify({ question: '用哪个数据源？', options: [{ label: 'A' }] }) } })
  await r.flush()
  assert.deepEqual(r.sent.map(({ kind, title, text }) => ({ kind, title, text })), [{ kind: 'question', title: '量化研究员', text: '用哪个数据源？' }])
})

test('long replies are clipped to one line', () => {
  assert.equal(clip('a\n\nb'), 'a b')
  assert.ok(clip('x'.repeat(1000)).length <= 401)
})

/* ---------------- plugin ---------------- */

test('apply registers the poll route and feeds Session events to it', async () => {
  const handlers = {}
  const effects = []
  let route
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    effect: (fn) => effects.push(fn()),
    connection: { fetch: { register: (r) => { route = r; return () => {} } } },
  }
  apply(ctx, { botState: '/nonexistent/state.json', settleMs: 1 })
  assert.equal(route.path, ROUTE)
  assert.deepEqual(route.methods, ['POST'])
  const ask = async (body) => (await (await route.fetch(new Request('https://x' + ROUTE, { method: 'POST', body: JSON.stringify(body) }))).json()).value
  const start = await ask({})
  const waiting = ask({ boot: start.boot, since: start.seq, waitMs: 5000 })
  const fire = (type, data) => handlers['session/event']({ id: 'plain-9' }, { type, data })
  fire('turn/start', { turn: 1 })
  fire('user/message', { source: { kind: 'user' } })
  fire('assistant/message', { message: { content: [{ type: 'text', text: '完成' }] } })
  fire('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const got = await waiting
  assert.deepEqual(got.events.map(e => e.text), ['完成'])
  for (const stop of effects) if (typeof stop === 'function') stop()
})

test('a test request pushes a test notice to the waiting poll', async () => {
  let route
  const ctx = { on: () => {}, effect: (fn) => fn(), connection: { fetch: { register: (r) => { route = r; return () => {} } } } }
  apply(ctx, { botState: '/nonexistent/state.json' })
  const ask = async (body) => (await (await route.fetch(new Request('https://x' + ROUTE, { method: 'POST', body: JSON.stringify(body) }))).json()).value
  const start = await ask({})
  const waiting = ask({ boot: start.boot, since: start.seq, waitMs: 5000 })
  assert.deepEqual(await ask({ test: true }), { test: true })
  const got = await waiting
  assert.equal(got.events[0].kind, 'test')
  const debug = await ask({ debug: true })
  assert.equal(debug.seq, 1)
  assert.equal(debug.version, '0.1.3')
  assert.deepEqual(debug.decisions, [])
})

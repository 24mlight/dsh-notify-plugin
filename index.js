// dsh-notify: tells the DSH Android app when a Bot, a group or a DSH Agent replies,
// so the phone can show a notification while the app is closed.
//
// The app keeps one long poll open on POST /api/dsh-notify (the same login cookie
// the app's WebView uses). The plugin listens to Session events, turns finished
// replies into short notices (see lib/tracker.js) and hands them to the waiting
// poll. Nothing is stored on disk; the last 100 notices live in memory.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHub } from './lib/hub.js'
import { createTeam } from './lib/team.js'
import { createTracker } from './lib/tracker.js'

export const name = 'dsh-notify'
export const inject = ['connection']

export const ROUTE = '/api/dsh-notify'
const MAX_WAIT_MS = 30_000
const VERSION = '0.1.3'

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const hub = createHub()
  const team = createTeam(config.botState ?? join(home, 'bot', 'state.json'))
  const tracker = createTracker({ team, emit: hub.push, settleMs: config.settleMs ?? 1500 })

  ctx.on('session/event', (session, event) => tracker.onEvent(session?.id, event))

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      // The app's 发送测试通知 button: proves the whole path (plugin loaded,
      // login accepted, poll delivering, phone posting) in one tap.
      if (body?.test === true) {
        hub.push({ kind: 'test', sessionId: 'dsh-notify-test', title: 'DSH Bot', text: '测试通知：服务器和手机已经连通' })
        return new Response(JSON.stringify({ ok: true, value: { test: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      }
      // The app's 诊断记录: what the server decided for the last turns.
      if (body?.debug === true) {
        return new Response(JSON.stringify({ ok: true, value: { version: VERSION, boot: hub.boot, seq: hub.seq, ...tracker.counts, decisions: tracker.decisions } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })
      }
      const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(body?.waitMs) || 0))
      const answer = await hub.poll({ boot: body?.boot, since: body?.since, waitMs })
      return new Response(JSON.stringify({ ok: true, value: answer }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    },
  }), 'dsh-notify: poll route')

  ctx.effect(() => () => {
    tracker.dispose()
    hub.close()
  }, 'dsh-notify: stop')
}

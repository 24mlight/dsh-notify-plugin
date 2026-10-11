// Turns DSH Session events into notices for the phone.
//
// Per Session it follows one turn at a time: what started it, the reply text, and
// how it ended. When a turn ends it waits briefly (ds-bot writes its team file
// right after the turn), reads the team, and decides:
//   - a Bot's own chat: notify with the reply, unless the turn was a hidden
//     Bot-to-Bot exchange (ds-bot lists those in `exchangeTurns`);
//   - a group: notify every line members posted since the last notice for that
//     group, so each Bot's reply arrives as its own notice;
//   - a DSH Agent or plain DSH Session: notify when the user (or a scheduled task)
//     started the turn, so sub-agents and internal turns stay quiet;
//   - an archived segment: never.
// A Bot asking the user a question (ask_user) notifies right away.
//
// DSH may report the message that starts a turn before the turn itself (a message
// sent to an idle Session): that message is held and claimed by the next turn, as
// ds-bot does, so the turn still knows the user started it.
import { lastLine, memberLines, sessionKind } from './team.js'

const MAX_TEXT = 400
const KEEP_DECISIONS = 30
const VISIBLE_TRIGGERS = new Set(['user', 'schedule'])

export const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string')
  .map(block => block.text)
  .join('\n')
  .trim()

export const clip = text => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat
}

function questionOf(args) {
  let card = args
  if (typeof card === 'string') {
    try { card = JSON.parse(card) } catch { return '' }
  }
  return typeof card?.question === 'string' ? card.question.trim() : ''
}

export function createTracker({ team, emit, settleMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const turns = new Map()
  // What a message that came before its turn says started it, per Session.
  const early = new Map()
  // The last decisions, newest last, for the app's 诊断记录 (what the server saw
  // and why it did or did not notify).
  let decisions = []
  const counts = { events: 0, turnEnds: 0, lastEventAt: 0 }
  const decide = (id, what, turn, result) => {
    decisions = [...decisions, { at: Date.now(), sessionId: id, kind: what?.kind, trigger: turn?.trigger, reason: turn?.reason, result }].slice(-KEEP_DECISIONS)
  }
  const timers = new Set()
  // Group line numbers already notified; set from the team file at start, so old
  // lines are never sent. A group first seen later is new, so all its lines count.
  const seen = new Map()
  const ready = team.load().then((state) => {
    for (const room of Object.values(state.rooms)) seen.set(room.id, lastLine(room))
  })

  const later = (fn) => {
    const timer = setTimer(() => {
      timers.delete(timer)
      void fn()
    }, settleMs)
    timers.add(timer)
  }

  async function settle(id, turn) {
    await ready
    const state = await team.load()
    const what = sessionKind(state, id)
    if (what.kind === 'room') {
      const room = what.room
      const after = seen.get(room.id) ?? 0
      const lines = memberLines(room, after)
      seen.set(room.id, Math.max(after, lastLine(room)))
      for (const line of lines) emit({ kind: 'reply', sessionId: room.id, title: room.name || '群聊', who: line.who, text: clip(line.text) })
      decide(id, what, turn, lines.length > 0 ? `sent ${lines.length}` : 'skip: no new group lines')
      return
    }
    if (what.kind === 'archived') return decide(id, what, turn, 'skip: archived')
    if (turn.reason === 'aborted') return decide(id, what, turn, 'skip: stopped')
    const failed = turn.reason === 'error'
    if (what.kind === 'chat') {
      if ((state.exchangeTurns[id] ?? []).includes(turn.turn)) return decide(id, what, turn, 'skip: bot-to-bot')
      if (!failed && turn.text === '') return decide(id, what, turn, 'skip: empty reply')
      emit({ kind: failed ? 'error' : 'reply', sessionId: id, title: what.bot.name || 'Bot', text: failed ? '回复失败' : clip(turn.text) })
      return decide(id, what, turn, 'sent')
    }
    if (!VISIBLE_TRIGGERS.has(turn.trigger)) return decide(id, what, turn, 'skip: not started by the user')
    if (!failed && turn.text === '') return decide(id, what, turn, 'skip: empty reply')
    decide(id, what, turn, 'sent')
    const title = what.kind === 'agent' ? (what.agent.name || 'DSH Agent') : 'DSH'
    emit({ kind: failed ? 'error' : 'reply', sessionId: id, title, text: failed ? '回复失败' : clip(turn.text) })
  }

  async function asked(id, question) {
    await ready
    const state = await team.load()
    const what = sessionKind(state, id)
    if (what.kind === 'room' || what.kind === 'archived') return
    const title = what.kind === 'chat' ? (what.bot.name || 'Bot') : what.kind === 'agent' ? (what.agent.name || 'DSH Agent') : 'DSH'
    emit({ kind: 'question', sessionId: id, title, text: clip(question) || '在等你回答' })
  }

  function onEvent(id, event) {
    if (typeof id !== 'string' || !event) return
    counts.events += 1
    counts.lastEventAt = Date.now()
    if (event.type === 'turn/end') counts.turnEnds += 1
    switch (event.type) {
      case 'turn/start':
        turns.set(id, { turn: event.data?.turn, trigger: early.get(id), texts: [] })
        early.delete(id)
        break
      case 'user/message': {
        const turn = turns.get(id)
        const kind = event.data?.source?.kind
        if (!turn) {
          if (!early.has(id)) early.set(id, kind)
        } else if (turn.trigger === undefined) turn.trigger = kind
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data?.message?.content)
        if (text !== '') turns.get(id)?.texts.push(text)
        break
      }
      case 'tool/call':
        if (event.data?.name === 'ask_user') void asked(id, questionOf(event.data.arguments))
        break
      case 'turn/end': {
        const turn = turns.get(id) ?? { turn: event.data?.turn, trigger: undefined, texts: [] }
        turns.delete(id)
        const done = { turn: turn.turn, trigger: turn.trigger, text: turn.texts.join('\n\n').trim(), reason: event.data?.reason?.kind }
        later(() => settle(id, done))
        break
      }
    }
  }

  function dispose() {
    for (const timer of timers) clearTimer(timer)
    timers.clear()
    turns.clear()
    early.clear()
  }

  return { onEvent, dispose, get ready() { return ready }, get decisions() { return decisions }, get counts() { return { ...counts } } }
}

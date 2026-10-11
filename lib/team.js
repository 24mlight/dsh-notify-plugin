// Reads ds-bot's team file (DSH_HOME/bot/state.json) to tell what a Session is:
// a Bot's own chat, a member's hidden Session in a group, a group itself, or a
// DSH Agent. Without ds-bot (no file) every Session is plain DSH.
import { readFile } from 'node:fs/promises'

const EMPTY = { bots: {}, rooms: {}, agents: {}, exchangeTurns: {} }

export function createTeam(path, read = file => readFile(file, 'utf8')) {
  async function load() {
    try {
      const state = JSON.parse(await read(path))
      return {
        bots: state?.bots ?? {},
        rooms: state?.rooms ?? {},
        agents: state?.agents ?? {},
        exchangeTurns: state?.exchangeTurns ?? {},
      }
    } catch {
      return EMPTY
    }
  }
  return { load }
}

/**
 * What Session `id` is in the team `state`:
 *   { kind: 'chat', bot }          a Bot's current own chat
 *   { kind: 'room', room }         a group, or a member's hidden Session in it
 *   { kind: 'agent', agent }       a DSH Agent Session
 *   { kind: 'archived' }           an earlier segment of a Bot's chat
 *   { kind: 'plain' }              anything else (a plain DSH Session)
 */
export function sessionKind(state, id) {
  for (const bot of Object.values(state.bots)) {
    if ((bot.sessionId ?? bot.id) === id) return { kind: 'chat', bot }
  }
  for (const room of Object.values(state.rooms)) {
    if (room.id === id || Object.values(room.sessions ?? {}).includes(id)) return { kind: 'room', room }
  }
  for (const agent of Object.values(state.agents)) {
    if ((agent.sessions ?? []).includes(id)) return { kind: 'agent', agent }
  }
  for (const bot of Object.values(state.bots)) {
    if (bot.id === id || (bot.segments ?? []).some(segment => segment.sessionId === id)) return { kind: 'archived' }
  }
  for (const room of Object.values(state.rooms)) {
    if (Object.values(room.segments ?? {}).flat().some(segment => segment.sessionId === id)) return { kind: 'archived' }
  }
  return { kind: 'plain' }
}

/** The last line number of a group's log (0 when empty). */
export const lastLine = room => (room.log ?? []).reduce((max, line) => Math.max(max, Number(line.seq) || 0), 0)

/** Lines a member posted to the group after line `after` (not the user's, not lookups). */
export const memberLines = (room, after) => (room.log ?? [])
  .filter(line => (Number(line.seq) || 0) > after && line.kind === undefined && line.who !== 'User' && typeof line.text === 'string' && line.text.trim() !== '')

# dsh-notify

**English** · [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) server plugin for the [DSH Bot Android app](https://github.com/24mlight/dsh-bot-android). When a Bot, a [ds-bot](https://www.npmjs.com/package/ds-bot) group or a DSH Agent replies, it tells the app, so the phone shows a notification even while the app is closed.

It works with or without ds-bot. Without it, every session is a plain DSH session.

## Install

Run these on the machine that runs `dsh web` (it needs `git`). Replace `web` with your profile's name:

```bash
dsh plugin --profile web add github:24mlight/dsh-notify-plugin
systemctl restart dsh-web
```

The package name is `dsh-notify`, so that is the name `update` and `remove` use:

```bash
dsh plugin --profile web update dsh-notify && systemctl restart dsh-web
dsh plugin --profile web remove dsh-notify && systemctl restart dsh-web
```

Then turn on **消息通知** (notifications) in the app. The [app's README](https://github.com/24mlight/dsh-bot-android#notifications) covers the phone side, including the battery settings that strict Android skins need.

## When it notifies

| Where | When |
|---|---|
| A Bot's own chat | each reply; a failed reply says so |
| A group (ds-bot) | each message a member posts, one notice per message |
| DSH Agent or a plain DSH session | when a turn you (or a scheduled task) started ends |
| Any | a Bot asks you a question (`ask_user`), at once |

It stays quiet for:
- hidden Bot-to-Bot exchanges;
- lookups;
- your own messages;
- sub-agents and other internal turns;
- stopped and empty replies;
- archived chats.

To tell these apart it reads ds-bot's team file, `$DSH_HOME/bot/state.json`, and never writes to it.

## How it works

- **`POST /api/dsh-notify`** is a long poll, authenticated by the DSH web login cookie.
  - Request: `{ boot, since, waitMs }`, waiting at most 30 s.
  - Response: `{ ok, value: { boot, seq, events } }`.
  - `boot` changes on every server start, so a phone holding an old number starts over instead of waiting for a number that will never come.
- **`{ "test": true }`** pushes one test notice. It powers the app's 发送测试通知 (send test notification) button.
- **`{ "debug": true }`** returns the plugin version, counters and the last 30 decisions: for each finished turn, the session, its kind, who started it, and `sent` or why it was skipped. It powers the app's 诊断记录 (diagnostics).
- **Storage:** the last 100 notices live in memory only; nothing is written to disk.

```
index.js          the route and the Session event hook
lib/tracker.js    turns Session events into notices (the rules above)
lib/team.js       reads ds-bot's team file: Bot chat, group, DSH Agent, archived
lib/hub.js        the numbered notice queue the phone long-polls
```

Tests: `npm test`.

## License

[MIT](LICENSE)

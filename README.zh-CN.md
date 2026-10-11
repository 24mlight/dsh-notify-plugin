# dsh-notify

[English](README.md) · **简体中文**

这是 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）的服务器端插件，配合 [DSH Bot 安卓 App](https://github.com/24mlight/dsh-bot-android) 使用。Bot、[ds-bot](https://www.npmjs.com/package/ds-bot) 群聊或 DSH Agent 回复时，它会通知 App，手机在 App 关着时也能弹出通知。

装不装 ds-bot 都能用。没装 ds-bot 时，所有会话都按普通 DSH 会话处理。

## 安装

在运行 `dsh web` 的机器上执行（需要有 `git`），把 `web` 换成你的 profile 名：

```bash
dsh plugin --profile web add github:24mlight/dsh-notify-plugin
systemctl restart dsh-web
```

包名是 `dsh-notify`，更新和卸载都用这个名字：

```bash
dsh plugin --profile web update dsh-notify && systemctl restart dsh-web
dsh plugin --profile web remove dsh-notify && systemctl restart dsh-web
```

装好后在 App 里打开「消息通知」。手机端的设置见 [App 的 README](https://github.com/24mlight/dsh-bot-android/blob/main/README.zh-CN.md#消息通知)，包括电池管理较严的安卓系统需要打开的后台权限。

## 什么时候通知

| 场景 | 什么时候通知 |
|---|---|
| Bot 单聊 | Bot 每次回复；回复失败也会通知 |
| 群聊（ds-bot） | 成员每发一条消息就通知一条 |
| DSH Agent 或普通 DSH 会话 | 你（或定时任务）发起的一轮结束时 |
| 任何对话 | Bot 向你提问（`ask_user`）时，立即通知 |

以下情况不通知：
- Bot 之间的内部沟通；
- 查资料的过程；
- 你自己发的消息；
- 子 agent 和其他内部轮次；
- 被停止的回复和空回复；
- 已归档的对话。

为了区分这些情况，插件会读 ds-bot 的数据文件 `$DSH_HOME/bot/state.json`，但从不修改它。

## 原理

- **`POST /api/dsh-notify`** 是长轮询接口，用 DSH web 的登录 cookie 认证。
  - 请求：`{ boot, since, waitMs }`，最多等 30 秒。
  - 返回：`{ ok, value: { boot, seq, events } }`。
  - 服务器每次启动 `boot` 都会变。手机拿着旧编号时会从头开始，不会一直等一个永远不会出现的编号。
- **`{ "test": true }`** 推送一条测试通知，对应 App 里的「发送测试通知」。
- **`{ "debug": true }`** 返回插件版本、计数，以及最近 30 次判断：每一轮结束时，是哪个会话、什么类型、谁发起的，结果是 `sent`（已发），还是为什么跳过。对应 App 里的「诊断记录」。
- **存储：** 最近 100 条通知只保存在内存里，不写盘。

```
index.js          接口路由和会话事件监听
lib/tracker.js    把会话事件转成通知（上面的规则）
lib/team.js       读 ds-bot 数据文件，区分 Bot 单聊、群聊、DSH Agent、已归档
lib/hub.js        手机长轮询的带编号的通知队列
```

测试：`npm test`。

## 许可证

[MIT](LICENSE)

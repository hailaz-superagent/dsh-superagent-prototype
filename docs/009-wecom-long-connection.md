# 企业微信长连接 Source：实现与接入

本文是 dsh-superagent 的 WeCom Source 长连接实现说明，包含代码结构、协议映射、配置、迁移、验证与限制。更完整的托管部署背景见 [006 Deployment](006-deployment.md)，Source 的领域模型见 [001 Domain model](001-domain.md)。

## 1. 结论

WeCom Source 现在支持两种接入方式，二者共用同一套 Trigger、Policy、Thread 和 Channel：

| 方式 | 入口 | 是否需要额外进程 | 是否需要公网 | 新消息时延 |
| --- | --- | --- | --- | --- |
| `live`（推荐） | dsh-superagent 进程内的官方 AI Bot SDK WebSocket 长连接 | 否 | 否，只需出网 | 推送，通常亚秒级 |
| `bridge` | 本机 wecombridge 的 JSONL spool + 3 秒轮询 | 是（Go/Node bridge） | 否，仅回环 | 最长约 3 秒 |

`live` 模式直接使用企业微信官方 `@wecom/aibot-node-sdk`：SDK 负责认证、心跳、断线重连，dsh-superagent 只做事件映射、入库和回复。没有 bridge、没有轮询、没有回调 URL。

当前运行中的部署仍保持 `bridge` 模式；本文第 6 节说明如何安全切换。切换前必须先停掉占用同一个机器人的 bridge，因为**一个机器人同时只允许一条长连接**。

## 2. 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/sources/wecom-shared.ts` | 共享 `SOURCE = 'wecom'` 和确定性的 Trigger id（按企业微信 `msgid`） |
| `src/sources/wecom.ts` | Source 类型定义、配置 schema、bridge 事件 schema、Trigger 映射、Policy/Scope、Channel、健康检查和 watch 循环 |
| `src/sources/wecom-live.ts` | 官方 SDK 适配器、长连接回调与图片映射、被动/主动回复、连接生命周期 |
| `src/sources/wecom-live-image.ts` | 在图片 URL 过期前下载解密并落盘，评估时作为附件读取 |
| `src/wecom-watch.ts` | Cordis 插件入口：注册 kind，按配置运行 bridge 轮询或长连接 |
| `tests/wecom.spec.ts` | bridge 路径：事件校验、游标、Policy、线程上下文 |
| `tests/wecom-live.spec.ts` | 长连接路径：回调映射、回复路由、生命周期，以及真实 SDK 对假 WebSocket 服务端的往返 |

构建时 `@wecom/aibot-node-sdk` 被标记为 external（`tsdown.config.ts`），运行时从 dsh-superagent 自己的 `node_modules` 解析；升级 SDK 不需要重新打包业务代码。

## 3. 数据流

```text
企业微信 AI Bot
   │  WebSocket 出站长连接（wss://openws.work.weixin.qq.com）
   ▼
dsh-superagent 的 wecom-live.ts
   │  aibot_msg_callback → liveTrigger()
   │  ctx.receive(trigger)  ← 按 msgid 幂等
   ▼
Eval → Ticket → Executor
   │  outbox 产生回复
   ▼
sendLiveReply()
   ├─ 回调 4 秒内：aibot_respond_msg（被动回复原消息）
   └─ 超时/重启后：aibot_send_msg（主动发到会话）
```

与 bridge 的关键差异：

- 不再有 `wecom-cursor` 和 JSONL spool；消息到达即 `ctx.receive`，Trigger 由 Store 持久化并按 id 去重。
- Thread 改为**按会话聚合**：单聊是 `direct:<userid>`，群聊是 `group:<chatid>`。同一会话的后续消息会进入已有 Thread，能唤醒原 Ticket；bridge 路径仍保持原来的每条消息一个 Thread。
- 回复地址带 `transport: 'live'`，Channel 据此选择 SDK 而不是 HTTP bridge。

## 4. 配置

### 4.1 Source 配置

在 Superagent 面板的 Source 设置中把「接入方式」改为 `AI Bot 长连接`，并填写：

| 字段 | 说明 |
| --- | --- |
| `mode` | `bridge` 或 `live`；默认 `bridge`，保持旧配置可用 |
| `botId` | 企业微信智能机器人的 BotID |
| `secret` | 机器人 Secret；保存在本机 0600 的 Superagent 状态库，不要写进仓库或聊天 |
| `wsUrl` | 可选；私有部署的长连接地址，留空用公有云默认地址 |
| `directMessages` | 是否接收单聊，默认开启 |

`bridgeUrl` 和 `pollSeconds` 仍保留给 `bridge` 模式。旧配置 `{bridgeUrl, pollSeconds, directMessages}` 不需要迁移，`mode` 会默认成 `bridge`。

### 4.2 策略

```json
{
  "wecom": {
    "allowed": [
      { "id": "<企微 userid>", "name": "<备注名>" }
    ],
    "admission": {}
  }
}
```

只有 `allowed` 里的 userid 能发起明确工作；群聊必须 @ 机器人，单聊受 `directMessages` 控制。机器人回调只会在被 @ 时到达群聊，长连接不会收到未 @ 的群消息。

### 4.3 执行环境变量

| 变量 | 值 |
| --- | --- |
| `DSH_SUPERAGENT_WECOM_CHAT` | 触发工单的会话 id |
| `DSH_SUPERAGENT_WECOM_ACCOUNT` | 触发工单的 userid |

## 5. 实现要点

### 5.1 SDK 适配器

`sdkLiveBot()` 把 `WSClient` 收窄成 `LiveBot` 接口：

- 认证：`botId` + `secret`；
- 重连：`maxReconnectAttempts: -1`、`maxAuthFailureAttempts: -1`，由 SDK 指数退避；
- 心跳：30 秒；
- 回执：SDK 失败时 reject 原始 frame，适配器转成 `Error`，避免 outbox 只看到 `[object Object]`；
- 日志：使用静默 logger，健康状态通过 `SourceContext.report` 暴露，Secret 不出现在日志里。

`LiveBot` 是故意很小的接口，测试可以注入假实现，不需要启动真实 WebSocket。

### 5.2 回调映射

`liveTrigger(frame)` 读取：

- `body.msgid` → Trigger id（`wecomTriggerId`），去重依据；
- `body.chattype` / `body.chatid` / `body.from.userid` → 会话和发送者；
- `body.text.content`、`body.mixed.msg_item[*].text.content`、`body.voice.content` → 文本；
- `body.create_time`（秒）→ `at`；
- `headers.req_id` → 被动回复用的 request id。

读取前用 zod 校验；`${inline_mention:...}` 占位符和零宽空格会清理。

图片在回调到达时立即用 SDK `downloadFile` 下载并解密（企业微信的图片 URL 只有约 5 分钟有效），按魔数校验 PNG/JPEG/WebP/GIF，限制 20MB，写入 `<stateDir>/wecom-live-media/<msgid>/<key>.<ext>`（目录 0700、文件 0600）。消息文本写成 `[图片] img_wecom_N`，图文混排按原顺序保留文本和图片；下载失败时该标记变成 `[图片不可用]`，消息本身不会丢。评估阶段 `threadContext.image` 读取文件并通过附件服务交给支持图片输入的模型；文本模型会明确拒绝。

文件和视频没有可读正文，当前写成 `[文件]` / `[视频]`（有文件名时带上），提示评估向对方确认或要求重发。

### 5.3 回复

`sendLiveReply()` 的策略与 bridge 对齐：

- 回调到达 4 秒内、且有 `req_id`：走 `aibot_respond_msg`，回复挂在原消息上；
- 超过窗口、进程重启、或被动回复失败：走 `aibot_send_msg`，单聊目标用 `userid`，群聊用 `chatid`，并带 `chat_type: 1/2`；
- 文本经过与其他 IM 相同的 100 词上限校验，避免超长消息被企业微信拒绝。

### 5.4 生命周期与健康

`startLive()`：

1. 校验 BotID/Secret；缺失时 `wecom` 健康状态为 `paused`，不建立连接；
2. 注册认证/断开/错误/消息回调；
3. 串行处理消息（`chain`），保证评估看到的顺序与到达顺序一致；
4. 按 `msgid` 做进程内去重（Store 仍会按 Trigger id 兜底）；
5. 中止时断连、等待消息链结束、清空全局连接。

`watchWecom()` 每 3 秒检查一次配置：模式或凭证变化会重启连接；切回 `bridge` 会停止长连接并恢复轮询。健康条目 `wecom` 的状态：

- `starting`：连接中或断线重连中；
- `ready`：已认证；
- `paused`：Source 关闭或凭证缺失；
- `error`：SDK 错误或消息处理失败。

## 6. 从 bridge 切换与回滚

### 6.1 切换前检查

```bash
# 当前 bridge 是否在跑，占用同一个机器人
tmux ls
curl -sS http://127.0.0.1:3099/health
```

同一个机器人只能有一条长连接。先停 bridge，否则新连接会把旧连接踢掉（SDK 的 `disconnected_event`）。

### 6.2 切换

```bash
# 1. 停止 bridge（按实际会话名）
tmux kill-session -t dsh-wecom-bridge

# 2. 在面板 Source 设置里把 mode 改为 live，填入 BotID/Secret，保存
#    或在设置 API 中保存同样的 config

# 3. 构建并重启 dsh-superagent（面板的 Restart，或重启 DSH 进程）
cd /data/workspace/dsh-superagent
pnpm install
pnpm build

# 4. 看健康
#    面板 Source 页应显示「已连接」；日志不应出现 Secret
```

如果 Bot 配置正确，企业微信的单聊/群 @ 消息会立即进入 Source；回复在 4 秒内被动挂回原消息，长任务结果走主动发送。

### 6.3 回滚

把 `mode` 改回 `bridge`，保存后约 3 秒长连接会断开，然后启动原来的 bridge：

```bash
cd /data/workspace/wecombridge-node   # 或 Go 版目录
./scripts/start.sh
curl -sS http://127.0.0.1:3099/health
```

`bridge` 的 spool、游标和已有 Trigger 都不受影响。

## 7. 验证

本实现已执行的检查：

```bash
cd /data/workspace/dsh-superagent
pnpm typecheck
pnpm exec vitest run tests/wecom.spec.ts tests/wecom-live.spec.ts
pnpm build
```

`tests/wecom-live.spec.ts` 覆盖：

- 群聊 @ / 单聊 / 混合文本 / 语音转写 / 占位符清理 / 非法回调；
- 图片与图文混排的顺序、下载落盘、失败降级为 `[图片不可用]`、附件读取；
- 4 秒内被动回复、超时主动发送、单聊用 userid、无会话时 `gone`；
- 认证健康、消息串行入库、重复 `msgid` 去重、停止时断连；
- 缺少凭证时 paused、SDK 错误进入健康状态；
- 真实 `@wecom/aibot-node-sdk` 对假 WebSocket 服务端的认证、入站消息和被动回复往返。

未执行：用真实企业微信机器人做线上切换（会中断当前正在使用的 bridge 会话），以及文件/视频正文和频道能力（当前不支持）。

## 8. 已知限制

1. **文件/视频没有正文**：文本、图文混排、语音转写和图片已支持；文件和视频只保留标记，不能读取内容。
2. **不支持频道/Topic**：官方 SDK 1.0.7 不提供频道事件与 API；bridge 的 Topic 兼容路径不在长连接里。
3. **没有历史补收**：长连接只推送在线期间的新消息；进程停机期间的消息不会补。bridge 的 spool 具备这个能力。
4. **单连接**：同一个 BotID 只能有一条长连接；多实例部署必须分开机器人。
5. **单聊无 chatid**：主动发送用 userid；群聊用 chatid。两者都在 Trigger 的 channel address 里保存。
6. **重启窗口**：进程重启后，4 秒被动窗口已过，未发出的回复自动走主动发送；已经入库的 Trigger 不会丢。
7. **Secret 存在状态库**：配置文件权限为 0600，但面板字段是明文输入框；不要把截图或配置发到公开渠道。
8. **图片落盘没有自动清理**：`<stateDir>/wecom-live-media/` 会随消息增长；当前量小可接受，长期运行需要按天/大小清理。

## 9. 后续工作

- 文件/视频下载与附件（需要评估侧能读文件）；
- 图片目录的定期清理；
- 频道（Topic）事件与回复；
- 断线期间的消息补收（需要企业微信侧可拉取的历史接口或本地 spool）；
- 把长连接健康拆成独立条目，区分「未配置」「认证失败」「重连中」。

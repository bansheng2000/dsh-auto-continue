# dsh-auto-continue — 异常中断自动继续

对话被**非正常中断**（父级停止、归档、会话释放、未知原因）时，自动补一句「继续」把任务接着跑；
**用户自己点的终止**（cancel cause `kind === "user"`）一律不动。

## 判定依据（从 app.asar 反查确认）

宿主 loop 在轮次结束时先抛错，再往 session log 落 `turn/end`：

```js
this.session.append("turn/end", { turn, reason: turnEnds });
// turnEnds = { kind: "aborted", reason: abortedCancelCause(signal) }
```

`abortedCancelCause(signal)` 读 `signal.reason` 并按 `cause.kind` 归一：

| kind | 含义 | 默认动作 |
|---|---|---|
| `user` | 用户自己点的终止（`sessionController.cancel()` → `agent.cancel({kind:'user'})`） | **不管** |
| `hook` | 插件通过 `cancel({kind:'hook'})` 停的 | 不管（可配置纳入） |
| `parent` | 父级/上级停的 | 续 |
| `disposed` | 会话被释放 | 续 |
| `legacy` / 未知 | 旧格式/无法归类 | 续 |

所以「正常/异常」的判据就是 abort cause 的 kind，不需要猜超时、猜堆栈。
`agent/error` 不带 cause（只是个 re-broadcast），`api-session/error` 也不带——
`session/event` 的 `turn/end` 是唯一把 cause 递到插件面前的通道。

## 继续的投递口

`turn/end` 之后 inbox 已被 cancel 清空（`keepInbox: false` 时连排队输入一起丢），
所以必须另起一轮：`agent.followup(message)` → `send(input, "next-turn", true)`，
会往 inbox 排队并唤醒 driver。steer 只在活轮次内有效，轮次关了它无处可去。

消息自己造，形状与宿主 `createUserMessage` 一致（`deepFreeze(structuredClone({id, role:'user', content, source}))`），
不为此引入 `@deepseek-ai/dsh-llm` 依赖。

## 配置

写在 loader entry `auto-continue` 的 config 里（优先级最低，可被设置卡片覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `rules.enabled` | `true` | 装上即生效；关掉后只留状态查询 |
| `rules.causes` | `["parent","disposed","legacy","unknown"]` | 哪些 abort cause 算异常 |
| `rules.prompt` | `"继续"` | 补发的那句话 |
| `rules.maxRetries` | `3` | 同一会话最多自动续几次，防 runaway |

`user` 恒不算异常——这是需求的第一条，不提供开关。

## 状态查询

`GET /_auto-continue/status` → `{ active, continued, lastReason, attempts }`。
路由按宿主 `WebRoute` 契约注册：`{ kind: "exact", path, handler(req, res) }`，
raw node http，`res.writeHead()/res.end()`。

## 安装

```bash
pnpm link --dir .            # 或 dsh plugin --profile <profile> add <path>
```

然后确认 profile 的 `package.json` 里有 `dsh-auto-continue` 依赖 + `dsh.profile.bundles` 条目，
`cordis.patch.yml` 有 `auto-continue` 行。本仓库已接进
`C:\Users\12576\.dsh\profiles\desktop`（node_modules 下是指向本目录的 junction，改源码即生效）。

## 自检

```bash
node test/selftest.mjs
```

覆盖：默认配置、user/hook 不续、parent 续一条、其它 turn/end reason 不续、
maxRetries 封顶、拿不到 agent 不耗配额、enabled=false、自定义 causes、畸形 payload、多会话隔离。

# dsh-auto-continue — 异常中断自动继续

对话被**非正常中断**（轮次报错如 429/502、进程崩溃后恢复、输出被 max-tokens 截断，以及父级停止、归档、会话释放、未知原因）时，自动补一句「继续」把任务接着跑；
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

`reason.kind` 不是 `aborted` 的轮次另有三种，按 `rules.kinds` 判（session log 实测：打断会话的其实是这三种，不是 aborted）：

| reason.kind | 含义 | 默认动作 |
|---|---|---|
| `error` | LLM 报错把轮次打死（429 限流、502 上游失败等） | 续 |
| `interrupted` | 上次进程崩在轮次中途，恢复时补的 turn closer | 续 |
| `max-tokens` | 输出被截断，任务没做完 | 续 |
| `completed` / `blocked` / `forked` | 正常完成 / 权限或 hook 拦下 / 用户分叉 | **不管** |

## 继续的投递口

`turn/end` 之后 inbox 已被 cancel 清空（`keepInbox: false` 时连排队输入一起丢），
所以必须另起一轮：`agent.followup(message)` → `send(input, "next-turn", true)`，
会往 inbox 排队并唤醒 driver。steer 只在活轮次内有效，轮次关了它无处可去。

消息自己造，形状与宿主 `createUserMessage` 一致（`deepFreeze(structuredClone({id, role:'user', content, source}))`），
不为此引入 `@deepseek-ai/dsh-llm` 依赖。

拿 agent 的姿势有个硬要求：**`agents` 必须写进插件导出的 `inject`**（本插件是 `const inject = ["agents"]`），
否则宿主 ctx 上根本没有 `ctx.agents`，`ctx.agents?.get?.(id)` 恒为 `undefined`，
每次异常都停在「no live agent」，表现就是「中断了没有发继续」。
同类在役写法：`dsh-memory-evolve/lib/index.js:76` 的 `inject = ['tools', …, 'agents', …]`、
`dsh-prompt-optimizer/lib/index.js:112` 的 `ctx.inject([…, "agents", …], (sctx) => …)`。
取值走 `ctx.get("agents") ?? ctx.agents` 双路。

## 配置

写在 loader entry `auto-continue` 的 config 里（优先级最低，可被设置卡片覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `rules.enabled` | `true` | 装上即生效；关掉后只留状态查询 |
| `rules.causes` | `["parent","disposed","legacy","unknown"]` | 哪些 abort cause 算异常；写 `[]` = 全禁 |
| `rules.kinds` | `["error","interrupted","max-tokens"]` | 哪些非 aborted 的 turn/end reason 算异常；写 `[]` = 全禁 |
| `rules.prompt` | `"继续"` | 补发的那句话（去首尾空白；超长截断到 2000 字符） |
| `rules.maxRetries` | `3` | 同一会话最多自动续几次（计数按 30 分钟窗口累计、`completed` 时归零），防 runaway |

`user` 恒不算异常——这是需求的第一条，不提供开关。
空数组 = 全禁（**不是**「回落默认」）：不写这个键才用默认名单，两者含义不同。
cause 认不出来（`unknown`，即 abort 的 cause 字段缺失或形态不认识）**只续 1 次**，第二次会记进 `lastSkip`——
既不静默漏掉真异常，也不会把「用户手动停、但 cause 没记上」那种反复续起来。
反过来，宿主以后新增的**有名字**的 cause 不在默认名单里 → 一次都不续（要续就把它加进 `rules.causes`）。
第 1 次异常立即续；第 2 次起先退避再续（2s 起、×2 递增、±30% 抖动、上限 30s），
免得上游 429 时几秒内原地撞满 `maxRetries`（每撞一次都是一轮无效的 LLM 调用）。

## 状态查询

`GET /_auto-continue/status` → `{ active, continued, seen, lastSeen, lastReason, lastSkip, attempts }`。
`seen`/`lastSeen` 是观测口：宿主每发一个 `turn/end` 就计数、记下 `sessionId/turn/reason`，
用来证明监听确实挂上了（而不是判定把事件放过了）。
`lastSkip` 记「本该续但没续」的原因（`no-live-agent` / `agent-has-no-followup` /
`no-live-agent-on-retry` / `already-scheduled` / `unknown-cause-already-continued` /
`followup-failed: …`）——没有这个字段时，「中断没续」只能靠猜。
路由按宿主 `WebRoute` 契约注册：`{ kind: "exact", path, handler(req, res) }`，
raw node http，`res.writeHead()/res.end()`。
**只服务回环**：Host 头不是 `127.0.0.1` / `localhost` / `::1` 一律 403。这条路由是用
`ctx.webServer.register` 裸注册的，不在宿主 `/api/*` 的浏览器鉴权墙后面，而本机常驻的
cloudflared 隧道会把公网请求以 `127.0.0.1` 送达（`remoteAddress` 因此不可信），
所以只能自己按 Host 头把关。

## 故障排查

「中断了没自动继续」按这个顺序查，每一步都能自己验证：

1. **插件挂没挂**：`curl http://127.0.0.1:19387/_auto-continue/status`。没响应就是没挂上
   （查安装那节的 `- insert:` 坑与「必须重启宿主」）——此时事件监听根本没建立，判定逻辑无从谈起。
2. **事件进来没有**：`seen` 每来一个 `turn/end` 就 +1。一直不动说明监听没挂上，或宿主改了事件名。
3. **为什么没续**：看 `lastSkip`。`no-live-agent` = 那一刻拿不到 agent（宿主进程刚崩、或会话已 dispose，
   插件结构上盖不住这类中断——它不会新建 agent）；`followup-failed:` 后面跟着投递时的原始错误。
4. **是不是额度挡住了**：`attempts` 里该会话的计数到 `maxRetries` 就不再续；计数按 30 分钟窗口累计，
   会话正常收轮（`completed`）时归零。
5. `cause=user`（用户自己点的终止）**不会**续——这是设计，不是故障。

## 安装

profile 的 `package.json` 加一条依赖，再 `pnpm install`：

```json
"dsh-auto-continue": "github:bansheng2000/dsh-auto-continue"
```

本地开发则写 `"dsh-auto-continue": "file:/绝对/路径/dsh-auto-continue"`。
装完确认 profile 的 `dsh.profile.bundles` 里有 `dsh-auto-continue`，且 `cordis.patch.yml`
落到了 loader 行（bundle 自带的 patch 用 `- insert:` 建行；扁平 `- id:` 只改已有条目配置，
条目不存在时是空操作，插件会静默不挂载）。要求宿主 DSH ≥ `0.1.7-rc.1`（见 `package.json` 的 `dsh.engines`）。

三个坑：
- pnpm 装进 profile 的 `node_modules` 是**真实拷贝，不是软链**：改了远端或本地源码都要重装（或手工同步）才生效。
- 改完代码要**重启宿主**，插件是启动时加载的（改文件本身不会热重载；`plugin_manager` 关掉再打开 bundle 会让 entry 重建，但 ESM 模块缓存还在，仍是旧代码）。
- 忘写 `inject: ["agents"]` 不会报错，只会静默不续（见上「继续的投递口」）。

### 更新

1. 改代码 → 改 `package.json` 的 `version` → commit → push（顺手打 tag `vX.Y.Z`）；
2. 另一台机器 `pnpm update dsh-auto-continue`。裸 `github:` 规格会重新解析默认分支最新提交；
   想按版本号升级，规格写成 `github:bansheng2000/dsh-auto-continue#semver:^0.1.0`，再配合 tag；
3. 重启宿主。

## 自检

依赖没提交进 git（`node_modules/` 已忽略），第一次跑先装：

```bash
pnpm install
node test/selftest.mjs   # 期望输出 auto-continue selftest: all assertions passed
```

覆盖：默认配置、user/hook 不续、parent 续一条、`kinds` 里的 error/interrupted 续、
`completed`/`blocked` 不续、`kinds` 覆盖生效、maxRetries 封顶、拿不到 agent 不耗配额、
enabled=false、自定义 `causes`、畸形 payload、多会话隔离。

/**
 * dsh-auto-continue — 异常中断自动继续
 *
 * 需求（用户原话，m00003）：
 *   「我想做一个DSH插件，效果是如果检测到对话是非正常中断或者停止就让任务
 *     继续进行下去，或者发一个继续。如果是正常中断，比如我自己点的终止，就不用管。」
 *
 * 宿主契约（从 app.asar 反查确认，均可在源码里逐字对上）：
 *  - 轮次结束时 loop 先抛错，再 `turn/end` 落 `{ turn, reason }`，其中
 *    `reason.kind === "aborted"` 时 `reason.reason` 就是 `AgentCancelCause`：
 *      user | parent | hook | disposed | legacy
 *    `"user"` 正是「用户自己点的终止」——sessionController.cancel() 里写死的
 *    `agent.cancel({ kind: 'user' }, { keepInbox: true })`（asar @16776481）。
 *    所以「正常/异常」的判据就是 abort cause 的 kind，不需要猜。
 *  - 实测踩坑：只认 aborted 会漏掉真实事故——session log 里打断会话的其实是
 *    `reason.kind === "error"`（429/502）和 `"interrupted"`（崩后恢复补 closer），
 *    判定因此扩展为 aborted(按 cause) + rules.kinds(按 reason.kind)，见 ABNORMAL_KINDS。
 *  - 继续的投递口只有一个：`agent.followup(message)` → `send(input, "next-turn", true)`，
 *    会往 inbox 排队并唤醒 driver（asar @14456748）。steer 只在活轮次内有效，
 *    轮次已经关了它无处可去，所以异常中断后用 followup。
 *  - 补一句消息必须自己造 `UserMessage`。宿主不导出 createUserMessage
 *    （在 @deepseek-ai/dsh-llm 里，插件不该为其加依赖），而
 *    `createMessage(input) = deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`，
 *    `brandString` 是恒等函数（asar @18279181）。所以照抄这三行就是同一形状。
 *
 * 自愈面（宁可少报也不错报）：
 *  - `agent/error`：任何 step/turn 抛错都会经 throwError() 发这个事件，
 *    但**不含** abort cause，只能事后从 session log 读 `turn/end` 判定。
 *  - `session/event` 的 `turn/end`：带完整 reason，是唯一把 cause 递到插件面前的通道。
 *  - `turn/end` 之后 inbox 已清（cancel 默认 keepInbox  false 时连排队输入一起丢），
 *    所以继续动作必须"另起一轮"，不能等原轮次自然继续。
 */

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

const NS = "auto-continue";

/**
 * 判定哪些 abort cause 算「异常中断」。
 * `user` 恒为正常（用户自己点的终止），默认不自动继续；父级/归档/dispose/未知
 * 都属于「不是用户主动停的」，交给 followup 续。
 */
const ABNORMAL_CAUSES = Object.freeze(["parent", "disposed", "legacy", "unknown"]);

/**
 * TurnEndReasonMap 全量（asar 逐字）：completed | aborted(cause) | blocked |
 * error(LlmFailure) | max-tokens | interrupted | forked。
 * 只认 aborted 太窄——实测日志里真实的「非正常中断」是另外三种：
 *   error       = 429/502 之类把轮次打死（本会话 turn 9/10 就是这个）
 *   interrupted = 上次进程崩在轮次中途、恢复时补的 turn closer
 *   max-tokens  = 输出被截断，任务没做完
 * completed / blocked(权限或 hook 拦下，续了也白续) / forked(用户分叉) 恒不动。
 */
const ABNORMAL_KINDS = Object.freeze(["error", "interrupted", "max-tokens"]);

/**
 * 重试额度的有效期。maxRetries 本意是「防 runaway」，不是把会话永久拉黑：
 * 计数只增不减的话，一个会话早上撞满 3 次（上游 429 抖动），下午再出真故障也不会被续，
 * 现象和「插件没装」一模一样，而日志里只留下一句 giving up。
 */
const ATTEMPT_WINDOW_MS = 30 * 60_000;

/**
 * 退避起点（毫秒），按异常类型分档。只在第 2 次起的重试上用（第 1 次立即发，
 * 见 handler）：429 场景下原地重撞是本插件唯一的实质成本，多烧的都是无效 LLM 调用。
 */
const BACKOFF_BASE_MS = Object.freeze({ error: 2000, "max-tokens": 500 });
/** 退避上限：撞到上限说明上游长时间不可用，靠 maxRetries 收口。 */
const BACKOFF_MAX_MS = 30_000;

/**
 * rules.prompt 的长度上限。误配超长文本时，每一轮续跑都会把它当 user message 重发一遍
 * （截断比拒绝好：用户至少能看出自己配的东西太长，而不是插件整体不工作）。
 */
const PROMPT_MAX_CHARS = 2000;

/** prompt 归一化：去首尾空白 → 空串回落默认值 → 超长截断。 */
function normalizePrompt(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  return trimmed.length > PROMPT_MAX_CHARS ? trimmed.slice(0, PROMPT_MAX_CHARS) : trimmed;
}

const Rules = z.object({
  enabled: z.boolean().default(true),
  causes: z.array(z.string()).default(ABNORMAL_CAUSES.slice()),
  kinds: z.array(z.string()).default(ABNORMAL_KINDS.slice()),
  prompt: z.string().default("继续"),
  maxRetries: z.number().default(3),
});

const Config = z.object({ rules: Rules.volatile() });

const DEFAULTS = Object.freeze({
  enabled: true,
  causes: ABNORMAL_CAUSES.slice(),
  kinds: ABNORMAL_KINDS.slice(),
  prompt: "继续",
  maxRetries: 3,
});

function unwrap(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const plain = {};
  for (const [key, value] of Object.entries(config)) plain[key] = unwrap(value);
  const rulesValue = plain.rules;
  if (rulesValue !== null && typeof rulesValue === "object" && !Array.isArray(rulesValue)) {
    const rules = {};
    for (const [key, value] of Object.entries(rulesValue)) rules[key] = unwrap(value);
    plain.rules = rules;
  }
  return plain;
}

function rulesOf(resolved) {
  const rules = { ...DEFAULTS, ...(resolved?.rules ?? {}) };
  const causes = Array.isArray(rules.causes) ? rules.causes.filter((x) => typeof x === "string") : [];
  const kinds = Array.isArray(rules.kinds) ? rules.kinds.filter((x) => typeof x === "string") : [];
  const maxRetries = Number.isFinite(Number(rules.maxRetries)) ? Math.max(0, Math.floor(Number(rules.maxRetries))) : 0;
  return {
    enabled: rules.enabled === true,
    causes: causes.length > 0 ? causes : ABNORMAL_CAUSES.slice(),
    kinds: kinds.length > 0 ? kinds : ABNORMAL_KINDS.slice(),
    prompt: normalizePrompt(rules.prompt, DEFAULTS.prompt),
    maxRetries,
  };
}

/** 与宿主 createUserMessage 同形状：role + content + source + id，再整体冻结。 */
function createUserMessage(text, source) {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source,
    }),
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

/** 与 dsh-model-proxy/lib/bridge.js:21 writeJson 一致：raw node http 应答。 */
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body));
}

const name = "auto-continue";
/**
 * 必需服务：agents。
 * ★ 关键：`ctx.agents` 只有在 inject 里声明过才可访问。本插件曾写 `inject = []`
 *   配 `ctx.agents?.get?.(sessionId)`，于是 ctx.agents 恒为 undefined，每次异常
 *   都在下面「no live agent」处 return——用户看到的就是「中断了没发继续」。
 *   实证（两个在役插件都先声明再用）：
 *     dsh-memory-evolve/lib/index.js:76  `export const inject = ['tools', …, 'agents', …]`
 *     dsh-prompt-optimizer/lib/index.js:112 `ctx.inject([…, "agents", …], (sctx) => …)`
 */
const inject = ["agents"];

function apply(ctx, config) {
  // ctx.logger 是宿主注入的，今天一定存在；兜一层是因为同款写法在 dsh-backup-migrator
  // 上炸过（apply 只传两参时第三参恒为 undefined → 未捕获抛错），且这里所有 warn 都在
  // 事件路径上，真出问题只会看到一条没头没尾的 warning。
  const logger = ctx.logger ?? console;
  /** agent 注册表：声明过 inject 后 ctx.get / ctx.agents 两路都通，任一可用即可。 */
  const agentsOf = () => ctx.get?.("agents") ?? ctx.agents;
  let warnedLongPrompt = false;
  const currentRules = () => {
    const resolved = resolveConfig(config);
    const raw = resolved?.rules?.prompt;
    // 只在真配了超长文本时提醒一次：这条最容易被忽略（插件照常工作，只是每轮多烧 token）。
    if (!warnedLongPrompt && typeof raw === "string" && raw.trim().length > PROMPT_MAX_CHARS) {
      warnedLongPrompt = true;
      logger.warn(`auto-continue: rules.prompt 超过 ${PROMPT_MAX_CHARS} 字符，已截断后使用`);
    }
    return rulesOf(resolved);
  };

  const state = { continued: 0, lastReason: undefined, lastSeen: undefined, lastSkip: undefined, seen: 0 };
  /** sessionId → 该会话已自动续过的次数（防 runaway，见 rules.maxRetries） */
  const attempts = new Map();
  /** sessionId → 上次续的时刻（判时间窗用；不暴露给 status，避免改动既有形状） */
  const attemptAt = new Map();

  /** 该会话当前额度内已续几次；超出时间窗即归零（额度不是永久拉黑）。 */
  function attemptCount(sessionId) {
    const used = attempts.get(sessionId) ?? 0;
    if (used === 0) return 0;
    if (Date.now() - (attemptAt.get(sessionId) ?? 0) > ATTEMPT_WINDOW_MS) {
      forgetAttempts(sessionId);
      return 0;
    }
    return used;
  }

  /** 记一次续跑：计数与时间戳分开存，status 里的 attempts 仍是 {sessionId: count}。 */
  function markAttempt(sessionId, count) {
    attempts.set(sessionId, count);
    attemptAt.set(sessionId, Date.now());
  }

  /** 清账：会话已恢复正常（收到 completed）或超出时间窗时调用。 */
  function forgetAttempts(sessionId) {
    attempts.delete(sessionId);
    attemptAt.delete(sessionId);
  }

  /** sessionId → 待发的退避定时器。dispose 必须清掉，否则卸载后还会补一句「继续」。 */
  const pending = new Map();

  /**
   * 退避时长：base * 2^(count-2)，±30% 抖动，上限 BACKOFF_MAX_MS。
   * count 从 2 起——第 1 次不退避（见 handler），插件的主要价值就是「立刻续」。
   */
  function backoffMs(kind, count) {
    const base = BACKOFF_BASE_MS[kind] ?? 1000;
    const grown = base * 2 ** Math.max(0, count - 2);
    const jittered = grown * (0.7 + Math.random() * 0.6);
    return Math.min(Math.round(jittered), BACKOFF_MAX_MS);
  }

  /** 投递 + 记账（立即路径与退避路径共用）；返回这条「继续」是否真的投出去了。 */
  function deliver(sessionId, turn, kind, count, agent) {
    const rules = currentRules();
    // 宿主 Agent 契约（asar 侧源码已核）：ctx.agents.get(id) 返回 Agent | undefined，
    // followup 是同步方法、返回 undefined（不是 Promise）——所以这里不会留悬空 rejection。
    // 反过来说：哪天它变成 async，这个 catch 就抓不到失败，必须改成显式 catch 的 Promise 链。
    try {
      agent.followup(
        createUserMessage(rules.prompt, {
          kind: "plugin",
          plugin: NS,
        }),
      );
    } catch (error) {
      state.lastSkip = { sessionId, turn, reason: `followup-failed: ${String(error)}` };
      logger.warn(`auto-continue: followup failed for session ${sessionId}: ${String(error)}`);
      return false;
    }
    // 投递成功才记账：抛错不烧掉重试额度（否则一次抖动就再也续不了这个会话）。
    markAttempt(sessionId, count);
    state.continued += 1;
    state.lastSkip = undefined;
    state.lastReason = { sessionId, turn, cause: kind, attempt: count };
    logger.info(
      `auto-continue: session ${sessionId} turn ${turn} ended (${kind}) → followup "${rules.prompt}" (${count}/${rules.maxRetries})`,
    );
    return true;
  }

  /** abort cause 里取 kind；不认识的结构按 unknown 处理。 */
  function causeKind(reason) {
    if (reason === null || typeof reason !== "object") return "unknown";
    const kind = reason.kind;
    return typeof kind === "string" && kind !== "" ? kind : "unknown";
  }

  /**
   * 判定一次轮次结束是否「异常中断、且该续」。
   * @param {string} sessionId 已由入口守门校验过的会话 id
   * @returns {{kind: string} | undefined}
   */
  function classify(sessionId, data) {
    const rules = currentRules();
    if (!rules.enabled) return undefined;
    const reason = data?.reason;
    if (reason === null || typeof reason !== "object") return undefined;
    let kind;
    if (reason.kind === "aborted") {
      kind = causeKind(reason.reason);
      if (!rules.causes.includes(kind)) return undefined;
    } else if (rules.kinds.includes(reason.kind)) {
      kind = reason.kind;
    } else {
      return undefined;
    }
    const used = attemptCount(sessionId);
    if (used >= rules.maxRetries) {
      logger.warn(`auto-continue: session ${sessionId} already resumed ${used} time(s), giving up`);
      return undefined;
    }
    return { kind };
  }

  // ── session/event：只有 turn/end 带完整 reason，是唯一的判定入口 ──────────
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    // 入口守门：宿主侧 session.header.id 一定存在（dsh-session/lib/index.js:1264/1269），
    // 但这里是事件派发路径，形状一旦变了不该只留一条看不出是谁抛的 warn。
    const sessionId = session?.header?.id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    state.seen += 1;
    state.lastSeen = { sessionId, turn: event.data?.turn, reason: event.data?.reason?.kind ?? null };
    // 正常收轮 = 这个会话缓过来了，额度归零；否则「上午用掉的 3 次」会一直压着下午真出的故障。
    if (event.data?.reason?.kind === "completed") forgetAttempts(sessionId);
    let verdict;
    try {
      verdict = classify(sessionId, event.data);
    } catch (error) {
      logger.warn(`auto-continue: classification failed: ${String(error)}`);
      return;
    }
    if (verdict === undefined) return;

    // 这个会话已经排了一个退避重试：不再排第二个（重复投递 = 多烧一轮 token + 两条「继续」）。
    if (pending.has(sessionId)) {
      state.lastSkip = { sessionId, turn: event.data.turn, reason: "already-scheduled" };
      logger.warn(`auto-continue: a retry is already queued for session ${sessionId}, skipping`);
      return;
    }

    const used = attemptCount(sessionId);
    // agent 可能还没注册（刚 abort 完、或已 dispose）：拿不到就不动，绝不起新 agent。
    // 拿不到的原因记进 status.lastSkip——否则「中断没续」永远只能靠猜。
    const agent = agentsOf()?.get?.(sessionId);
    if (agent === undefined || typeof agent.followup !== "function") {
      state.lastSkip = {
        sessionId,
        turn: event.data.turn,
        reason: agent === undefined ? "no-live-agent" : "agent-has-no-followup",
      };
      logger.warn(`auto-continue: no live agent for session ${sessionId}, nothing to resume`);
      return;
    }

    const count = used + 1;
    if (count === 1) {
      deliver(sessionId, event.data.turn, verdict.kind, count, agent);
      return;
    }

    // 第 2 次起才退避：原地重撞时每一轮都是无效 LLM 调用，是本插件唯一的实质成本。
    // 重试里必须重新取 agent——等这几秒的工夫会话可能已经被 dispose。
    const delay = backoffMs(verdict.kind, count);
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      // 定时器回调里抛错 = 悬空异常，宿主可能直接退出（本项目在 backup-migrator 上崩过机）。
      try {
        const live = agentsOf()?.get?.(sessionId);
        if (live === undefined || typeof live.followup !== "function") {
          state.lastSkip = { sessionId, turn: event.data.turn, reason: "no-live-agent-on-retry" };
          logger.warn(`auto-continue: no live agent for session ${sessionId} when retry #${count} fired`);
          return;
        }
        deliver(sessionId, event.data.turn, verdict.kind, count, live);
      } catch (error) {
        logger.warn(`auto-continue: deferred retry failed for session ${sessionId}: ${String(error)}`);
      }
    }, delay);
    pending.set(sessionId, timer);
    logger.info(`auto-continue: session ${sessionId} retry #${count} scheduled in ${delay}ms`);
  });

  // ── 状态查询面（供 cards / 调试） ────────────────────────────────────────
  // 路由契约照 dsh-model-proxy/lib/bridge.js:256 的实证形态：raw node http，
  // handler(req, res) 自己写 head/end；不是 fastify 的 reply.code().send()。
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const listener = sctx.webServer.register({
        kind: "exact",
        path: "/_auto-continue/status",
        handler: async (req, res) => {
          // 客户端可能没读完应答就断连（writeHead/end 抛错），而 handler 是 async——
          // 裸抛会变成未捕获 rejection（本项目对未捕获 rejection 的策略包含直接退出宿主）。
          try {
            if (req.method !== "GET") {
              // 405 也要把 body 读掉：keep-alive 连接里不 drain，请求体会一直堆在 socket 上。
              req.resume();
              writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "GET only" });
              return;
            }
            writeJson(res, 200, {
              active: currentRules().enabled,
              continued: state.continued,
              seen: state.seen,
              lastSeen: state.lastSeen ?? null,
              lastReason: state.lastReason ?? null,
              lastSkip: state.lastSkip ?? null,
              attempts: Object.fromEntries(attempts),
            });
          } catch (error) {
            logger.warn(`auto-continue: status request failed: ${String(error)}`);
          }
        },
      });
      return () => listener();
    }, "auto-continue: status route");
  });

  ctx.on("dispose", () => {
    // 先清定时器：卸载后还会补发一句「继续」是可见的 bug（也是退避机制唯一的副作用面）。
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    attempts.clear();
    attemptAt.clear();
  });
}

export { Config, Rules, apply, inject, name, rulesOf, resolveConfig, ABNORMAL_CAUSES };
export default { apply, inject, name, Config };

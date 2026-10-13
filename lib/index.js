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

const Rules = z.object({
  enabled: z.boolean().default(true),
  causes: z.array(z.string()).default(ABNORMAL_CAUSES.slice()),
  prompt: z.string().default("继续"),
  maxRetries: z.number().default(3),
});

const Config = z.object({ rules: Rules.volatile() });

const DEFAULTS = Object.freeze({
  enabled: true,
  causes: ABNORMAL_CAUSES.slice(),
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
  const maxRetries = Number.isFinite(Number(rules.maxRetries)) ? Math.max(0, Math.floor(Number(rules.maxRetries))) : 0;
  return {
    enabled: rules.enabled === true,
    causes: causes.length > 0 ? causes : ABNORMAL_CAUSES.slice(),
    prompt: typeof rules.prompt === "string" && rules.prompt.trim() !== "" ? rules.prompt : DEFAULTS.prompt,
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
const inject = [];

function apply(ctx, config) {
  const logger = ctx.logger;
  const currentRules = () => rulesOf(resolveConfig(config));

  const state = { continued: 0, lastReason: undefined };
  /** sessionId → 该会话已自动续过的次数（防 runaway，见 rules.maxRetries） */
  const attempts = new Map();

  /** abort cause 里取 kind；不认识的结构按 unknown 处理。 */
  function causeKind(reason) {
    if (reason === null || typeof reason !== "object") return "unknown";
    const kind = reason.kind;
    return typeof kind === "string" && kind !== "" ? kind : "unknown";
  }

  /**
   * 判定一次轮次结束是否「异常中断、且该续」。
   * @returns {{kind: string} | undefined}
   */
  function classify(session, data) {
    const rules = currentRules();
    if (!rules.enabled) return undefined;
    const reason = data?.reason;
    if (reason === null || typeof reason !== "object") return undefined;
    if (reason.kind !== "aborted") return undefined;
    const kind = causeKind(reason.reason);
    if (!rules.causes.includes(kind)) return undefined;
    const used = attempts.get(session.header.id) ?? 0;
    if (used >= rules.maxRetries) {
      logger.warn(`auto-continue: session ${session.header.id} already resumed ${used} time(s), giving up`);
      return undefined;
    }
    return { kind };
  }

  // ── session/event：只有 turn/end 带 abort cause，是唯一的判定入口 ──────────
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    let verdict;
    try {
      verdict = classify(session, event.data);
    } catch (error) {
      logger.warn(`auto-continue: classification failed: ${String(error)}`);
      return;
    }
    if (verdict === undefined) return;

    const sessionId = session.header.id;
    const used = attempts.get(sessionId) ?? 0;
    // agent 可能还没注册（刚 abort 完、或已 dispose）：拿不到就不动，绝不起新 agent
    const agent = ctx.agents?.get(sessionId);
    if (agent === undefined) {
      logger.warn(`auto-continue: no live agent for session ${sessionId}, nothing to resume`);
      return;
    }
    attempts.set(sessionId, used + 1);
    const rules = currentRules();
    agent.followup(
      createUserMessage(rules.prompt, {
        kind: "plugin",
        plugin: NS,
      }),
    );
    const count = used + 1;
    state.continued += 1;
    state.lastReason = { sessionId, turn: event.data.turn, cause: verdict.kind, attempt: count };
    logger.info(
      `auto-continue: session ${sessionId} turn ${event.data.turn} aborted (${verdict.kind}) → followup "${rules.prompt}" (${count}/${rules.maxRetries})`,
    );
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
          if (req.method !== "GET") {
            writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "GET only" });
            return;
          }
          writeJson(res, 200, {
            active: currentRules().enabled,
            continued: state.continued,
            lastReason: state.lastReason ?? null,
            attempts: Object.fromEntries(attempts),
          });
        },
      });
      return () => listener();
    }, "auto-continue: status route");
  });

  ctx.on("dispose", () => {
    attempts.clear();
  });
}

export { Config, Rules, apply, inject, name, rulesOf, resolveConfig, ABNORMAL_CAUSES };
export default { apply, inject, name, Config };

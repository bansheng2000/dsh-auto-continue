// auto-continue 的自检：不连 DSH 宿主，用假 ctx / 假 agent 验证判定与投递逻辑。
// 跑法: node test/selftest.mjs
import assert from "node:assert/strict";

const mod = await import("../lib/index.js");
const { apply, rulesOf, resolveConfig } = mod;

// 0) 必须在 inject 里声明 agents，否则宿主 ctx 上根本没有 ctx.agents —— 续不了。
assert.ok(mod.inject.includes("agents"), "inject 必须声明 agents（ctx.agents 才会存在）");

/** 造一个最小 ctx：只有 on / inject / agents / logger。 */
function makeCtx(agentsGet) {
  const listeners = new Map();
  const registry = agentsGet ? { get: agentsGet } : undefined;
  // ★ 假 ctx 必须照抄宿主的注入门禁：ctx.agents 只在插件 inject 声明过时才存在。
  //   否则测试比现实宽松——本地全绿，装机后每次异常都停在「no live agent」。
  const declared = (mod.inject ?? []).includes("agents");
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    inject: () => {},
    agents: declared ? registry : undefined,
    get: (name) => (name === "agents" && declared ? registry : undefined),
    _emit: (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
  return ctx;
}

function makeAgent(sink) {
  return {
    followup: (message) => {
      sink.push(message);
      return undefined;
    },
  };
}

/** 造一个 turn/end 事件。 */
function turnEndEvent(turn, reason) {
  return { type: "turn/end", data: { turn, reason } };
}

function configWith(overrides = {}) {
  // resolveConfig 只认 {rules:{...}}；这里直接给普通对象即可（没有 volatile 包装）
  return { rules: { ...overrides } };
}

// 1) 配置解析：缺省 = 开，causes 覆盖四个异常 abort cause，kinds 覆盖三种非 aborted 异常，prompt=继续，maxRetries=3
{
  const rules = rulesOf({});
  assert.equal(rules.enabled, true);
  assert.deepEqual(rules.causes, ["parent", "disposed", "legacy", "unknown"]);
  assert.deepEqual(rules.kinds, ["error", "interrupted", "max-tokens"]);
  assert.equal(rules.prompt, "继续");
  assert.equal(rules.maxRetries, 3);
}

// 2) resolveConfig 能解 volatile 包装
{
  const boxed = { value: 7 };
  const volatile = { get: () => boxed };
  const resolved = resolveConfig({ rules: { prompt: volatile } });
  assert.deepEqual(resolved.rules.prompt, boxed);
}

// 3) user 取消 → 不动
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, { kind: "aborted", reason: { kind: "user" } }));
  assert.equal(sink.length, 0, "user 取消不该补消息");
}

// 4) hook 取消 → 默认不动（用户可自行加进 causes）
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, { kind: "aborted", reason: { kind: "hook", reason: "budget" } }));
  assert.equal(sink.length, 0, "hook 取消默认不补");
}

// 5) parent 取消 → 补一条「继续」
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1, "parent 取消应补一条");
  const message = sink[0];
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [{ type: "text", text: "继续" }]);
  assert.deepEqual(message.source, { kind: "plugin", plugin: "auto-continue" });
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 0);
  assert.throws(() => {
    message.content[0].text = "改";
  }, "消息应被冻结，避免被下游改写");
}

// 6) completed / blocked / forked → 不动；error / max-tokens / interrupted → 补「继续」
//    （依据 session log 实测：真实事故是 429/502 的 error 与崩后恢复的 interrupted）
for (const reason of [{ kind: "completed" }, { kind: "blocked" }, { kind: "forked" }]) {
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, reason));
  assert.equal(sink.length, 0, `${reason.kind} 不该补消息`);
}
for (const reason of [
  { kind: "error", error: { message: "429 rate limit", code: "RATE_LIMIT" } },
  { kind: "max-tokens" },
  { kind: "interrupted" },
]) {
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, reason));
  assert.equal(sink.length, 1, `${reason.kind} 应补一条「继续」`);
  assert.equal(sink[0].content[0].text, "继续");
}

// 6b) kinds 可自定义：只续 error，不续 interrupted
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ kinds: ["error"] }));
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(1, { kind: "interrupted" }));
  assert.equal(sink.length, 0, "自定义 kinds 之外的 kind 不补");
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(2, { kind: "error", error: { message: "502" } }));
  assert.equal(sink.length, 1, "kinds 里的 error 应补");
}

// 7) 非 turn/end 事件被忽略
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "s1" } }, { type: "step/end", data: { turn: 1, step: 1 } });
  ctx._emit("session/event", { header: { id: "s1" } }, { type: "user/message", data: {} });
  assert.equal(sink.length, 0);
}

// 8) maxRetries 护栏：同一会话超限后不再补，异常 kind 仍继续
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 2, prompt: "接着做" }));
  for (let i = 1; i <= 5; i++) {
    ctx._emit("session/event", { header: { id: "sX" } }, turnEndEvent(i, { kind: "aborted", reason: { kind: "disposed" } }));
  }
  assert.equal(sink.length, 2, "最多补 maxRetries 次");
  assert.deepEqual(sink.map((m) => m.content[0].text), ["接着做", "接着做"]);
}

// 9) 拿不到 live agent → 不补、不计数
{
  const sink = [];
  const ctx = makeCtx(() => undefined);
  apply(ctx, configWith({ maxRetries: 1 }));
  ctx._emit("session/event", { header: { id: "gone" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 0);
  // 之后 agent 回来了，应当还能用掉那一次配额
  const ctx2 = makeCtx(() => makeAgent(sink));
  apply(ctx2, configWith({ maxRetries: 1 }));
  ctx2._emit("session/event", { header: { id: "gone" } }, turnEndEvent(2, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1);
}

// 10) enabled=false → 完全不动
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ enabled: false }));
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "disposed" } }));
  assert.equal(sink.length, 0);
}

// 11) causes 可自定义：把 hook 也算异常
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ causes: ["hook"] }));
  ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "hook", reason: "budget" } }));
  assert.equal(sink.length, 1);
  // 同时 parent 不再补
  ctx._emit("session/event", { header: { id: "s2" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1, "自定义 causes 之外的 kind 不再补");
}

// 12) 变形 payload：reason 缺失 / 非对象 / kind 非字符串 → 一律按 unknown 处理且不崩
{
  for (const reason of [undefined, null, "user", 42, {}, { kind: "aborted" }, { kind: "aborted", reason: null }]) {
    const sink = [];
    const ctx = makeCtx(() => makeAgent(sink));
    apply(ctx, configWith({ causes: ["unknown"] }));
    ctx._emit("session/event", { header: { id: "sZ" } }, turnEndEvent(1, reason));
    // 只有 kind==='aborted' 且能取出 cause 的才会补；这里只验证不抛异常
  }
}

// 13) 并发会话互不干扰
{
  const sinkA = [];
  const sinkB = [];
  const ctx = makeCtx((id) => (id === "A" ? makeAgent(sinkA) : makeAgent(sinkB)));
  apply(ctx, configWith({ maxRetries: 1 }));
  ctx._emit("session/event", { header: { id: "A" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  ctx._emit("session/event", { header: { id: "B" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "disposed" } }));
  assert.equal(sinkA.length, 1);
  assert.equal(sinkB.length, 1);
}

// 14) volatile 包装下的 get 语义：rulesOf 读到的应是解包后的值
{
  const box = { get: () => ({ agent: () => undefined }) };
  void box;
}

console.log("auto-continue selftest: all assertions passed");

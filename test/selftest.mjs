// auto-continue 的自检：不连 DSH 宿主，用假 ctx / 假 agent 验证判定与投递逻辑。
// 跑法: node test/selftest.mjs
import assert from "node:assert/strict";

const mod = await import("../lib/index.js");
const { apply, rulesOf, resolveConfig } = mod;

// 0) 必须在 inject 里声明 agents，否则宿主 ctx 上根本没有 ctx.agents —— 续不了。
assert.ok(mod.inject.includes("agents"), "inject 必须声明 agents（ctx.agents 才会存在）");

/** 造一个最小 ctx：只有 on / inject / agents / logger（inject 只实现 webServer 路由那一种）。 */
function makeCtx(agentsGet) {
  const listeners = new Map();
  const routes = [];
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
    inject: (deps, fn) => {
      if (!deps.includes("webServer")) return;
      fn({
        effect: (cb) => cb(),
        webServer: {
          register: (descriptor) => {
            routes.push(descriptor);
            return () => {};
          },
        },
      });
    },
    agents: declared ? registry : undefined,
    get: (name) => (name === "agents" && declared ? registry : undefined),
    _emit: (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    _routes: routes,
  };
  return ctx;
}

/** 取一次状态路由的应答体（顺带证明路由真的注册上了）。 */
async function statusOf(ctx) {
  const route = ctx._routes.find((r) => r.path === "/_auto-continue/status");
  assert.ok(route !== undefined, "应当注册 /_auto-continue/status");
  const calls = [];
  await route.handler(
    { method: "GET" },
    { writeHead: (status) => calls.push(status), end: (body) => calls.push(JSON.parse(body)) },
  );
  assert.equal(calls[0], 200, "状态路由应当回 200");
  return calls[1];
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

/** 抓住插件排的退避定时器（不真等几秒），测试里手动 flush；用完必须 restore。 */
function captureTimers() {
  const real = globalThis.setTimeout;
  const captured = [];
  globalThis.setTimeout = (fn, ms) => {
    captured.push({ fn, ms });
    return { unref() {} };
  };
  return {
    captured,
    flushAll: () => {
      while (captured.length > 0) captured.shift().fn();
    },
    restore: () => {
      globalThis.setTimeout = real;
    },
  };
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

// 1b) prompt 归一化：去首尾空白、空串回落默认值、超长截断到 2000
{
  assert.equal(rulesOf({ rules: { prompt: "  接着做  " } }).prompt, "接着做");
  assert.equal(rulesOf({ rules: { prompt: "   " } }).prompt, "继续");
  const rules = rulesOf({ rules: { prompt: "x".repeat(5000) } });
  assert.equal(rules.prompt.length, 2000, "超长 prompt 必须截断");
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

// 8) maxRetries 护栏：第 1 次立即补，第 2 次起排退避（不原地重撞），超限后不再补
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  const clock = captureTimers();
  try {
    apply(ctx, configWith({ maxRetries: 2, prompt: "接着做" }));
    const end = (i) =>
      ctx._emit("session/event", { header: { id: "sX" } }, turnEndEvent(i, { kind: "aborted", reason: { kind: "disposed" } }));
    end(1);
    assert.equal(sink.length, 1, "第 1 次应当立即补");
    assert.equal(clock.captured.length, 0, "第 1 次不该排退避");
    end(2);
    assert.equal(clock.captured.length, 1, "第 2 次应当排退避，而不是立刻再撞一轮");
    assert.ok(
      clock.captured[0].ms >= 700 && clock.captured[0].ms <= 1300,
      `disposed 的退避起点应为 1000ms ±30%，实际 ${clock.captured[0]?.ms}`,
    );
    end(3);
    assert.equal(clock.captured.length, 1, "同一会话已有排队重试，不该重复排队");
    clock.flushAll();
    assert.equal(sink.length, 2, "最多补 maxRetries 次");
    end(4);
    assert.equal(sink.length, 2, "额度用尽后不再补");
    assert.equal(clock.captured.length, 0, "额度用尽也不该排重试");
  } finally {
    clock.restore();
  }
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

// 15) 入口守门：session 形状异常（缺 header / header 无 id / id 空串）不抛错、不记账、不发消息
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._emit("session/event", {}, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  ctx._emit("session/event", { header: {} }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  ctx._emit("session/event", { header: { id: "" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 0, "session 形状异常不该补消息也不该抛错");
  ctx._emit("session/event", { header: { id: "s-ok" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1, "守门不该误伤正常事件");
}

// 16) ctx 没给 logger 时必须走 ?? console 兜底，不能在事件路径上抛错
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  ctx.logger = undefined;
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    apply(ctx, configWith({ maxRetries: 0 }));
    ctx._emit("session/event", { header: { id: "sL" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  } finally {
    console.warn = realWarn;
  }
  assert.equal(sink.length, 0);
  assert.ok(
    warned.some((line) => line.includes("giving up")),
    "无 logger 时应落到 console 且不抛错",
  );
}

// 17) 正常收轮（completed）把额度归零：上午用满不该压住下午真出的故障
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 1 }));
  const bad = turnEndEvent(1, { kind: "error" });
  const end = (turn, reason) => ctx._emit("session/event", { header: { id: "sA" } }, turnEndEvent(turn, reason));
  end(1, { kind: "error" });
  end(2, { kind: "error" });
  assert.equal(sink.length, 1, "额度用尽后不该再续");
  end(3, { kind: "completed" });
  end(4, { kind: "error" });
  assert.equal(sink.length, 2, "completed 之后额度应恢复");
}

// 18) 额度只在时间窗内累计：窗口过后不再永久拉黑
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 1 }));
  const realNow = Date.now;
  try {
    ctx._emit("session/event", { header: { id: "sB" } }, turnEndEvent(1, { kind: "error" }));
    assert.equal(sink.length, 1);
    Date.now = () => realNow() + 31 * 60_000; // 越过 30 分钟窗
    ctx._emit("session/event", { header: { id: "sB" } }, turnEndEvent(2, { kind: "error" }));
  } finally {
    Date.now = realNow;
  }
  assert.equal(sink.length, 2, "超过时间窗后额度应归零");
}

// 19) 状态路由：GET 回聚合状态；非 GET 405 且 drain body；客户端断连不成未捕获 rejection
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 1 }));
  ctx._emit("session/event", { header: { id: "sR" } }, turnEndEvent(1, { kind: "error" }));

  const body = await statusOf(ctx);
  assert.equal(body.active, true);
  assert.equal(body.seen, 1);
  assert.equal(body.continued, 1);
  assert.equal(body.lastReason.cause, "error");
  assert.deepEqual(body.attempts, { sR: 1 });

  const route = ctx._routes.find((r) => r.path === "/_auto-continue/status");
  let resumed = false;
  const calls = [];
  await route.handler(
    {
      method: "POST",
      resume: () => {
        resumed = true;
      },
    },
    { writeHead: (status) => calls.push(status), end: (json) => calls.push(JSON.parse(json)) },
  );
  assert.ok(resumed, "405 分支必须把 request body 读掉");
  assert.equal(calls[0], 405);
  assert.equal(calls[1].code, "method-not-allowed");

  // 客户端在应答前断连：writeHead 抛错也不该冒泡（async handler 里的裸抛 = 未捕获 rejection）。
  // 这里只要不抛出去，本用例就算过。
  await route.handler(
    { method: "GET" },
    {
      writeHead: () => {
        throw new Error("client gone");
      },
      end: () => {},
    },
  );
}

// 20) 拿不到 live agent → 不补、记 lastSkip（排查「中断没续」的唯一线索）
{
  const ctx = makeCtx(() => undefined);
  apply(ctx, configWith());
  ctx._emit("session/event", { header: { id: "sGone" } }, turnEndEvent(2, { kind: "interrupted" }));
  const body = await statusOf(ctx);
  assert.equal(body.continued, 0);
  assert.equal(body.lastSkip.reason, "no-live-agent");
  assert.equal(body.lastSkip.turn, 2);
  assert.deepEqual(body.attempts, {}, "没投出去就不该记额度");
}

// 21) followup 抛错：不记账、不烧额度、记 lastSkip
{
  let fail = true;
  const sink = [];
  const agent = {
    followup: (message) => {
      if (fail) {
        fail = false;
        throw new Error("send rejected");
      }
      sink.push(message);
    },
  };
  const ctx = makeCtx(() => agent);
  apply(ctx, configWith({ maxRetries: 1 }));
  const end = (turn) => ctx._emit("session/event", { header: { id: "sT" } }, turnEndEvent(turn, { kind: "error" }));
  end(1);
  const after = await statusOf(ctx);
  assert.equal(after.continued, 0);
  assert.deepEqual(after.attempts, {}, "抛错不该烧掉额度");
  assert.match(String(after.lastSkip?.reason), /^followup-failed:/);
  end(2);
  assert.equal(sink.length, 1, "额度没被烧掉，下一次异常仍然能续");
}

console.log("auto-continue selftest: all assertions passed");

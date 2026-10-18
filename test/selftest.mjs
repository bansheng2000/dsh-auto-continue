// auto-continue 的自检：不连 DSH 宿主，用假 ctx / 假 agent 验证判定与投递逻辑。
// 跑法: node test/selftest.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mod = await import("../lib/index.js");
const { apply, rulesOf, resolveConfig, PLUGIN_SOURCE } = mod;

// 0) 必须在 inject 里声明 agents，否则宿主 ctx 上根本没有 ctx.agents —— 续不了。
assert.ok(mod.inject.includes("agents"), "inject 必须声明 agents（ctx.agents 才会存在）");

/**
 * 测试统一接管 setTimeout / clearTimeout：插件现在的**每一次**投递都排在定时器里
 * （第 1 次是 0ms——turn/end 是在宿主的 append 派发栈里派发的，同步调 followup 会撞
 * 「session append cannot reenter while another append is being published」）。
 * flush() 手动推进；_emit 默认自动排空（要看栈内时态就置 ctx._noDrain = true）。
 */
function installTimerCapture() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const captured = [];
  const intervals = [];
  const cancelled = new Set();
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn, ms, unref() {} };
    captured.push(handle);
    return handle;
  };
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {} };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle !== undefined && handle !== null) cancelled.add(handle);
  };
  globalThis.clearInterval = (handle) => {
    if (handle !== undefined && handle !== null) cancelled.add(handle);
  };
  return {
    captured,
    intervals,
    /** 还没跑掉、也没被 clear 的定时器数（flush 用它判断「还会不会再排新的」）。 */
    pendingCount: () => captured.filter((handle) => !cancelled.has(handle)).length,
    /** 丢掉已被 clear 的句柄：它们跑不了，但会占着 captured 让「还剩几个」数不准。 */
    prune: () => {
      for (let i = captured.length - 1; i >= 0; i -= 1) if (cancelled.has(captured[i])) captured.splice(i, 1);
    },
    flushAll: () => {
      for (;;) {
        const index = captured.findIndex((h) => !cancelled.has(h));
        if (index === -1) return;
        const handle = captured.splice(index, 1)[0];
        handle.fn();
      }
    },
    /** 手动推一次节拍（setInterval 的回调），随后排空它排出来的投递。 */
    tickIntervals: () => {
      for (const handle of intervals) if (!cancelled.has(handle)) handle.fn();
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

const timers = installTimerCapture();
/** 排空微任务队列：投递失败后的重试要经过 await（sleepTracked）才排下一个定时器。 */
const drain = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
/**
 * 推进所有已排的定时器，直到彻底安静（含 await 之后才排出来的新定时器）。
 * 异步：v0.1.6 起投递是异步的（等 idle + 退避 sleep），一次同步 flushAll 追不上。
 * 注意它会连「等 idle 的上界 60s」这类定时器一起跑掉——要看中间态就自己跑 timers.captured 里的单个句柄。
 */
const flush = async () => {
  for (let i = 0; i < 64; i += 1) {
    timers.flushAll();
    await drain();
    if (timers.pendingCount() === 0) return;
  }
};
/** 推进一拍看门狗节拍，再排空它排出来的投递。 */
const tick = async () => {
  timers.tickIntervals();
  await flush();
};

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
    _noDrain: false,
    // 异步：v0.1.6 起投递要等 agent 空闲 / 走退避 sleep，调用方 await 才看得到结果。
    _emit: async (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
      // 观察者同步返回 = 宿主那一次 append 已经发布完 → 定时器里的投递才跑得动。
      if (!ctx._noDrain) await flush();
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
    { method: "GET", headers: { host: "127.0.0.1:19387" } },
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

// 定时器接管见上面的 installTimerCapture（全局唯一，flush() 推进）。
// 旧版本这里有个按用例临时 captureTimers()，现在所有投递都走定时器，改成全局接管。

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
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, { kind: "aborted", reason: { kind: "user" } }));
  assert.equal(sink.length, 0, "user 取消不该补消息");
}

// 4) hook 取消 → 默认不动（用户可自行加进 causes）
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, { kind: "aborted", reason: { kind: "hook", reason: "budget" } }));
  assert.equal(sink.length, 0, "hook 取消默认不补");
}

// 5) parent 取消 → 补一条「继续」
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1, "parent 取消应补一条");
  const message = sink[0];
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [{ type: "text", text: "继续" }]);
  // format v4：source.kind 由生产者自报，且不能是退役的裸 "plugin"。
  assert.deepEqual(message.source, { kind: "plugin:dsh-auto-continue" });
  assert.equal(message.source.plugin, undefined, "退役的并列 plugin 字段不得再出现");
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
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, reason));
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
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(3, reason));
  assert.equal(sink.length, 1, `${reason.kind} 应补一条「继续」`);
  assert.equal(sink[0].content[0].text, "继续");
}

// 6b) kinds 可自定义：只续 error，不续 interrupted
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ kinds: ["error"] }));
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(1, { kind: "interrupted" }));
  assert.equal(sink.length, 0, "自定义 kinds 之外的 kind 不补");
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(2, { kind: "error", error: { message: "502" } }));
  assert.equal(sink.length, 1, "kinds 里的 error 应补");
}

// 7) 非 turn/end 事件被忽略
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  await ctx._emit("session/event", { header: { id: "s1" } }, { type: "step/end", data: { turn: 1, step: 1 } });
  await ctx._emit("session/event", { header: { id: "s1" } }, { type: "user/message", data: {} });
  assert.equal(sink.length, 0);
}

// 8) maxRetries 护栏：投递一律先排进定时器（第 1 次 0ms），第 2 次起退避，超限后不再补
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 2, prompt: "接着做" }));
  ctx._noDrain = true; // 这一段要逐拍看定时器，不让 _emit 自动排空
  const end = async (i) =>
    await ctx._emit("session/event", { header: { id: "sX" } }, turnEndEvent(i, { kind: "aborted", reason: { kind: "disposed" } }));
  await end(1);
  assert.equal(sink.length, 0, "第 1 次也必须排进定时器：turn/end 还在 append 派发栈里");
  assert.equal(timers.captured.length, 1, "第 1 次应排一个投递");
  assert.equal(timers.captured[0].ms, 0, "第 1 次是 0ms（延后一拍，但不退避）");
  await flush();
  assert.equal(sink.length, 1, "flush 之后补一条");
  await end(2);
  assert.equal(timers.captured.length, 1, "第 2 次应当排退避，而不是立刻再撞一轮");
  assert.ok(
    timers.captured[0].ms >= 700 && timers.captured[0].ms <= 1300,
    "disposed 的退避起点应为 1000ms ±30%，实际 " + String(timers.captured[0]?.ms),
  );
  await end(3);
  assert.equal(timers.captured.length, 1, "同一会话已有排队重试，不该重复排队");
  await flush();
  assert.equal(sink.length, 2, "最多补 maxRetries 次");
  await end(4);
  assert.equal(sink.length, 2, "额度用尽后不再补");
  assert.equal(timers.captured.length, 0, "额度用尽也不该排重试");
  ctx._noDrain = false;
  assert.deepEqual(sink.map((m) => m.content[0].text), ["接着做", "接着做"]);
}

// 9) 拿不到 live agent → 不补、不计数
{
  const sink = [];
  const ctx = makeCtx(() => undefined);
  apply(ctx, configWith({ maxRetries: 1 }));
  await ctx._emit("session/event", { header: { id: "gone" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 0);
  // 之后 agent 回来了，应当还能用掉那一次配额
  const ctx2 = makeCtx(() => makeAgent(sink));
  apply(ctx2, configWith({ maxRetries: 1 }));
  await ctx2._emit("session/event", { header: { id: "gone" } }, turnEndEvent(2, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1);
}

// 10) enabled=false → 完全不动
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ enabled: false }));
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "disposed" } }));
  assert.equal(sink.length, 0);
}

// 11) causes 可自定义：把 hook 也算异常
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ causes: ["hook"] }));
  await ctx._emit("session/event", { header: { id: "s1" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "hook", reason: "budget" } }));
  assert.equal(sink.length, 1);
  // 同时 parent 不再补
  await ctx._emit("session/event", { header: { id: "s2" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 1, "自定义 causes 之外的 kind 不再补");
}

// 12) 变形 payload：reason 缺失 / 非对象 / kind 非字符串 → 一律按 unknown 处理且不崩
{
  for (const reason of [undefined, null, "user", 42, {}, { kind: "aborted" }, { kind: "aborted", reason: null }]) {
    const sink = [];
    const ctx = makeCtx(() => makeAgent(sink));
    apply(ctx, configWith({ causes: ["unknown"] }));
    await ctx._emit("session/event", { header: { id: "sZ" } }, turnEndEvent(1, reason));
    // 只有 kind==='aborted' 且能取出 cause 的才会补；这里只验证不抛异常
  }
}

// 13) 并发会话互不干扰
{
  const sinkA = [];
  const sinkB = [];
  const ctx = makeCtx((id) => (id === "A" ? makeAgent(sinkA) : makeAgent(sinkB)));
  apply(ctx, configWith({ maxRetries: 1 }));
  await ctx._emit("session/event", { header: { id: "A" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  await ctx._emit("session/event", { header: { id: "B" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "disposed" } }));
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
  await ctx._emit("session/event", {}, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  await ctx._emit("session/event", { header: {} }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  await ctx._emit("session/event", { header: { id: "" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 0, "session 形状异常不该补消息也不该抛错");
  await ctx._emit("session/event", { header: { id: "s-ok" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
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
    await ctx._emit("session/event", { header: { id: "sL" } }, turnEndEvent(1, { kind: "aborted", reason: { kind: "parent" } }));
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
  const end = async (turn, reason) => await ctx._emit("session/event", { header: { id: "sA" } }, turnEndEvent(turn, reason));
  await end(1, { kind: "error" });
  await end(2, { kind: "error" });
  assert.equal(sink.length, 1, "额度用尽后不该再续");
  await end(3, { kind: "completed" });
  await end(4, { kind: "error" });
  assert.equal(sink.length, 2, "completed 之后额度应恢复");
}

// 18) 额度只在时间窗内累计：窗口过后不再永久拉黑
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 1 }));
  const realNow = Date.now;
  try {
    await ctx._emit("session/event", { header: { id: "sB" } }, turnEndEvent(1, { kind: "error" }));
    assert.equal(sink.length, 1);
    Date.now = () => realNow() + 31 * 60_000; // 越过 30 分钟窗
    await ctx._emit("session/event", { header: { id: "sB" } }, turnEndEvent(2, { kind: "error" }));
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
  await ctx._emit("session/event", { header: { id: "sR" } }, turnEndEvent(1, { kind: "error" }));

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
      headers: { host: "127.0.0.1:19387" },
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
    { method: "GET", headers: { host: "127.0.0.1:19387" } },
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
  await ctx._emit("session/event", { header: { id: "sGone" } }, turnEndEvent(2, { kind: "interrupted" }));
  const body = await statusOf(ctx);
  assert.equal(body.continued, 0);
  assert.equal(body.lastSkip.reason, "no-live-agent");
  assert.equal(body.lastSkip.turn, 2);
  assert.deepEqual(body.attempts, {}, "没投出去就不该记额度");
}

// 21) 投递抛错：自动重试（不烧额度），重试成功后 lastSkip 清空
{
  let tries = 0;
  const sink = [];
  const agent = {
    followup: (message) => {
      tries += 1;
      if (tries === 1) throw new Error("send rejected");
      sink.push(message);
    },
  };
  const ctx = makeCtx(() => agent);
  apply(ctx, configWith({ maxRetries: 1 }));
  await ctx._emit("session/event", { header: { id: "sT" } }, turnEndEvent(1, { kind: "error" }));
  assert.equal(tries, 2, "第一次投递失败后应当自动重试");
  assert.equal(sink.length, 1, "重试应当把「继续」投出去");
  const after = await statusOf(ctx);
  assert.equal(after.continued, 1);
  assert.deepEqual(after.attempts, { sT: 1 }, "只算一次续跑额度");
  assert.equal(after.lastSkip, null, "重试成功后 lastSkip 应清空");
}

// 21b) 投递持续失败：重试有上界（= maxRetries）、始终不烧额度、保留最后一条 lastSkip
{
  let tries = 0;
  const ctx = makeCtx(() => ({
    followup: () => {
      tries += 1;
      throw new Error("boom");
    },
  }));
  apply(ctx, configWith({ maxRetries: 2 }));
  await ctx._emit("session/event", { header: { id: "sF" } }, turnEndEvent(1, { kind: "error" }));
  assert.equal(tries, 3, "1 次首发 + 2 次重试（上界与 maxRetries 同源）");
  const body = await statusOf(ctx);
  assert.equal(body.continued, 0);
  assert.deepEqual(body.attempts, {}, "失败始终不烧额度");
  assert.match(String(body.lastSkip?.reason), /^followup-failed:/);
}

// 22) cause 认不出来（abort 的 cause 缺失/形态不认识）只续 1 次；completed 后机会归还
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 3 }));
  const end = async (turn, reason) => await ctx._emit("session/event", { header: { id: "sU" } }, turnEndEvent(turn, reason));
  const noCause = { kind: "aborted", reason: null }; // causeKind → "unknown"
  await end(1, noCause);
  assert.equal(sink.length, 1, "认不出的 cause 先续 1 次（不静默漏掉真异常）");
  await end(2, noCause);
  assert.equal(sink.length, 1, "第二次不该再续");
  const body = await statusOf(ctx);
  assert.equal(body.lastSkip.reason, "unknown-cause-already-continued");
  await end(3, { kind: "completed" }); // 会话缓过来了 → 机会归还
  await end(4, noCause);
  assert.equal(sink.length, 2, "completed 之后机会应归还");

  // 已知 cause 不受这条限制：仍走 maxRetries（第 2 次起走退避，_emit 会自动排空定时器）
  await end(5, { kind: "error" }); // count=2 → 排退避
  await end(6, { kind: "error" }); // count=3 → 再排一次（上一次已排空，pending 已清）
  assert.equal(sink.length, 4, "已知 cause 仍按 maxRetries 续");
  assert.equal(sink.length, 4, "已知 cause 仍按 maxRetries 续");

  // 宿主以后新增的**有名字**的 cause 不在这条路上：它不在 causes 名单里 → 一次都不续（fail-closed）
  await end(7, { kind: "aborted", reason: { kind: "host-shutdown" } });
  assert.equal(sink.length, 4, "没登记过的具名 cause 不续（要续就把它加进 causes）");
}

// 23) 显式空数组 = 全禁（不再静默回落默认）；键不写才用默认名单
{
  assert.deepEqual(rulesOf({ rules: { kinds: [] } }).kinds, [], "显式 [] 就是全禁");
  assert.deepEqual(rulesOf({ rules: { causes: [] } }).causes, []);
  assert.deepEqual(rulesOf({ rules: {} }).kinds, ["error", "interrupted", "max-tokens"], "不写这个键才用默认");
  assert.deepEqual(rulesOf({ rules: { kinds: "error" } }).kinds, ["error", "interrupted", "max-tokens"], "类型写错回落默认");

  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ kinds: [], causes: [] }));
  await ctx._emit("session/event", { header: { id: "sN" } }, turnEndEvent(1, { kind: "error" }));
  await ctx._emit("session/event", { header: { id: "sN" } }, turnEndEvent(2, { kind: "aborted", reason: { kind: "parent" } }));
  assert.equal(sink.length, 0, "全禁时任何异常都不该续");
}

// 24) 状态路由只服务回环：隧道 / DNS rebinding 送来的 Host 一律 403（且 drain body）
{
  const ctx = makeCtx(() => makeAgent([]));
  apply(ctx, configWith());
  const route = ctx._routes.find((r) => r.path === "/_auto-continue/status");
  const call = async (host) => {
    const calls = [];
    let drained = false;
    await route.handler(
      { method: "GET", headers: host === undefined ? {} : { host }, resume: () => (drained = true) },
      { writeHead: (status) => calls.push(status), end: (json) => calls.push(JSON.parse(json)) },
    );
    return { status: calls[0], drained };
  };
  for (const host of ["abc123.dsh-market.com", "evil.example.com", "127.0.0.1.evil.com", undefined]) {
    const res = await call(host);
    assert.equal(res.status, 403, `Host=${String(host)} 应当 403`);
    assert.ok(res.drained, "403 也要把 request body 读掉");
  }
  assert.equal((await call("127.0.0.1:19387")).status, 200);
  assert.equal((await call("localhost")).status, 200);
  assert.equal((await call("[::1]:19387")).status, 200);
}

// 25) ★ 回归：投递必须逃出 session append 的派发栈
//     宿主在 Session.commit() 里同步派发 session/event（此刻 entry.appending 仍为 true），
//     此时任何 session.append（含 followup → send → inbox.splice）都会从 followup 抛出：
//       "session append cannot reenter while another append is being published"
//     旧代码直接在观察者里同步投递 → 真实宿主上 seen 一直涨、continued 永远是 0。
{
  const sink = [];
  let inDispatch = false;
  const agent = {
    followup: (message) => {
      if (inDispatch) throw new Error("session append cannot reenter while another append is being published");
      sink.push(message);
    },
  };
  const ctx = makeCtx(() => agent);
  apply(ctx, configWith({ maxRetries: 1 }));
  ctx._noDrain = true;
  inDispatch = true;
  try {
    await ctx._emit("session/event", { header: { id: "sBoom" } }, turnEndEvent(1, { kind: "error" }));
    assert.equal(sink.length, 0, "派发栈里绝不能投（会被宿主的 append 重入保护打回）");
    assert.equal(timers.captured.length, 1, "应当已排一次延后投递");
  } finally {
    inDispatch = false;
  }
  ctx._noDrain = false;
  await flush();
  assert.equal(sink.length, 1, "派发结束之后应当投出去");
  const body = await statusOf(ctx);
  assert.equal(body.continued, 1);
  assert.equal(body.lastSkip, null);
}

// 26) 卸载即清掉排队的投递：卸载后再补一句「继续」是可见的 bug
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  ctx._noDrain = true;
  await ctx._emit("session/event", { header: { id: "sD" } }, turnEndEvent(1, { kind: "error" }));
  assert.equal(timers.captured.length, 1, "应当已排一次投递");
  await ctx._emit("dispose");
  ctx._noDrain = false;
  await flush();
  assert.equal(sink.length, 0, "dispose 之后不该再投");
}

// 27) 看门狗默认关：轮次悬着（turn/start 之后没有 turn/end）也不补、连节拍都不建
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith());
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await ctx._emit("session/event", { header: { id: "sW" } }, { type: "turn/start", data: { turn: 1 } });
    now += 10 * 60_000;
    await tick();
    assert.equal(timers.intervals.length, 0, "默认关：连节拍都不该建");
    assert.equal(sink.length, 0, "默认关：轮次悬着也不补");
  } finally {
    Date.now = realNow;
  }
}

// 28) 看门狗打开：静默超时补一条；一轮只补一次；心跳免疫；额度用尽不再补
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, configWith({ maxRetries: 1, watchdogMinutes: 1 }));
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const start = async () =>
      await ctx._emit("session/event", { header: { id: "sW" } }, { type: "turn/start", data: { turn: 1 } });
    await start();
    assert.equal(timers.intervals.length, 1, "打开后才建节拍");
    await tick();
    assert.equal(sink.length, 0, "还没到超时线，不补");
    // 轮次里的任何事件都算「还活着」
    now += 30_000;
    await ctx._emit("session/event", { header: { id: "sW" } }, { type: "step/start", data: { step: 2 } });
    now += 30_000;
    await tick();
    assert.equal(sink.length, 0, "有心跳就不算静默");
    now += 61_000;
    await tick();
    assert.equal(sink.length, 1, "静默超时应当补一条");
    await tick();
    assert.equal(sink.length, 1, "同一轮只补一次（心跳已摘除）");
    const body = await statusOf(ctx);
    assert.deepEqual(body.attempts, { sW: 1 }, "看门狗补发也走同一份额度");
    assert.equal(body.watchdog.fires, 1);
    assert.equal(body.watchdog.watching, 0);
    assert.equal(body.watchdog.minutes, 1);
    // 新轮次重新武装，但额度已用尽 → 不再补
    await start();
    now += 61_000;
    await tick();
    assert.equal(sink.length, 1, "额度用尽后看门狗不再补");
    assert.equal((await statusOf(ctx)).lastSkip.reason, "watchdog-out-of-quota");
  } finally {
    Date.now = realNow;
  }
}

// 29) format v4 的 source 准入：退役形状被拒、PLUGIN_SOURCE 过准入、lib/ 里不得再有退役写法
{
  // 复刻宿主 @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:124-127 的 source()。
  const admits = (message) => {
    const value = message?.source;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (typeof value.kind !== "string" || value.kind.length === 0) return false;
    return value.kind !== "plugin";
  };
  assert.equal(admits({ source: { kind: "plugin", plugin: "auto-continue" } }), false, "退役的 plugin 包裹必须被拒");
  assert.equal(admits({ source: { kind: "" } }), false, "空 kind 必须被拒");
  assert.equal(admits({ source: "plugin" }), false, "非对象 source 必须被拒");
  assert.equal(admits({ source: PLUGIN_SOURCE }), true, "PLUGIN_SOURCE 必须过 v4 准入");
  assert.equal(PLUGIN_SOURCE.kind, "plugin:dsh-auto-continue", "插件 source 用 plugin:<包名>");
  assert.equal(Object.isFrozen(PLUGIN_SOURCE), true, "PLUGIN_SOURCE 应冻结");

  const raw = readFileSync(fileURLToPath(new URL("../lib/index.js", import.meta.url)), "utf8");
  // 先剥注释再扫：注释里为了讲清规则会引用退役写法，不剥会让断言假绿/假红。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/kind:\s*["']plugin["']\s*,/.test(code), false, "lib/ 里不得再写 { kind: \"plugin\", … }");
  assert.ok(/plugin:dsh-auto-continue/.test(code), "lib/ 里必须写明 plugin:<包名>");
}

// 1c) 设置页那两个顶层 volatile 字段：优先级、夹紧、缺省（顶层的设置页值盖过 rules 里的同名键）
{
  assert.equal(rulesOf({}).retryIntervalMs, 2000, "重试间隔缺省 2000ms");
  assert.equal(rulesOf({ retryIntervalMs: 5000 }).retryIntervalMs, 5000);
  assert.equal(rulesOf({ retryIntervalMs: 0 }).retryIntervalMs, 0, "0 = 立刻重试");
  assert.equal(rulesOf({ retryIntervalMs: 1e9 }).retryIntervalMs, 600000, "上限 10 分钟");
  assert.equal(rulesOf({ retryIntervalMs: -5 }).retryIntervalMs, 0, "负数夹到 0");
  assert.equal(rulesOf({ retryIntervalMs: "abc" }).retryIntervalMs, 2000, "非数值回落缺省");
  assert.equal(rulesOf({ rules: { maxRetries: 3 } }).maxRetries, 3, "老位置仍然生效");
  assert.equal(rulesOf({ rules: { maxRetries: 3 }, maxRetries: 5 }).maxRetries, 5, "设置页的值优先");
  assert.equal(rulesOf({ maxRetries: 999 }).maxRetries, 50, "上限 50");
  assert.equal(rulesOf(resolveConfig({ maxRetries: { get: () => 7 } })).maxRetries, 7, "volatile 包装由 resolveConfig 解包");
}

// 30) ★ 回归：投递前必须等 agent 空下来
//     宿主 wakeDriver() 在 phase 仍 running 且未被 abort 时**丢弃唤醒**，消息只排进 next-turn；
//     这一轮若从 blocked / 「本轮没有消息」两条提前 return 路径收尾，消息就永久滞留、
//     没人消费 —— agent 已 idle、会话却停在原地（用户看到的「卡住」）。
//     所以投递要等一拍空档：从 idle 投递，宿主才会新建 driver 去消费它。
{
  const sink = [];
  let status = "running";
  let release;
  const agent = {
    get status() {
      return status;
    },
    whenIdle: () => new Promise((resolve) => (release = resolve)),
    followup: (message) => sink.push(message),
  };
  const ctx = makeCtx(() => agent);
  apply(ctx, configWith({ maxRetries: 1 }));
  // 清掉前面用例可能留下的定时器（用例之间共享假定时器栈），否则下面数不清自己排了几个。
  await flush();
  timers.prune();
  assert.equal(timers.captured.length, 0, "用例开始前应无残留定时器");
  ctx._noDrain = true;
  await ctx._emit("session/event", { header: { id: "sIdle" } }, turnEndEvent(1, { kind: "error" }));
  assert.equal(timers.captured.length, 1, "应当已排一次投递");
  ctx._noDrain = false;
  // 手动只跑这一拍（不能用 flush：它会连「等 idle 上界 60s」的定时器一起跑掉）
  timers.captured.splice(0, 1)[0].fn();
  await drain();
  assert.equal(sink.length, 0, "agent 还在跑：先别投（投了也会被宿主丢弃唤醒）");
  status = "idle";
  release();
  await drain();
  assert.equal(sink.length, 1, "agent 空下来之后才投");
  assert.equal((await statusOf(ctx)).continued, 1);
}

// 31) 等不到 idle 也照投（上界 IDLE_WAIT_MS）：宁可晚一点，也不要丢掉这一轮
{
  const sink = [];
  const agent = {
    status: "running",
    whenIdle: () => new Promise(() => {}),
    followup: (message) => sink.push(message),
  };
  const ctx = makeCtx(() => agent);
  apply(ctx, configWith({ maxRetries: 1 }));
  // 清掉前面用例可能留下的定时器（用例之间共享假定时器栈），否则下面数不清自己排了几个。
  await flush();
  timers.prune();
  assert.equal(timers.captured.length, 0, "用例开始前应无残留定时器");
  ctx._noDrain = true;
  await ctx._emit("session/event", { header: { id: "sSlow" } }, turnEndEvent(1, { kind: "error" }));
  ctx._noDrain = false;
  timers.captured.splice(0, 1)[0].fn();
  await drain();
  assert.equal(sink.length, 0, "还没到上界：继续等");
  const idleTimer = timers.captured.find((handle) => handle.ms === 60000);
  assert.ok(idleTimer !== undefined, "应当有一个 60s 的等待上界定时器");
  idleTimer.fn();
  await drain();
  assert.equal(sink.length, 1, "上界到了就照投");
}

// 32) 重试间隔可配：退避起点 = retryIntervalMs × 类型系数（error 1×）× ±30%
{
  const sink = [];
  const ctx = makeCtx(() => makeAgent(sink));
  apply(ctx, { rules: { maxRetries: 2 }, retryIntervalMs: 8000 });
  // 清掉前面用例可能留下的定时器（用例之间共享假定时器栈），否则下面数不清自己排了几个。
  await flush();
  timers.prune();
  assert.equal(timers.captured.length, 0, "用例开始前应无残留定时器");
  ctx._noDrain = true;
  const end = async (turn) =>
    ctx._emit("session/event", { header: { id: "sInt" } }, turnEndEvent(turn, { kind: "error" }));
  await end(1);
  await flush();
  assert.equal(sink.length, 1, "第 1 次立即投");
  await end(2);
  const ms = timers.captured[0]?.ms;
  assert.ok(ms >= 5600 && ms <= 10400, "8000ms × 1 × 2^0 ±30%，实际 " + String(ms));
}

// 33) dispose 打断重试 sleep：醒来后不得再投一条
{
  let tries = 0;
  const ctx = makeCtx(() => ({
    followup: () => {
      tries += 1;
      throw new Error("boom");
    },
  }));
  apply(ctx, { rules: { maxRetries: 3 }, retryIntervalMs: 4000 });
  // 清掉前面用例可能留下的定时器（用例之间共享假定时器栈），否则下面数不清自己排了几个。
  await flush();
  timers.prune();
  assert.equal(timers.captured.length, 0, "用例开始前应无残留定时器");
  ctx._noDrain = true;
  await ctx._emit("session/event", { header: { id: "sDrain" } }, turnEndEvent(1, { kind: "error" }));
  ctx._noDrain = false;
  timers.captured.splice(0, 1)[0].fn();
  await drain();
  assert.equal(tries, 1, "第 1 次投递失败了");
  assert.equal(timers.pendingCount(), 1, "应当已排下一次重试");
  await ctx._emit("dispose");
  await flush();
  assert.equal(tries, 1, "dispose 之后不该再重试");
}

// 34) 状态路由报出生效的重试参数与来源（setting / rules / default）
{
  const ctx = makeCtx(() => makeAgent([]));
  apply(ctx, { rules: { maxRetries: 3 }, retryIntervalMs: 9000 });
  const body = await statusOf(ctx);
  assert.equal(body.retry.maxRetries, 3);
  assert.equal(body.retry.retryIntervalMs, 9000);
  assert.deepEqual(body.retry.sources, { maxRetries: "rules", retryIntervalMs: "setting" });

  const ctx2 = makeCtx(() => makeAgent([]));
  apply(ctx2, { rules: { maxRetries: 4 }, maxRetries: 6 });
  const body2 = await statusOf(ctx2);
  assert.equal(body2.retry.maxRetries, 6, "设置页的值优先");
  assert.equal(body2.retry.sources.maxRetries, "setting");

  const ctx3 = makeCtx(() => makeAgent([]));
  apply(ctx3, {});
  const body3 = await statusOf(ctx3);
  assert.deepEqual(body3.retry.sources, { maxRetries: "default", retryIntervalMs: "default" });
  assert.equal(body3.retry.maxRetries, 3, "缺省仍是 3 次");
  assert.equal(body3.retry.retryIntervalMs, 2000, "缺省仍是 2000ms");
}

console.log("auto-continue selftest: all assertions passed");


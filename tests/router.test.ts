// The rules that decide whether a keystroke costs money.

import { test } from "node:test";
import assert from "node:assert/strict";
import { route, classifyComplexity } from "../src/core/router/route.js";
import { Budget, MemorySpendStore } from "../src/core/router/budget.js";
import { costOf, makeLookup } from "../src/core/router/pricing.js";
import { estimateTokens } from "../src/core/util/tokens.js";

const cfg = {
  chat: { provider: "local" as const, model: "qwen2.5-coder:7b" },
  completion: { provider: "local" as const, model: "qwen2.5-coder:7b" },
  escalateTo: { provider: "openrouter" as const, model: "anthropic/claude-sonnet-4.5" },
  escalation: "ask" as const,
  localContextTokens: 32000,
};

test("completion never escalates, whatever the policy", () => {
  for (const escalation of ["never", "ask", "auto"] as const) {
    const r = route({ ...cfg, escalation }, { kind: "completion", promptTokens: 60000, prompt: "refactor the architecture" });
    assert.equal(r.provider, "local");
    assert.equal(r.suggestEscalation, undefined);
  }
});

test("chores and embeddings stay local too", () => {
  for (const kind of ["aux", "embed"] as const) {
    assert.equal(route(cfg, { kind, promptTokens: 500 }).provider, "local");
  }
});

test("an ordinary chat turn stays on the local model", () => {
  const r = route(cfg, { kind: "chat", prompt: "add a null check to this function", promptTokens: 800 });
  assert.equal(r.provider, "local");
  assert.equal(r.suggestEscalation, undefined);
});

test("a hard question is offered to the cloud, not sent to it", () => {
  const r = route(cfg, { kind: "chat", prompt: "why does this deadlock under load?", promptTokens: 900 });
  assert.equal(r.provider, "local", "the router does not spend on its own");
  assert.ok(r.suggestEscalation);
  assert.equal(r.suggestEscalation!.provider, "openrouter");
});

test("policy auto escalates, policy never refuses to", () => {
  const hard = { kind: "chat" as const, prompt: "root cause of this race condition?", promptTokens: 900 };
  assert.equal(route({ ...cfg, escalation: "auto" }, hard).provider, "openrouter");
  const never = route({ ...cfg, escalation: "never" }, hard);
  assert.equal(never.provider, "local");
  assert.equal(never.suggestEscalation, undefined);
});

test("context that does not fit the local window is itself a hard signal", () => {
  const c = classifyComplexity("tidy this up", 30000, 32000);
  assert.equal(c.level, "hard");
  assert.match(c.why, /window/);
});

test("the per-request cap stops one runaway prompt", () => {
  const b = new Budget(new MemorySpendStore(), { perRequestUsd: 0.25, dailyUsd: 2 });
  assert.equal(b.check(0.1).ok, true);
  const v = b.check(3);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "per-request");
});

test("the daily cap stops the sum of reasonable ones", () => {
  const b = new Budget(new MemorySpendStore(), { perRequestUsd: 1, dailyUsd: 1 }, () => "2026-08-21");
  for (let i = 0; i < 10; i++) b.record(0.09);
  assert.equal(b.spentToday().toFixed(2), "0.90");
  const v = b.check(0.2);
  assert.equal(v.ok === false && v.reason, "daily");
});

test("spending resets with the day", () => {
  let day = "2026-08-21";
  const b = new Budget(new MemorySpendStore(), { perRequestUsd: 1, dailyUsd: 1 }, () => day);
  b.record(0.9);
  day = "2026-08-22";
  assert.equal(b.spentToday(), 0);
  assert.equal(b.check(0.5).ok, true);
});

test("a provider's own cost figure always wins over the estimate", () => {
  const price = { in: 3, out: 15 };
  const c = costOf({ promptTokens: 1000, completionTokens: 1000, cachedTokens: 0, costUsd: 0.0042 }, price);
  assert.equal(c.usd, 0.0042);
  assert.equal(c.known, true);
});

test("an unknown model is reported as unknown, never guessed", () => {
  const c = costOf({ promptTokens: 1000, completionTokens: 100, cachedTokens: 0 }, undefined);
  assert.equal(c.known, false);
  assert.equal(c.usd, 0);
});

test("the prompt cache is where a coding conversation gets cheap", () => {
  const price = { in: 3, out: 15, cachedIn: 0.3 };
  const c = costOf({ promptTokens: 100000, completionTokens: 500, cachedTokens: 95000 }, price);
  assert.ok(c.usd < c.usdWithoutCache * 0.35, `cached call should be far cheaper (${c.usd} vs ${c.usdWithoutCache})`);
});

test("price lookup falls back from exact id to vendor wildcard", () => {
  const look = makeLookup({ "anthropic/claude-sonnet-4.5": { in: 3, out: 15 }, "openai/*": { in: 1, out: 4 } });
  assert.equal(look("anthropic/claude-sonnet-4.5")!.in, 3);
  assert.equal(look("openai/gpt-5-mini")!.in, 1);
  assert.equal(look("mistralai/whatever"), undefined);
});

test("token estimation stays above the truth for code", () => {
  // 4 chars/token is the prose ratio; code must estimate higher, never lower.
  const code = "const x = arr.filter((v) => v.id !== y.id).map((v) => ({ ...v, n: v.n + 1 }));";
  assert.ok(estimateTokens(code) > code.length / 4);
});

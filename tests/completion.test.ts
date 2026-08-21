// Inline completion: the loop that runs on every pause in typing. Its correctness is felt as
// "this editor is pleasant" and its cost discipline is felt at the end of the month.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCompletion, truncateToBalanced, isUseless } from "../src/core/completion/postprocess.js";
import { CompletionCache } from "../src/core/completion/cache.js";
import { buildFimPrompt, templateFor } from "../src/core/completion/fim.js";
import { complete, shouldSkip, type CompletionContext } from "../src/core/completion/engine.js";
import type { Provider, CompletionRequest } from "../src/core/providers/types.js";

function fakeProvider(answers: string[]): Provider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    id: "fake",
    baseUrl: "http://127.0.0.1:11434/v1",
    isLocal: true,
    calls,
    async chat() {
      throw new Error("not used");
    },
    async complete(req: CompletionRequest) {
      calls.push(req);
      return answers[Math.min(i++, answers.length - 1)] ?? "";
    },
    async listModels() {
      return [];
    },
  };
}

const ctx = (over: Partial<CompletionContext> = {}): CompletionContext => ({
  prefix: "function add(a, b) {\n  ",
  suffix: "\n}\n",
  linePrefix: "  ",
  lineSuffix: "",
  languageId: "javascript",
  ...over,
});

const settings = { model: "qwen2.5-coder:7b", maxTokens: 128, multiline: true, contextTokens: 2000, serverSideFim: true };

test("a markdown fence around the answer is removed", () => {
  const out = cleanCompletion("```js\nreturn a + b;\n```", { suffix: "\n}", multiline: true, linePrefix: "  " });
  assert.equal(out, "return a + b;");
});

test("the model re-typing the closing brace does not duplicate it", () => {
  const out = cleanCompletion("return a + b;\n}", { suffix: "\n}\n", multiline: true, linePrefix: "  " });
  assert.equal(out, "return a + b;");
});

test("indentation the editor already inserted is not repeated", () => {
  const out = cleanCompletion("    return 1;", { suffix: "", multiline: false, linePrefix: "    " });
  assert.equal(out, "return 1;");
});

test("single-line mode keeps one line", () => {
  const out = cleanCompletion("return a + b;\nconsole.log(a);", { suffix: "", multiline: false, linePrefix: "" });
  assert.equal(out, "return a + b;");
});

test("an unbalanced tail is cut rather than shipped", () => {
  assert.equal(truncateToBalanced("foo(bar) + baz("), "foo(bar) + baz");
  assert.equal(truncateToBalanced('const s = "unterminated'), "const s = ");
  assert.equal(truncateToBalanced("f({ a: [1, 2] })"), "f({ a: [1, 2] })");
});

test("a closer that belongs to the file ends the completion", () => {
  assert.equal(truncateToBalanced("return a;\n}\nfunction other() {"), "return a;\n");
});

test("whitespace and punctuation alone are not a suggestion", () => {
  assert.ok(isUseless("   "));
  assert.ok(isUseless(");"));
  assert.ok(!isUseless("return a + b;"));
});

test("no request is made in the middle of a word", () => {
  assert.match(shouldSkip(ctx({ linePrefix: "  cou", lineSuffix: "nt++;" }))!, /inside a word/);
});

test("no request is made when the line already holds code after the cursor", () => {
  assert.ok(shouldSkip(ctx({ lineSuffix: " + tax;" })));
  assert.equal(shouldSkip(ctx({ lineSuffix: ");" })), undefined, "closers after the cursor are normal");
});

test("typing through a suggestion serves the remainder without asking the model", async () => {
  const provider = fakeProvider(["return a + b;"]);
  const cache = new CompletionCache();
  const first = await complete(provider, cache, ctx(), settings);
  assert.equal(first.source, "model");
  assert.equal(first.completion, "return a + b;");

  const typed = await complete(provider, cache, ctx({ prefix: "function add(a, b) {\n  return a" }), settings);
  assert.equal(typed.source, "continuation");
  assert.equal(typed.completion, " + b;");
  assert.equal(provider.calls.length, 1, "no second request");
});

test("typing something else invalidates the suggestion and asks again", async () => {
  const provider = fakeProvider(["return a + b;", "return a * b;"]);
  const cache = new CompletionCache();
  await complete(provider, cache, ctx(), settings);
  const diverged = await complete(provider, cache, ctx({ prefix: "function add(a, b) {\n  const" }), settings);
  assert.equal(diverged.source, "model");
  assert.equal(provider.calls.length, 2);
});

test("the same context twice is one request", async () => {
  const provider = fakeProvider(["return a + b;"]);
  const cache = new CompletionCache();
  await complete(provider, cache, ctx(), settings);
  cache.forgetLast(); // rule out the continuation path
  const again = await complete(provider, cache, ctx(), settings);
  assert.equal(again.source, "cache");
  assert.equal(provider.calls.length, 1);
});

test("an empty answer is remembered too, so it is not asked twice", async () => {
  const provider = fakeProvider([""]);
  const cache = new CompletionCache();
  await complete(provider, cache, ctx(), settings);
  const again = await complete(provider, cache, ctx(), settings);
  assert.equal(again.reason, "known-empty");
  assert.equal(provider.calls.length, 1);
});

test("server-side FIM sends the halves apart, client-side templates them", async () => {
  const server = fakeProvider(["x"]);
  await complete(server, new CompletionCache(), ctx(), settings);
  assert.ok(server.calls[0]!.suffix.includes("}"), "the suffix travels as a field");

  const client = fakeProvider(["x"]);
  await complete(client, new CompletionCache(), ctx(), { ...settings, serverSideFim: false });
  assert.match(client.calls[0]!.prefix, /<\|fim_prefix\|>/);
  assert.equal(client.calls[0]!.suffix, "");
});

test("each model family gets its own FIM markers", () => {
  assert.match(buildFimPrompt("qwen2.5-coder:7b", "a", "b").prompt, /<\|fim_prefix\|>a<\|fim_suffix\|>b<\|fim_middle\|>/);
  assert.match(buildFimPrompt("deepseek-coder-v2", "a", "b").prompt, /fim/);
  assert.equal(templateFor("codellama:13b").prefix, "<PRE> ");
  // Codestral has no middle marker and reads suffix-first.
  assert.match(buildFimPrompt("codestral", "a", "b").prompt, /^\[SUFFIX\]b\[PREFIX\]a$/);
});

test("the cache evicts, so a long session cannot grow without bound", () => {
  const cache = new CompletionCache(3);
  for (let i = 0; i < 10; i++) cache.set("m", `prefix ${i}`, "", `c${i}`);
  assert.equal(cache.size, 3);
});

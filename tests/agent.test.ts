// The agent turn. These tests pin the contract the sidebar, the inline chat and the terminal
// client all depend on — above all, that nothing runs without permission and that a refusal is a
// conversation, not a crash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type Tool } from "../src/core/agent/loop.js";
import type { ChatRequest, ChatResult, Provider } from "../src/core/providers/types.js";

type Scripted = { text?: string; toolCalls?: Array<{ id: string; name: string; args: string }> };

function scriptedProvider(script: Scripted[]): Provider & { seen: ChatRequest[] } {
  let i = 0;
  const seen: ChatRequest[] = [];
  return {
    id: "fake",
    baseUrl: "http://127.0.0.1:11434/v1",
    isLocal: true,
    seen,
    async chat(req, onDelta): Promise<ChatResult> {
      seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const s = script[Math.min(i++, script.length - 1)] ?? {};
      if (s.text) onDelta?.({ text: s.text });
      return {
        text: s.text ?? "",
        reasoning: "",
        toolCalls: s.toolCalls ?? [],
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
        stopReason: s.toolCalls?.length ? "tool_calls" : "stop",
      };
    },
    async listModels() {
      return [];
    },
  };
}

function tool(name: string, opts: Partial<Tool> = {}): Tool & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    schema: { name, description: name, parameters: { type: "object", properties: {} } },
    approval: opts.approval ?? (() => false),
    run:
      opts.run ??
      (async (args) => {
        calls.push(args);
        return { content: `${name} ok` };
      }),
  } as Tool & { calls: Array<Record<string, unknown>> };
}

const base = { model: "m", messages: [{ role: "user" as const, content: "go" }] };

test("a turn without tool calls returns the answer", async () => {
  const provider = scriptedProvider([{ text: "here it is" }]);
  const r = await runTurn({ ...base, provider });
  assert.equal(r.text, "here it is");
  assert.equal(r.stoppedBecause, "answer");
  assert.equal(provider.seen.length, 1);
});

test("a tool call runs and its result comes back to the model", async () => {
  const readFile = tool("read_file");
  const provider = scriptedProvider([
    { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.ts"}' }] },
    { text: "the file defines add()" },
  ]);
  const r = await runTurn({ ...base, provider, tools: [readFile] });

  assert.deepEqual(readFile.calls[0], { path: "a.ts" });
  assert.equal(r.text, "the file defines add()");
  const second = provider.seen[1]!.messages;
  assert.equal(second[second.length - 1]!.role, "tool");
  assert.equal(second[second.length - 1]!.content, "read_file ok");
});

test("a dangerous tool does not run without approval", async () => {
  const run = tool("run_command", { approval: (a) => `run \`${a["cmd"]}\`` });
  const provider = scriptedProvider([
    { toolCalls: [{ id: "c1", name: "run_command", args: '{"cmd":"rm -rf /"}' }] },
    { text: "understood, I will not" },
  ]);
  const asked: string[] = [];
  const r = await runTurn({
    ...base,
    provider,
    tools: [run],
    approve: async (req) => {
      asked.push(req.description);
      return false;
    },
  });

  assert.deepEqual(asked, ["run `rm -rf /`"]);
  assert.equal(run.calls.length, 0, "the tool never ran");
  assert.equal(r.trace[0]!.approved, false);
  const told = provider.seen[1]!.messages.at(-1)!.content;
  assert.match(told, /declined/i, "the model is told, so it can offer something else");
  assert.equal(r.stoppedBecause, "answer");
});

test("with no approver at all, anything that needs approval is refused", async () => {
  const run = tool("run_command", { approval: () => "run something" });
  const provider = scriptedProvider([{ toolCalls: [{ id: "c1", name: "run_command", args: "{}" }] }, { text: "ok" }]);
  await runTurn({ ...base, provider, tools: [run] });
  assert.equal(run.calls.length, 0, "silence is not consent");
});

test("a tool that throws becomes an error result, not a failed turn", async () => {
  const broken = tool("read_file", {
    run: async () => {
      throw new Error("ENOENT");
    },
  });
  const provider = scriptedProvider([{ toolCalls: [{ id: "c1", name: "read_file", args: "{}" }] }, { text: "that file is gone" }]);
  const r = await runTurn({ ...base, provider, tools: [broken] });
  assert.match(provider.seen[1]!.messages.at(-1)!.content, /ENOENT/);
  assert.equal(r.text, "that file is gone");
});

test("malformed arguments are handed back to the model instead of crashing", async () => {
  const t = tool("read_file");
  const provider = scriptedProvider([{ toolCalls: [{ id: "c1", name: "read_file", args: "{not json" }] }, { text: "sorry" }]);
  await runTurn({ ...base, provider, tools: [t] });
  assert.match(provider.seen[1]!.messages.at(-1)!.content, /not valid JSON/);
  assert.equal(t.calls.length, 0);
});

test("an unknown tool is answered, never ignored", async () => {
  const provider = scriptedProvider([{ toolCalls: [{ id: "c1", name: "nope", args: "{}" }] }, { text: "ok" }]);
  await runTurn({ ...base, provider, tools: [] });
  const last = provider.seen[1]!.messages.at(-1)!;
  assert.equal(last.role, "tool");
  assert.match(last.content, /Unknown tool/);
});

test("every call gets exactly one result, even when several arrive at once", async () => {
  const a = tool("a");
  const b = tool("b");
  const provider = scriptedProvider([
    {
      toolCalls: [
        { id: "c1", name: "a", args: "{}" },
        { id: "c2", name: "b", args: "{}" },
      ],
    },
    { text: "done" },
  ]);
  await runTurn({ ...base, provider, tools: [a, b] });
  const results = provider.seen[1]!.messages.filter((m) => m.role === "tool");
  assert.deepEqual(results.map((r) => r.toolCallId), ["c1", "c2"]);
});

test("the step budget stops a loop that will not end", async () => {
  const t = tool("a");
  const provider = scriptedProvider([{ toolCalls: [{ id: "c", name: "a", args: "{}" }] }]);
  const r = await runTurn({ ...base, provider, tools: [t], maxSteps: 3 });
  assert.equal(r.stoppedBecause, "max-steps");
  assert.equal(t.calls.length, 3);
});

test("redaction happens on the way out and is undone on the way in", async () => {
  const provider = scriptedProvider([{ text: "the address ⟨EMAIL_1⟩ is invalid" }]);
  const r = await runTurn({
    provider,
    model: "m",
    messages: [{ role: "user", content: "check alice@corp.fr" }],
    beforeRequest: (msgs) => msgs.map((m) => ({ ...m, content: m.content.replace("alice@corp.fr", "⟨EMAIL_1⟩") })),
    afterResponse: (t) => t.replace("⟨EMAIL_1⟩", "alice@corp.fr"),
  });
  assert.equal(provider.seen[0]!.messages[0]!.content, "check ⟨EMAIL_1⟩", "the real address never left");
  assert.equal(r.text, "the address alice@corp.fr is invalid", "the user reads their own data");
});

test("a refusal in beforeRequest stops the turn instead of sending the original messages", async () => {
  // The rule this pins: when the gate says no — a secret the user would not release, a consent
  // dialog they closed — the safe path and the error path must not diverge. Falling back to the
  // unredacted messages would send the data precisely when the answer was "do not send it".
  const provider = scriptedProvider([{ text: "should never be reached" }]);
  await assert.rejects(
    () =>
      runTurn({
        ...base,
        provider,
        beforeRequest: () => {
          throw new Error("Envoi refusé");
        },
      }),
    /refusé/,
  );
  assert.equal(provider.seen.length, 0, "nothing was sent");
});

test("cancelling stops the turn between steps", async () => {
  const ctl = new AbortController();
  const t = tool("a", {
    run: async () => {
      ctl.abort();
      return { content: "ok" };
    },
  });
  const provider = scriptedProvider([{ toolCalls: [{ id: "c", name: "a", args: "{}" }] }]);
  const r = await runTurn({ ...base, provider, tools: [t], signal: ctl.signal, maxSteps: 5 });
  assert.equal(r.stoppedBecause, "cancelled");
  assert.equal(provider.seen.length, 1, "no request after the cancellation");
});

test("usage adds up across the steps of one turn", async () => {
  const t = tool("a");
  const provider = scriptedProvider([{ toolCalls: [{ id: "c", name: "a", args: "{}" }] }, { text: "done" }]);
  const r = await runTurn({ ...base, provider, tools: [t] });
  assert.equal(r.usage.promptTokens, 20);
  assert.equal(r.usage.completionTokens, 10);
});

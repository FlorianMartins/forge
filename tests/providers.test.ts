// Wire-format tests against a real HTTP server, because a mocked `fetch` proves only that the
// mock matches the code that calls it. A server that replays the exact frames Ollama, OpenRouter
// and Anthropic send catches the things that actually break: a tool call split across three
// chunks, usage arriving after the last token, an error frame in the middle of a stream.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../src/core/providers/openai.js";
import { AnthropicProvider } from "../src/core/providers/anthropic.js";
import { HttpError } from "../src/core/util/http.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ path: string; headers: NodeJS.Dict<string | string[]>; body: any }> }> {
  const requests: Array<{ path: string; headers: NodeJS.Dict<string | string[]>; body: any }> = [];
  // Sockets are tracked so `close()` can drop connections belonging to a request the server was
  // never going to answer — otherwise a timeout test hangs the whole suite on teardown.
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", headers: req.headers, body: body ? safeParse(body) : undefined });
      handler(req, res, body);
    });
  });
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => r());
      }),
  };
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function sse(res: ServerResponse, frames: unknown[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

test("an OpenAI-compatible stream becomes text, and usage is captured", async () => {
  const s = await serve((_req, res) =>
    sse(res, [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } } },
    ]),
  );
  const p = new OpenAICompatibleProvider({ id: "local", baseUrl: s.url, isLocal: true });
  const chunks: string[] = [];
  const r = await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, (d) => d.text && chunks.push(d.text));
  await s.close();

  assert.equal(r.text, "Hello world");
  assert.deepEqual(chunks, ["Hello", " world"], "text is streamed, not delivered at the end");
  assert.equal(r.usage.promptTokens, 12);
  assert.equal(r.usage.cachedTokens, 8);
});

test("a tool call split across chunks is reassembled by index", async () => {
  const s = await serve((_req, res) =>
    sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  );
  const p = new OpenAICompatibleProvider({ id: "local", baseUrl: s.url, isLocal: true });
  const r = await p.chat({ model: "m", messages: [{ role: "user", content: "read it" }] });
  await s.close();

  assert.equal(r.stopReason, "tool_calls");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, "read_file");
  assert.deepEqual(JSON.parse(r.toolCalls[0]!.args), { path: "a.ts" });
});

test("reasoning tokens are separated from the answer", async () => {
  const s = await serve((_req, res) =>
    sse(res, [
      { choices: [{ delta: { reasoning_content: "let me think" } }] },
      { choices: [{ delta: { content: "42" } }] },
    ]),
  );
  const p = new OpenAICompatibleProvider({ id: "local", baseUrl: s.url, isLocal: true });
  const r = await p.chat({ model: "m", messages: [{ role: "user", content: "?" }] });
  await s.close();
  assert.equal(r.text, "42");
  assert.equal(r.reasoning, "let me think");
});

test("attribution headers go to OpenRouter and nowhere else", async () => {
  const local = await serve((_req, res) => sse(res, [{ choices: [{ delta: { content: "x" } }] }]));
  await new OpenAICompatibleProvider({ id: "local", baseUrl: local.url, isLocal: true, referer: "r", title: "t" }).chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(local.requests[0]!.headers["http-referer"], undefined, "a local server must receive a simple request");
  await local.close();

  const or = await serve((_req, res) => sse(res, [{ choices: [{ delta: { content: "x" } }] }]));
  await new OpenAICompatibleProvider({ id: "openrouter", baseUrl: or.url, isLocal: false, apiKey: "k", referer: "r", title: "t" }).chat({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(or.requests[0]!.headers["http-referer"], "r");
  assert.equal(or.requests[0]!.headers["authorization"], "Bearer k");
  assert.equal(or.requests[0]!.body.usage.include, true, "ask OpenRouter for the real cost");
  await or.close();
});

test("an Ollama server on an unusual port is recognised by probing it, not by its URL", async () => {
  // The whole point: this server is on a random port and still gets the fill-in-the-middle path.
  const s = await serve((req, res) => {
    if (req.url === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.6.0" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ response: "return a + b;" }));
  });
  const ollama = new OpenAICompatibleProvider({ id: "local", baseUrl: s.url, isLocal: true });
  const out = await ollama.complete!({ model: "m", prefix: "function add(a,b){", suffix: "}", maxTokens: 32, stop: [] });
  const second = await ollama.complete!({ model: "m", prefix: "x", suffix: "y", maxTokens: 8, stop: [] });
  await s.close();

  assert.equal(out, "return a + b;");
  assert.equal(second, "return a + b;");
  const generate = s.requests.filter((r) => r.path === "/api/generate");
  assert.equal(generate.length, 2);
  assert.equal(generate[0]!.body.suffix, "}", "the suffix travels as a field, not as a template");
  assert.equal(generate[0]!.body.keep_alive, "30m", "the weights stay resident between keystrokes");
  assert.equal(s.requests.filter((r) => r.path === "/api/version").length, 1, "probed once, then remembered");
});

test("a remote endpoint is never probed", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ text: "x" }] }));
  });
  const remote = new OpenAICompatibleProvider({ id: "openai-compatible", baseUrl: s.url, isLocal: false, apiKey: "k" });
  await remote.complete!({ model: "m", prefix: "a", suffix: "b", maxTokens: 8, stop: [] });
  await s.close();
  assert.equal(s.requests.filter((r) => r.path.startsWith("/api/")).length, 0, "no unsolicited request to a third party");
});

test("an HTTP error is explained, not thrown raw", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No auth credentials found" } }));
  });
  const p = new OpenAICompatibleProvider({ id: "openrouter", baseUrl: s.url, isLocal: false });
  await assert.rejects(() => p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }), /401.*No auth credentials.*API key/s);
  await s.close();
});

test("a server that is not there names the fix", async () => {
  // A port nothing listens on: the connection is refused rather than merely slow.
  const p = new OpenAICompatibleProvider({ id: "local", baseUrl: "http://127.0.0.1:45387/v1", isLocal: true });
  await assert.rejects(
    () => p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    (e: HttpError) => /ollama serve|Cannot reach/i.test(e.message),
  );
});

test("a slow first byte is reported as a model load, not as `fetch failed`", async () => {
  const s = await serve(() => {
    /* never answers */
  });
  const p = new OpenAICompatibleProvider({ id: "local", baseUrl: s.url, isLocal: true, timeoutMs: 150 });
  await assert.rejects(
    () => p.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    /model loading|sent nothing within/i,
  );
  await s.close();
});

test("cancelling a request is not an error to report", async () => {
  const s = await serve(() => {});
  const p = new OpenAICompatibleProvider({ id: "local", baseUrl: s.url, isLocal: true });
  const ctl = new AbortController();
  const pending = p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], signal: ctl.signal });
  ctl.abort();
  await assert.rejects(() => pending, /cancelled/);
  await s.close();
});

test("Anthropic: the stable prefix is marked for the prompt cache", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const f of [
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 900 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", usage: { output_tokens: 5 }, delta: { stop_reason: "end_turn" } },
    ]) {
      res.write(`data: ${JSON.stringify(f)}\n\n`);
    }
    res.end();
  });
  const p = new AnthropicProvider({ baseUrl: s.url, apiKey: "k" });
  const r = await p.chat({
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "map", cacheable: true },
      { role: "user", content: "question" },
    ],
  });
  await s.close();

  const sent = s.requests[0]!.body;
  assert.equal(sent.system[0].cache_control.type, "ephemeral");
  assert.equal(sent.messages[0].content[0].cache_control.type, "ephemeral");
  assert.equal(sent.messages[1].content[0].cache_control, undefined, "the volatile tail must not break the cache");
  assert.equal(r.text, "ok");
  assert.equal(r.usage.cachedTokens, 900);
  assert.equal(r.usage.completionTokens, 5);
});

test("Anthropic: a tool call assembled from partial JSON", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const f of [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "write_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
    ]) {
      res.write(`data: ${JSON.stringify(f)}\n\n`);
    }
    res.end();
  });
  const p = new AnthropicProvider({ baseUrl: s.url, apiKey: "k" });
  const r = await p.chat({ model: "m", messages: [{ role: "user", content: "write it" }] });
  await s.close();
  assert.equal(r.stopReason, "tool_calls");
  assert.deepEqual(JSON.parse(r.toolCalls[0]!.args), { path: "a.ts" });
});

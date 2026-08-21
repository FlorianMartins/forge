// End-to-end tests for the terminal client, run against the BUILT bundle and a fake model server.
// They are the only tests that exercise the whole chain the way a user does — config, repository
// map, provider, streaming, redaction — and they are the reason the core can be trusted to work
// outside the editor rather than merely to compile outside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "forge.js");

interface Fake {
  url: string;
  bodies: any[];
  close(): Promise<void>;
}

async function fakeModel(reply: string[]): Promise<Fake> {
  const bodies: any[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push(body);
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const t of reply) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("close", (code) => resolve({ out, code }));
  });
}

async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-test-"));
  await writeFile(join(dir, "app.ts"), "export function computeInvoiceTotal(items: number[]) {\n  return items.length;\n}\n");
  return dir;
}

test("the terminal client answers a one-shot question and streams the reply", async () => {
  const fake = await fakeModel(["Bonjour", " depuis le terminal."]);
  const cwd = await scratchRepo();
  const { out, code } = await runCli(["dis bonjour"], { HIVEY_FORGE_URL: fake.url, HIVEY_FORGE_MODEL: "m" }, cwd);
  await fake.close();

  assert.equal(code, 0);
  assert.match(out, /Bonjour depuis le terminal\./);
  assert.match(out, /local \(coût nul\)/, "a loopback endpoint is announced as local");
});

test("the repository map is built from the real working directory and sent as a cacheable prefix", async () => {
  const fake = await fakeModel(["ok"]);
  const cwd = await scratchRepo();
  await runCli(["que fait ce code ?"], { HIVEY_FORGE_URL: fake.url, HIVEY_FORGE_MODEL: "m" }, cwd);
  await fake.close();

  const sent = JSON.stringify(fake.bodies[0]);
  assert.match(sent, /Repository map/);
  assert.match(sent, /computeInvoiceTotal/, "the map carries the symbols, not the file bodies");
  assert.ok(!sent.includes("return items.length"), "the body itself stayed on the machine");
});

test("a local endpoint is not redacted — the whole point of running one", async () => {
  const fake = await fakeModel(["ok"]);
  const cwd = await scratchRepo();
  await runCli(["contacte alice@corp.fr sur 10.0.0.9"], { HIVEY_FORGE_URL: fake.url, HIVEY_FORGE_MODEL: "m" }, cwd);
  await fake.close();
  const sent = JSON.stringify(fake.bodies[0]);
  assert.match(sent, /alice@corp\.fr/);
});

test("configuration comes from .hivey-forge.json in the working directory", async () => {
  const fake = await fakeModel(["ok"]);
  const cwd = await scratchRepo();
  await writeFile(join(cwd, ".hivey-forge.json"), JSON.stringify({ model: "modele-du-projet", baseUrl: fake.url }));
  const { out } = await runCli(["salut"], {}, cwd);
  await fake.close();

  assert.match(out, /modele-du-projet/, "the project's file decides the model");
  assert.equal(fake.bodies[0].model, "modele-du-projet");
});

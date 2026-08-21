// The rules that keep a credential out of someone else's log — and the ones that keep the
// assistant useful while doing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactMessages, isLocalEndpoint, Vault, entropy, DEFAULT_POLICY } from "../src/core/redaction/index.js";

const strict = { ...DEFAULT_POLICY };
const balanced = { ...DEFAULT_POLICY, level: "balanced" as const };
const off = { ...DEFAULT_POLICY, level: "off" as const };

test("vendor-shaped credentials are replaced and flagged", () => {
  const cases = [
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
    "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
  ];
  for (const secret of cases) {
    const r = redact(`const key = "${secret}";`, new Vault(), strict);
    assert.ok(r.hasSecret, `${secret} should be detected`);
    assert.ok(!r.text.includes(secret), `${secret} must not survive redaction`);
  }
});

test("a private key block is removed whole, not line by line", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----";
  const r = redact(`key = """${pem}"""`, new Vault(), strict);
  assert.ok(!r.text.includes("MIIEpAIBAAKCAQEA1234"));
  assert.equal(r.findings.filter((f) => f.rule === "private-key-block").length, 1);
});

test("credentials inside a connection string are removed but the shape stays readable", () => {
  const r = redact("DATABASE_URL=postgres://app:h7Fk29QeL@db.corp:5432/prod", new Vault(), strict);
  assert.ok(!r.text.includes("h7Fk29QeL"));
  assert.ok(r.text.includes("postgres://app:"), "the model still sees that this is a postgres URL");
});

test("a variable is not a secret", () => {
  // The single most common false positive: assignment rules that fire on code.
  const r = redact('password = os.environ["DB_PASSWORD"]\napi_key = process.env.KEY', new Vault(), strict);
  assert.equal(r.hasSecret, false);
  assert.ok(r.text.includes("os.environ"));
});

test("an assignment whose value is code, a type or a label is not a secret", () => {
  // Every line below was a false positive found by running this detector over its own repository.
  const code = [
    "const apiKey = cfg.apiKey;",
    "apiKey?: string;",
    'password = os.environ["PW"]',
    "secret: \"SECRET\",",
    "token: vscode.CancellationToken,",
    "auth = ANOTHER_CONSTANT",
    'apiKey: "${API_KEY}"',
    'password = "change-me"',
  ].join("\n");
  const r = redact(code, new Vault(), strict);
  assert.equal(r.hasSecret, false, `false positives: ${r.findings.map((f) => f.value).join(", ")}`);

  // …while a quoted literal that looks like a credential still is one.
  assert.equal(redact('password = "hT7-x92Kd0qLm4"', new Vault(), strict).hasSecret, true);
  assert.equal(redact("API_TOKEN=9f8d7a6b5c4e3f2a1b0c9d8e", new Vault(), strict).hasSecret, true);
});

test("a checksum is public by construction and is left alone", () => {
  const lock = '"integrity": "sha512-Xh3TgQXCLB8dLNK5cSXAsFVR2K0IXQ9v8ZzY2Vx1nMqLpJ7kR4tSbWc="';
  assert.equal(redact(lock, new Vault(), strict).hasSecret, false);
});

test("the same value always gets the same placeholder, a different value a different one", () => {
  const v = new Vault();
  const r = redact("write to alice@corp.fr and cc alice@corp.fr, not bob@corp.fr", v, strict);
  const ids = r.findings.map((f) => f.placeholder);
  assert.equal(ids[0], ids[1], "same address, same placeholder — the model can still reason");
  assert.notEqual(ids[0], ids[2]);
  assert.equal(v.restore(r.text), "write to alice@corp.fr and cc alice@corp.fr, not bob@corp.fr");
});

test("restore puts real values back into a model's answer", () => {
  const v = new Vault();
  const r = redact("deploy to build-07.corp with admin@corp.fr", v, strict);
  const modelAnswer = `Run: ssh ${r.findings[1]!.placeholder} and mail ${r.findings[0]!.placeholder}`;
  const restored = v.restore(modelAnswer);
  assert.ok(restored.includes("build-07.corp"));
  assert.ok(restored.includes("admin@corp.fr"));
});

test("levels decide what is hidden — and none of them lets a secret through", () => {
  const text = 'mail alice@corp.fr from 10.1.2.3, key "AKIAIOSFODNN7EXAMPLE"';
  const s = redact(text, new Vault(), strict);
  assert.ok(!s.text.includes("10.1.2.3") && !s.text.includes("alice@corp.fr"));

  const b = redact(text, new Vault(), balanced);
  assert.ok(b.text.includes("10.1.2.3"), "balanced keeps infrastructure");
  assert.ok(!b.text.includes("alice@corp.fr"));

  const o = redact(text, new Vault(), off);
  assert.ok(o.text.includes("alice@corp.fr"));
  assert.ok(!o.text.includes("AKIAIOSFODNN7EXAMPLE"), "off is a preference about privacy, never about credentials");
});

test("a user name in a path is hidden, a shared account name is noise", () => {
  const r = redact("/home/florian/projets/app and /home/runner/work/app", new Vault(), strict);
  assert.ok(!r.text.includes("florian"));
  assert.ok(r.text.includes("/home/runner"), "CI accounts identify nobody");
  assert.ok(r.text.includes("/projets/app"), "the useful part of the path survives");
});

test("high entropy is the safety net for credentials no rule knows", () => {
  const r = redact("token: Zx9Kq2Lm4Np7Rt5Vw8Yb1Dg3Hj6Kl0Qs", new Vault(), strict);
  assert.ok(r.hasSecret);
  // …and it must not eat ordinary long identifiers.
  const id = redact("const handleSubmitRegistrationFormEvent = 1", new Vault(), strict);
  assert.equal(id.hasSecret, false);
});

test("custom terms cover what no generic rule can know", () => {
  const p = { ...strict, customTerms: ["Novaris", "Projet Colibri"] };
  const r = redact("Novaris veut Projet Colibri pour mardi", new Vault(), p);
  assert.ok(!r.text.includes("Novaris") && !r.text.includes("Colibri"));
});

test("placeholder-shaped text in the input cannot hijack restore", () => {
  const v = new Vault();
  const r = redact("the user typed ⟨EMAIL_1⟩ then wrote real@corp.fr", v, strict);
  const restored = v.restore(r.text);
  assert.ok(restored.includes("<EMAIL_1>"), "the literal is neutralised, not resolved");
  assert.ok(restored.includes("real@corp.fr"));
});

test("overlapping matches never nest", () => {
  const r = redact('api_key = "alice@corp.fr"', new Vault(), strict);
  assert.equal(r.findings.length, 1, "one span wins the overlap");
  assert.ok(!/⟨[A-Z0-9]+_\d+⟩[^\s]*⟨/.test(r.text));
});

test("message arrays share one vault so the conversation stays coherent", () => {
  const v = new Vault();
  const { messages, hasSecret } = redactMessages(
    [
      { role: "user", content: "ping 10.0.0.7" },
      { role: "assistant", content: "10.0.0.7 is unreachable" },
    ],
    v,
    strict,
  );
  const a = messages[0]!.content.match(/⟨IP_\d+⟩/)![0];
  assert.ok(messages[1]!.content.includes(a));
  assert.equal(hasSecret, false);
});

test("what counts as local — the question that decides whether redaction runs at all", () => {
  for (const url of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://192.168.1.40:8000/v1", "https://llm.corp.internal/v1", "http://10.8.0.2/v1"]) {
    assert.ok(isLocalEndpoint(url), `${url} is local`);
  }
  for (const url of ["https://openrouter.ai/api/v1", "https://api.anthropic.com/v1", "https://api.openai.com/v1", "not a url"]) {
    assert.equal(isLocalEndpoint(url), false, `${url} is remote`);
  }
});

test("entropy separates prose from keys", () => {
  assert.ok(entropy("aaaaaaaaaaaa") < 1);
  assert.ok(entropy("Zx9Kq2Lm4Np7Rt5Vw8Yb1Dg3") > 3.6);
});

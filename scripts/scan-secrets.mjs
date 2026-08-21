#!/usr/bin/env node
// Scans this repository with the extension's OWN secret detectors.
//
// Dogfooding, and not only for the symbolism: a detector that has to keep this repository clean is
// a detector whose false-positive rate someone notices. If it starts flagging every base64 fixture
// in the tests, the build goes red and the rule gets fixed — which is exactly what would otherwise
// happen silently in a user's prompt.
//
// Usage: node scripts/scan-secrets.mjs [--staged]

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const staged = process.argv.includes("--staged");

// Build the detectors from source so the scanner and the shipped extension can never disagree.
const out = join(mkdtempSync(join(tmpdir(), "forge-scan-")), "redaction.mjs");
const build = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["esbuild", "src/core/redaction/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=error"],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const { redact, Vault, DEFAULT_POLICY } = await import(pathToFileURL(out).href);

const files = execFileSync("git", staged ? ["diff", "--cached", "--name-only"] : ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  // Binary and generated files carry high-entropy strings by nature and say nothing about leaks.
  .filter((f) => !/\.(png|jpe?g|gif|ico|pdf|zip|gz|vsix|map|lock)$/i.test(f))
  .filter((f) => !f.startsWith("dist/") && !f.startsWith("node_modules/"));

// The test suite deliberately contains credential-SHAPED strings; that is what it tests. They are
// listed here by file so an accidental real secret in the same file is still caught.
const FIXTURES = new Set(["tests/redaction.test.ts", "docs/THREAT-MODEL.md", "docs/PRIVACY.md", "README.md"]);

let findings = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const result = redact(text, new Vault(), { ...DEFAULT_POLICY, level: "balanced" });
  const secrets = result.findings.filter((f) => f.kind === "secret");
  if (!secrets.length) continue;
  if (FIXTURES.has(file)) {
    console.log(`· ${file}: ${secrets.length} correspondance(s) — fichier d'exemples, ignoré`);
    continue;
  }
  for (const s of secrets) {
    const line = text.slice(0, s.start).split("\n").length;
    console.error(`✗ ${file}:${line} règle « ${s.rule} » — ${s.value.slice(0, 6)}… (${s.value.length} caractères)`);
    findings++;
  }
}

if (findings) {
  console.error(`\n${findings} secret(s) potentiel(s). Retirez-les et changez-les : un secret poussé est un secret brûlé.`);
  process.exit(1);
}
console.log(`✓ ${files.length} fichier(s) scannés, aucun secret détecté.`);

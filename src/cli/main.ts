#!/usr/bin/env node
// `forge` — the terminal client. Same core as the extension: same providers, same redaction, same
// budget, same agent loop, same rule that nothing is written or run without a yes.
//
// It exists because half the work of a coding assistant happens where the editor is not: over ssh,
// in a container, in a repository you opened for ten minutes. And because a terminal client is the
// honest test of whether the core really is editor-agnostic — if something only works in the
// sidebar, it was in the wrong place.
//
// Configuration comes from `.forge.json` (working directory, then home) and from the
// environment, so a team can commit a shared configuration without committing a key.

import { createInterface, type Interface } from "node:readline/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { runTurn } from "../core/agent/loop.js";
import { makeProvider, type ProviderId } from "../core/providers/index.js";
import { isLocalEndpoint, redactMessages, Vault } from "../core/redaction/index.js";
import type { RedactionLevel } from "../core/redaction/types.js";
import { Budget, type Spend, type SpendStore } from "../core/router/budget.js";
import { costOf, makeLookup } from "../core/router/pricing.js";
import { GENERATED_PRICES } from "../core/router/catalog.generated.js";
import { Session } from "../core/session/session.js";
import { buildRepoMap } from "../core/context/repomap.js";
import { buildCliTools } from "./tools.js";
import { promptForMode, toolsForMode, MODES, type Mode } from "../core/session/modes.js";
import { t } from "../shared/i18n.js";

interface CliConfig {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
  redaction: RedactionLevel;
  customTerms: string[];
  blockedGlobs: string[];
  budget: { perRequestUsd: number; dailyUsd: number };
  contextTokens: number;
  /** Which mode the client starts in — the same three the sidebar offers. */
  mode: Mode;
}

const DEFAULTS: CliConfig = {
  provider: "local",
  model: process.env["FORGE_MODEL"] ?? "qwen2.5-coder:7b",
  baseUrl: process.env["FORGE_URL"] ?? "http://127.0.0.1:11434/v1",
  redaction: "strict",
  customTerms: [],
  blockedGlobs: ["**/.env*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/secrets/**", "**/.aws/**", "**/.ssh/**"],
  budget: { perRequestUsd: 0.25, dailyUsd: 2 },
  contextTokens: 8000,
  mode: "agent",
};

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function loadConfig(cwd: string): Promise<CliConfig> {
  const merged: CliConfig = { ...DEFAULTS };
  for (const path of [join(homedir(), ".forge.json"), join(cwd, ".forge.json")]) {
    try {
      Object.assign(merged, JSON.parse(await readFile(path, "utf8")));
    } catch {
      /* absent or unreadable: defaults stand */
    }
  }
  return merged;
}

class FileSpendStore implements SpendStore {
  private cache: Spend | undefined;
  constructor(private readonly path: string) {}
  load(): void {
    try {
      this.cache = JSON.parse(require("node:fs").readFileSync(this.path, "utf8")) as Spend;
    } catch {
      this.cache = undefined;
    }
  }
  read(): Spend | undefined {
    return this.cache;
  }
  write(s: Spend): void {
    this.cache = s;
    void mkdir(dirname(this.path), { recursive: true })
      .then(() => writeFile(this.path, JSON.stringify(s), "utf8"))
      .catch(() => {});
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const cfg = await loadConfig(cwd);
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : process.env["FORGE_KEY"];
  const isLocal = isLocalEndpoint(cfg.baseUrl);
  const provider = makeProvider({ id: cfg.provider, baseUrl: cfg.baseUrl, apiKey });

  const store = new FileSpendStore(join(homedir(), ".forge", "spend.json"));
  store.load();
  const budget = new Budget(store, cfg.budget);
  const prices = makeLookup(GENERATED_PRICES);
  const session = new Session();
  let mode: Mode = cfg.mode;

  const rl: Interface = createInterface({ input: stdin, output: stdout });

  console.log(C.bold("Forge") + C.dim(t(" — sovereign coding assistant")));
  console.log(
    C.dim(
      `${cfg.model} · ${new URL(cfg.baseUrl).host} · ${t("mode")} ${cfg.mode} · ${
        isLocal ? C.green(t("local (no cost)")) : C.amber(t("remote, redaction {0}", cfg.redaction))
      }`,
    ),
  );
  console.log(C.dim(t("/help for the commands, Ctrl+C to quit.") + "\n"));

  const oneOff = process.argv.slice(2).join(" ").trim();
  if (oneOff) {
    await ask(oneOff);
    rl.close();
    return;
  }

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(C.amber("› "))).trim();
    } catch {
      break; // Ctrl+C / EOF
    }
    if (!line) continue;
    if (line.startsWith("/")) {
      if (await command(line)) break;
      continue;
    }
    await ask(line);
  }
  rl.close();

  // ── Commands ──────────────────────────────────────────────────────────────────────────────

  async function command(line: string): Promise<boolean> {
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (name) {
      case "aide":
      case "help":
        console.log(
          [
            t("/new             start an empty conversation"),
            t("/context         what the next question will send"),
            t("/mute <n>        take exchange n out of the context (it stays on screen)"),
            t("/unmute <n>      put it back"),
            t("/forget <n>      delete it for good"),
            t("/mode <name>     chat (no tools), plan (read-only), agent (tools)"),
            t("/model <name>    switch model"),
            t("/cost            today's spend"),
            t("/quit"),
          ].join("\n"),
        );
        return false;
      case "new":
      case "nouveau":
        session.entries.length = 0;
        console.log(C.dim(t("empty conversation.")));
        return false;
      case "context":
      case "contexte": {
        session.entries.forEach((e, i) => {
          const flag = e.included ? " " : C.dim(t("muted"));
          console.log(`${String(i).padStart(2)} ${e.role === "user" ? t("you") : t("forge")} ${flag} ${e.text.slice(0, 70).replace(/\n/g, " ")}`);
        });
        return false;
      }
      // Command words are what the user TYPES, so both languages are accepted and neither is
      // translated: a `case` label that moves with the interface language is a command nobody can
      // rely on.
      case "mute":
      case "unmute":
      case "muet":
      case "rendre": {
        const entry = session.entries[Number(arg)];
        if (!entry) {
          console.log(C.red(t("unknown number (see /context)")));
          return false;
        }
        const putBack = name === "rendre" || name === "unmute";
        session.setIncluded(entry.id, putBack);
        console.log(
          C.dim(putBack ? t("exchange {0} put back into the context.", arg) : t("exchange {0} removed from the context.", arg)),
        );
        return false;
      }
      case "forget":
      case "oublier": {
        const entry = session.entries[Number(arg)];
        if (entry) session.drop(entry.id);
        return false;
      }
      case "mode": {
        const wanted = MODES.find((m) => m.id === arg);
        if (wanted) mode = wanted.id;
        const current = MODES.find((m) => m.id === mode)!;
        console.log(C.dim(t("mode {0} — {1}", current.id, current.hint)));
        if (!wanted) console.log(C.dim(t("(modes: {0})", MODES.map((m) => m.id).join(", "))));
        return false;
      }
      case "model":
      case "modele":
        if (arg) cfg.model = arg;
        console.log(C.dim(t("model: {0}", cfg.model)));
        return false;
      case "cost":
      case "cout":
        console.log(
          isLocal
            ? C.green(t("local: nothing spent, by construction."))
            : t("today: ${0} of {1} · {2} call(s)", budget.spentToday().toFixed(4), cfg.budget.dailyUsd, budget.callsToday()),
        );
        return false;
      case "quit":
      case "quitter":
      case "exit":
        return true;
      default:
        console.log(C.red(t("unknown command: /{0}", String(name))));
        return false;
    }
  }

  // ── One turn ──────────────────────────────────────────────────────────────────────────────

  async function ask(text: string): Promise<void> {
    session.add({ role: "user", text });
    const vault = new Vault();
    const ctl = new AbortController();
    const onSigint = () => ctl.abort();
    process.on("SIGINT", onSigint);

    // Chat mode answers from what it is given: no repository map, no tools, no surprises.
    const ambient = mode === "chat" ? undefined : await repoMap(cwd, Math.floor(cfg.contextTokens * 0.35));
    const built = session.build({
      systemPrompt: promptForMode(mode),
      ambient,
      maxTokens: cfg.contextTokens,
      nonce: randomNonce(),
    });

    let outgoing = built.messages;
    if (!isLocal) {
      const { messages, findings, hasSecret } = redactMessages(built.messages, vault, {
        level: cfg.redaction,
        customTerms: cfg.customTerms,
        blockOnSecret: true,
      });
      outgoing = messages;
      if (findings.length) {
        console.log(C.dim(t("pseudonymised: {0}", vault.summary().map((s) => `${s.label}×${s.count}`).join(", "))));
      }
      if (hasSecret) {
        const ok = (await rl.question(C.red(t("A credential was detected and masked. Send anyway? [y/N] ")))).toLowerCase();
        if (ok !== "y" && ok !== "o" && ok !== "yes" && ok !== "oui") {
          console.log(C.dim(t("cancelled.")));
          process.off("SIGINT", onSigint);
          return;
        }
      }
      const price = prices(cfg.model);
      const estimate = price ? (built.estimatedTokens * price.in * 1.25) / 1_000_000 : 0;
      const verdict = budget.check(estimate);
      if (!verdict.ok) {
        console.log(C.red(t("budget: {0}", verdict.message)));
        process.off("SIGINT", onSigint);
        return;
      }
    }

    // The mode decides the tool set in code: plan mode simply has no tool that writes.
    const tools = toolsForMode(
      buildCliTools({ cwd, blockedGlobs: cfg.blockedGlobs, showDiff: (path, before, after) => printDiff(path, before, after) }),
      mode,
    );

    let printed = false;
    try {
      const result = await runTurn({
        provider,
        model: cfg.model,
        messages: outgoing,
        tools,
        signal: ctl.signal,
        maxTokens: 4096,
        onDelta: (d) => {
          if (d.text) {
            stdout.write(vault.restore(d.text));
            printed = true;
          }
        },
        report: (m) => console.log(C.dim(`  ${m}`)),
        approve: async (req) => {
          const answer = (await rl.question(`\n${C.amber("?")} ${req.description} — ${t("allow? [y/N]")} `)).toLowerCase();
          return answer === "y" || answer === "o" || answer === "yes" || answer === "oui";
        },
        afterResponse: (t) => vault.restore(t),
      });
      if (printed) stdout.write("\n");

      const answer = session.add({ role: "assistant", text: result.text, model: cfg.model });
      if (!isLocal) {
        const cost = costOf(result.usage, prices(cfg.model));
        answer.usdCost = cost.usd;
        budget.record(cost.usd);
        console.log(
          C.dim(
            t("  {0}+{1} tokens", result.usage.promptTokens, result.usage.completionTokens) +
              (cost.known ? ` · $${cost.usd.toFixed(4)}` : ` · ${t("unknown cost")}`),
          ),
        );
      }
      if (result.stoppedBecause === "max-steps") console.log(C.amber(t("  (stopped at the maximum number of steps)")));
    } catch (err) {
      console.log(C.red(`\n${(err as Error).message}`));
    } finally {
      process.off("SIGINT", onSigint);
    }
  }
}

async function repoMap(cwd: string, budgetTokens: number): Promise<string | undefined> {
  const { readdir, readFile: rf, stat: st } = await import("node:fs/promises");
  const files: Array<{ path: string; text: string }> = [];
  const skip = new Set([".git", "node_modules", "dist", "build", "out", "target", ".venv", "__pycache__", ".next"]);
  async function walk(dir: string): Promise<void> {
    if (files.length > 800) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        try {
          if ((await st(full)).size > 200_000) continue;
          files.push({ path: full.slice(cwd.length + 1).split("\\").join("/"), text: await rf(full, "utf8") });
        } catch {
          /* unreadable */
        }
      }
    }
  }
  await walk(cwd);
  if (!files.length) return undefined;
  return buildRepoMap(files, budgetTokens).text;
}

/** A line diff, enough to see what is about to change. No dependency, no colours beyond two. */
function printDiff(path: string, before: string, after: string): void {
  console.log(C.bold(`\n  ${path}`));
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  for (const line of a.slice(start, endA + 1).slice(0, 40)) console.log(C.red(`  - ${line}`));
  for (const line of b.slice(start, endB + 1).slice(0, 40)) console.log(C.green(`  + ${line}`));
  console.log("");
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? require("node:crypto").webcrypto).getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

void main();

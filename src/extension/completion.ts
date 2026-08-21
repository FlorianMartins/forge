// Inline completion: the part of the extension the user never asks for and always notices.
//
// The whole design is about NOT making requests. VS Code calls an inline provider on every
// keystroke, on every cursor move, and again when it re-renders; forwarding that to a model would
// be both slow and, on a paid endpoint, absurd. So between the editor and the model there is:
// a debounce, a cancellation token wired to the abort signal, the skip rules (mid-word, before
// existing code), the typed-through cache, and finally the request — which on the default
// configuration goes to a model running on the same machine and costs nothing at all.

import * as vscode from "vscode";
import { complete, type CompletionContext as CoreCtx } from "../core/completion/engine.js";
import { redact, Vault } from "../core/redaction/index.js";
import { CompletionCache } from "../core/completion/cache.js";
import { isOllama, type Provider } from "../core/providers/index.js";
import { EgressGate } from "./egress.js";
import { providerFor, readSettings, redactionPolicy, type Settings } from "./config.js";
import type { Keys } from "./config.js";
import { relative } from "./workspace.js";

// Enough context to be useful, small enough to stay fast. Completion latency is the feature.
const CONTEXT_TOKENS = 1600;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new CompletionCache();
  private provider?: Provider;
  private providerKey = "";
  private inFlight?: AbortController;
  private accepted = 0;
  private requested = 0;

  constructor(
    private readonly keys: Keys,
    private readonly status: vscode.StatusBarItem,
    private readonly log: vscode.OutputChannel,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = readSettings(document.uri);
    const policy = redactionPolicy(settings);
    if (!settings.completion.enabled || settings.completion.provider === "off") return undefined;
    if (document.uri.scheme === "output" || document.uri.scheme === "vscode-scm") return undefined;

    // A file the operator declared off-limits is not completed either: the prefix would travel.
    const rel = relative(document.uri);
    const remoteCompletion = settings.completion.provider !== "local";
    if (remoteCompletion && EgressGate.isBlocked(rel, settings.privacy.blockedGlobs)) {
      this.log.appendLine(`[completion] skipped ${rel}: excluded by privacy policy`);
      return undefined;
    }

    // Debounce. The editor asks constantly; the model should not.
    if (!(await sleepUnlessCancelled(settings.completion.debounceMs, token))) return undefined;

    const offset = document.offsetAt(position);
    const text = document.getText();
    const line = document.lineAt(position.line);
    const ctx: CoreCtx = {
      prefix: text.slice(0, offset),
      suffix: text.slice(offset),
      linePrefix: line.text.slice(0, position.character),
      lineSuffix: line.text.slice(position.character),
      languageId: document.languageId,
      related: this.neighbours(document),
    };

    this.inFlight?.abort();
    const ctl = new AbortController();
    this.inFlight = ctl;
    token.onCancellationRequested(() => ctl.abort());

    try {
      const provider = await this.resolveProvider(settings);
      const t0 = Date.now();

      // A remote completion sends the code around the cursor, which is exactly the material the
      // privacy policy is about. It goes through the same redaction as everything else, and the
      // placeholders are resolved again before the suggestion reaches the editor — so the user
      // sees their own identifiers, and the provider never did.
      const vault = new Vault();
      const sent: CoreCtx = provider.isLocal
        ? ctx
        : {
            ...ctx,
            prefix: redact(ctx.prefix, vault, policy).text,
            suffix: redact(ctx.suffix, vault, policy).text,
            related: ctx.related?.map((r) => ({ path: r.path, body: redact(r.body, vault, policy).text })),
          };

      const outcome = await complete(
        provider,
        this.cache,
        sent,
        {
          model: settings.completion.model,
          maxTokens: settings.completion.maxTokens,
          multiline: settings.completion.multiline,
          contextTokens: CONTEXT_TOKENS,
          // Ollama and llama.cpp apply the model's own FIM template server-side; that is always
          // more accurate than the table of markers we keep for everyone else.
          serverSideFim: isOllama(provider.baseUrl),
        },
        ctl.signal,
      );
      if (token.isCancellationRequested || !outcome.completion) return undefined;
      const suggestion = provider.isLocal ? outcome.completion : vault.restore(outcome.completion);

      if (outcome.source === "model") {
        this.requested++;
        this.log.appendLine(`[completion] ${rel} ${Date.now() - t0}ms ~${outcome.requestTokens ?? 0} tokens`);
      }
      this.updateStatus(settings);

      return [
        new vscode.InlineCompletionItem(
          suggestion,
          new vscode.Range(position, position),
          // Counting acceptances is the only telemetry here, it stays on this machine, and it is
          // what tells a team whether a small local model is good enough for them.
          { command: "hiveyForge.completionAccepted", title: "", arguments: [] },
        ),
      ];
    } catch (err) {
      if (ctl.signal.aborted || token.isCancellationRequested) return undefined;
      const message = (err as Error).message;
      this.log.appendLine(`[completion] ${message}`);
      this.status.text = "$(warning) Forge";
      this.status.tooltip = `Complétion indisponible : ${message}`;
      return undefined;
    }
  }

  /** Open files other than this one, cropped: the cheapest cross-file signal there is. */
  private neighbours(document: vscode.TextDocument): Array<{ path: string; body: string }> {
    return vscode.window.visibleTextEditors
      .map((e) => e.document)
      .filter((d) => d.uri.toString() !== document.uri.toString() && d.languageId === document.languageId)
      .slice(0, 2)
      .map((d) => ({ path: relative(d.uri), body: d.getText().slice(0, 1200) }));
  }

  private async resolveProvider(settings: Settings): Promise<Provider> {
    const id = settings.completion.provider === "off" ? "local" : settings.completion.provider;
    const key = `${id}|${settings.endpoints[id]}`;
    if (!this.provider || this.providerKey !== key) {
      this.provider = await providerFor(settings, this.keys, id);
      this.providerKey = key;
      void this.warm(settings);
    }
    return this.provider;
  }

  /** Load the weights before the user types, not while they wait. */
  private async warm(settings: Settings): Promise<void> {
    const p = this.provider as (Provider & { warmup?: (m: string) => Promise<void> }) | undefined;
    if (!p?.warmup) return;
    this.status.text = "$(loading~spin) Forge";
    this.status.tooltip = "Chargement du modèle local…";
    await p.warmup(settings.completion.model);
    this.updateStatus(settings);
  }

  noteAccepted(): void {
    this.accepted++;
  }

  updateStatus(settings: Settings): void {
    const on = settings.completion.enabled && settings.completion.provider !== "off";
    const local = settings.completion.provider === "local";
    this.status.text = on ? `$(sparkle) Forge${local ? "" : " ☁"}` : "$(circle-slash) Forge";
    this.status.tooltip = new vscode.MarkdownString(
      [
        `**Hivey Forge** — complétion ${on ? "active" : "désactivée"}`,
        "",
        `Modèle : \`${settings.completion.model}\` (${local ? "local, coût nul" : "distant"})`,
        `Suggestions demandées cette session : ${this.requested} · acceptées : ${this.accepted}`,
        "",
        "Cliquer pour activer ou désactiver.",
      ].join("\n"),
    );
    this.status.command = "hiveyForge.toggleCompletions";
    this.status.show();
  }

  invalidateProvider(): void {
    this.provider = undefined;
    this.providerKey = "";
  }
}

async function sleepUnlessCancelled(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  if (ms <= 0) return !token.isCancellationRequested;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!token.isCancellationRequested), ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

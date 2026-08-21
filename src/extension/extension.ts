// Activation. Everything the extension can do is registered here and nowhere else, so the list of
// its capabilities is one file long and a reviewer can read it in a minute.

import * as vscode from "vscode";
import { setLanguage, t } from "../shared/i18n.js";
import { Budget } from "../core/router/budget.js";
import { isLocalEndpoint } from "../core/redaction/index.js";
import { ChatViewProvider, PreviewProvider } from "./chat.js";
import { ForgeCodeActions } from "./codeActions.js";
import { InlineCompletionProvider } from "./completion.js";
import { Keys, endpointFor, providerFor, readSettings, SECTION } from "./config.js";
import { EgressGate, WorkspaceSpendStore, safeHost } from "./egress.js";
import { registerEditorCommands } from "./editorCommands.js";
import { showEgressReport, showCostReport } from "./reports.js";
import { WorkspaceContext } from "./workspace.js";

export function activate(context: vscode.ExtensionContext): void {
  // The editor knows which language the user reads, unless they said otherwise.
  const applyLanguage = () => {
    const choice = readSettings().language;
    setLanguage(choice === "auto" ? vscode.env.language : choice);
  };
  applyLanguage();
  const log = vscode.window.createOutputChannel("Forge");
  const keys = new Keys(context.secrets);
  const disposables: vscode.Disposable[] = [];
  const workspace = new WorkspaceContext(disposables);
  const budget = new Budget(new WorkspaceSpendStore(context.globalState), readSettings().budget);
  const gate = new EgressGate(context.globalState, budget);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const completion = new InlineCompletionProvider(keys, status, log);
  completion.updateStatus(readSettings());

  const chat = new ChatViewProvider(context, keys, workspace, gate, log);

  context.subscriptions.push(
    log,
    status,
    ...disposables,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, completion),
    vscode.workspace.registerTextDocumentContentProvider("forge-preview", new PreviewProvider()),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      if (e.affectsConfiguration(`${SECTION}.language`)) {
        applyLanguage();
        // The panel's strings were built in the old language; rebuilding its HTML reloads it.
        chat.reload();
      }
      const s = readSettings();
      budget.setLimits(s.budget);
      completion.invalidateProvider();
      completion.updateStatus(s);
    }),

    vscode.commands.registerCommand("forge.newSession", () => chat.newSession()),
    vscode.commands.registerCommand("forge.completionAccepted", () => completion.noteAccepted()),

    vscode.commands.registerCommand("forge.toggleCompletions", async () => {
      const config = vscode.workspace.getConfiguration(SECTION);
      const next = !config.get<boolean>("completion.enabled", true);
      await config.update("completion.enabled", next, vscode.ConfigurationTarget.Global);
      completion.updateStatus(readSettings());
    }),

    vscode.commands.registerCommand("forge.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "openrouter", detail: t("Multi-model gateway") },
          { label: "anthropic", detail: t("Claude API") },
          { label: "openai-compatible", detail: t("Internal gateway, Azure, LiteLLM…") },
          { label: "local", detail: t("A local server that requires a key (rare)") },
        ],
        { placeHolder: t("Which provider?") },
      );
      if (!provider) return;
      const key = await vscode.window.showInputBox({
        prompt: t("Key for {0}. It is stored in the system keychain, never in the settings.", provider.label),
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      await keys.store(provider.label as never, key);
      completion.invalidateProvider();
      void vscode.window.showInformationMessage(t("Forge: {0} key stored in the keychain.", provider.label));
    }),

    vscode.commands.registerCommand("forge.clearApiKey", async () => {
      const provider = await vscode.window.showQuickPick(["openrouter", "anthropic", "openai-compatible", "local"], {
        placeHolder: t("Which key to clear?"),
      });
      if (!provider) return;
      await keys.delete(provider as never);
      completion.invalidateProvider();
      void vscode.window.showInformationMessage(t("{0} key cleared.", provider));
    }),

    // The chat model is chosen in the panel, where prices can be compared side by side; this
    // command survives for muscle memory and opens that screen.
    vscode.commands.registerCommand("forge.pickModel", () => chat.show("models")),

    // The completion model is a different decision — it is asked on every pause in typing — and a
    // quick pick over what the endpoint actually serves is the right shape for it.
    vscode.commands.registerCommand("forge.pickCompletionModel", async () => {
      const s = readSettings();
      const id = s.completion.provider === "off" ? "local" : s.completion.provider;
      let models: string[] = [];
      try {
        const provider = await providerFor(s, keys, id);
        models = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t("Forge: models served by {0}…", id) },
          () => provider.listModels(),
        );
      } catch (err) {
        void vscode.window.showErrorMessage(t("Cannot list the models: {0}", (err as Error).message));
        return;
      }
      const picked = await vscode.window.showQuickPick(models, {
        placeHolder: t("Inline completion model — a code model that supports fill-in-the-middle"),
      });
      if (!picked) return;
      await vscode.workspace.getConfiguration(SECTION).update("completion.model", picked, vscode.ConfigurationTarget.Workspace);
      completion.invalidateProvider();
      completion.updateStatus(readSettings());
    }),

    vscode.commands.registerCommand("forge.showHistory", () => chat.show("history")),
    vscode.commands.registerCommand("forge.showModels", () => chat.show("models")),
    vscode.commands.registerCommand("forge.showPermissions", () => chat.show("permissions")),
    vscode.commands.registerCommand("forge.showEgress", () => showEgressReport(gate, readSettings())),
    vscode.commands.registerCommand("forge.showCosts", () => showCostReport(gate, readSettings())),

    vscode.commands.registerCommand("forge.indexWorkspace", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("Forge: mapping the repository…") },
        async () => {
          workspace.invalidate();
          const map = await workspace.repoMap(readSettings().context.maxTokens, true);
          void vscode.window.showInformationMessage(
            map
              ? t("Repository map: {0} files, {1} omitted (token budget).", map.files, map.omitted)
              : t("No folder is open."),
          );
        },
      );
    }),
  );

  registerEditorCommands(context, { chat, keys, workspace, log, extensionUri: context.extensionUri });

  // Quick fixes are registered for every file: the diagnostics come from whichever language server
  // the user already has, so there is no list of supported languages to keep up to date.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ pattern: "**" }, new ForgeCodeActions(), {
      providedCodeActionKinds: ForgeCodeActions.kinds,
    }),
  );

  // Tell the user, once, where their data is going. An assistant that is quiet about this is
  // asking to be uninstalled by a security team.
  void announce(context, log);
}

async function announce(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
  const s = readSettings();
  let chatUrl = "";
  try {
    chatUrl = endpointFor(s, s.chat.provider);
  } catch {
    /* not configured yet */
  }
  const local = chatUrl ? isLocalEndpoint(chatUrl) : true;
  log.appendLine(
    `[activation] chat=${s.chat.provider} (${chatUrl || "not configured"}, ${local ? "local" : "remote"}) ` +
      `completion=${s.completion.provider} redaction=${s.privacy.redaction} language=${vscode.env.language}`,
  );
  const KEY = "forge.announced";
  if (context.globalState.get<boolean>(KEY)) return;
  await context.globalState.update(KEY, true);
  const choice = await vscode.window.showInformationMessage(
    local
      ? t("Forge is active. Everything stays on your machine: completion and chat talk to your local server.")
      : t(
          "Forge is active. Chat uses {0}; what leaves is pseudonymised and will be shown to you before the first request.",
          safeHost(chatUrl),
        ),
    t("Open the settings"),
    t("Got it"),
  );
  if (choice === t("Open the settings")) {
    await vscode.commands.executeCommand("workbench.action.openSettings", SECTION);
  }
}

export function deactivate(): void {
  /* nothing to unwind: every disposable is registered on the context */
}

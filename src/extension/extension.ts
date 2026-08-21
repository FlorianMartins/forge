// Activation. Everything the extension can do is registered here and nowhere else, so the list of
// its capabilities is one file long and a reviewer can read it in a minute.

import * as vscode from "vscode";
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
  const log = vscode.window.createOutputChannel("Hivey Forge");
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
    vscode.workspace.registerTextDocumentContentProvider("hivey-forge-preview", new PreviewProvider()),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      const s = readSettings();
      budget.setLimits(s.budget);
      completion.invalidateProvider();
      completion.updateStatus(s);
    }),

    vscode.commands.registerCommand("hiveyForge.newSession", () => chat.newSession()),
    vscode.commands.registerCommand("hiveyForge.completionAccepted", () => completion.noteAccepted()),

    vscode.commands.registerCommand("hiveyForge.toggleCompletions", async () => {
      const config = vscode.workspace.getConfiguration(SECTION);
      const next = !config.get<boolean>("completion.enabled", true);
      await config.update("completion.enabled", next, vscode.ConfigurationTarget.Global);
      completion.updateStatus(readSettings());
    }),

    vscode.commands.registerCommand("hiveyForge.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: "openrouter", detail: "Passerelle multi-modèles" },
          { label: "anthropic", detail: "API Claude" },
          { label: "openai-compatible", detail: "Passerelle interne, Azure, LiteLLM…" },
          { label: "local", detail: "Serveur local qui exige une clé (rare)" },
        ],
        { placeHolder: "Pour quel fournisseur ?" },
      );
      if (!provider) return;
      const key = await vscode.window.showInputBox({
        prompt: `Clé pour ${provider.label}. Elle est rangée dans le trousseau du système, jamais dans les réglages.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      await keys.store(provider.label as never, key);
      completion.invalidateProvider();
      void vscode.window.showInformationMessage(`Hivey Forge : clé ${provider.label} enregistrée dans le trousseau.`);
    }),

    vscode.commands.registerCommand("hiveyForge.clearApiKey", async () => {
      const provider = await vscode.window.showQuickPick(["openrouter", "anthropic", "openai-compatible", "local"], {
        placeHolder: "Quelle clé effacer ?",
      });
      if (!provider) return;
      await keys.delete(provider as never);
      completion.invalidateProvider();
      void vscode.window.showInformationMessage(`Clé ${provider} effacée.`);
    }),

    vscode.commands.registerCommand("hiveyForge.pickModel", async () => {
      const s = readSettings();
      const which = await vscode.window.showQuickPick(
        [
          { label: "Discussion", target: "chat" as const, description: s.chat.model },
          { label: "Complétion inline", target: "completion" as const, description: s.completion.model },
        ],
        { placeHolder: "Quel rôle ?" },
      );
      if (!which) return;
      const id = which.target === "chat" ? s.chat.provider : s.completion.provider === "off" ? "local" : s.completion.provider;
      let models: string[] = [];
      try {
        const provider = await providerFor(s, keys, id);
        models = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Hivey Forge : liste des modèles de ${id}…` },
          () => provider.listModels(),
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Impossible de lister les modèles : ${(err as Error).message}`);
        return;
      }
      const picked = await vscode.window.showQuickPick(models, { placeHolder: `Modèle pour ${which.label.toLowerCase()}` });
      if (!picked) return;
      await vscode.workspace
        .getConfiguration(SECTION)
        .update(`${which.target}.model`, picked, vscode.ConfigurationTarget.Workspace);
      completion.invalidateProvider();
      completion.updateStatus(readSettings());
    }),

    vscode.commands.registerCommand("hiveyForge.showEgress", () => showEgressReport(gate, readSettings())),
    vscode.commands.registerCommand("hiveyForge.showCosts", () => showCostReport(gate, readSettings())),

    vscode.commands.registerCommand("hiveyForge.indexWorkspace", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Hivey Forge : cartographie du dépôt…" },
        async () => {
          workspace.invalidate();
          const map = await workspace.repoMap(readSettings().context.maxTokens, true);
          void vscode.window.showInformationMessage(
            map ? `Carte du dépôt : ${map.files} fichiers, ${map.omitted} omis (budget de jetons).` : "Aucun dossier ouvert.",
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
    `[activation] discussion=${s.chat.provider} (${chatUrl || "non configuré"}, ${local ? "local" : "distant"}) ` +
      `complétion=${s.completion.provider} anonymisation=${s.privacy.redaction}`,
  );
  const KEY = "hiveyForge.announced";
  if (context.globalState.get<boolean>(KEY)) return;
  await context.globalState.update(KEY, true);
  const choice = await vscode.window.showInformationMessage(
    local
      ? "Hivey Forge est actif. Tout reste sur votre machine : la complétion et la discussion parlent à votre serveur local."
      : `Hivey Forge est actif. La discussion utilise ${safeHost(chatUrl)} ; ce qui sort est anonymisé et vous sera montré avant le premier envoi.`,
    "Ouvrir les réglages",
    "Compris",
  );
  if (choice === "Ouvrir les réglages") {
    await vscode.commands.executeCommand("workbench.action.openSettings", SECTION);
  }
}

export function deactivate(): void {
  /* nothing to unwind: every disposable is registered on the context */
}

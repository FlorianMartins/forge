// The commands that live in the editor rather than in the panel: ask about a selection, rewrite a
// selection in place, write a commit message, explain what the terminal just printed.
//
// They share the panel's plumbing (provider, redaction, budget) but not its conversation: an
// inline edit is a one-shot request that should not pollute — or be polluted by — the discussion
// the user is having in the sidebar.

import * as vscode from "vscode";
import { runTurn } from "../core/agent/loop.js";
import { isLocalEndpoint, redact, Vault } from "../core/redaction/index.js";
import { headToTokens } from "../core/util/tokens.js";
import type { ChatViewProvider } from "./chat.js";
import { endpointFor, providerFor, readSettings, redactionPolicy, type Keys } from "./config.js";
import { COMMIT_PROMPT, INLINE_EDIT_PROMPT } from "../core/prompts.js";
import { relative, type WorkspaceContext } from "./workspace.js";

export interface EditorDeps {
  chat: ChatViewProvider;
  keys: Keys;
  workspace: WorkspaceContext;
  log: vscode.OutputChannel;
}

export function registerEditorCommands(context: vscode.ExtensionContext, deps: EditorDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("hiveyForge.askAboutSelection", async () => {
      const item = deps.workspace.activeContext();
      const question = await vscode.window.showInputBox({
        prompt: "Que voulez-vous savoir sur cette sélection ?",
        placeHolder: "Explique ce que fait ce code / trouve le bug / écris un test",
        ignoreFocusOut: true,
      });
      if (!question) return;
      await deps.chat.focusWithPrompt(question, item);
    }),

    vscode.commands.registerCommand("hiveyForge.editSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const range = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection;
      const original = editor.document.getText(range);
      const instruction = await vscode.window.showInputBox({
        prompt: `Modifier ${relative(editor.document.uri)} (${range.end.line - range.start.line + 1} ligne(s))`,
        placeHolder: "extraire une fonction, gérer l'erreur, ajouter les types…",
        ignoreFocusOut: true,
      });
      if (!instruction) return;

      const replacement = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Hivey Forge : réécriture…", cancellable: true },
        (_p, token) =>
          oneShot(
            deps,
            INLINE_EDIT_PROMPT,
            [
              `Language: ${editor.document.languageId}`,
              `Instruction: ${instruction}`,
              "",
              "Fragment:",
              original,
            ].join("\n"),
            token,
          ),
      );
      if (!replacement) return;

      const cleaned = stripFence(replacement);
      await editor.edit((b) => b.replace(range, cleaned));
      // The user reviews it as a normal edit: it is in the undo stack and in the SCM diff.
      void vscode.window.showInformationMessage("Modification appliquée — Ctrl+Z pour revenir.", "Voir le diff").then((c) => {
        if (c === "Voir le diff") void vscode.commands.executeCommand("workbench.view.scm");
      });
    }),

    vscode.commands.registerCommand("hiveyForge.generateCommitMessage", async () => {
      const git = vscode.extensions.getExtension<GitExtensionApi>("vscode.git")?.exports?.getAPI(1);
      const repo = git?.repositories?.[0];
      if (!repo) {
        void vscode.window.showWarningMessage("Aucun dépôt Git ouvert.");
        return;
      }
      const diff: string = await repo.diff(true);
      if (!diff.trim()) {
        void vscode.window.showWarningMessage("Rien dans l'index : `git add` d'abord.");
        return;
      }
      const message = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "Hivey Forge : message de commit…" },
        () => oneShot(deps, COMMIT_PROMPT, headToTokens(diff, 6000)),
      );
      if (message) repo.inputBox.value = stripFence(message).trim();
    }),

    vscode.commands.registerCommand("hiveyForge.explainTerminalSelection", async () => {
      const selection = vscode.window.activeTerminal ? await copyTerminalSelection() : undefined;
      if (!selection?.trim()) {
        void vscode.window.showWarningMessage("Sélectionnez d'abord du texte dans le terminal.");
        return;
      }
      await deps.chat.focusWithPrompt("Explique cette sortie de terminal et propose la correction.", {
        kind: "terminal",
        label: "sortie du terminal",
        body: headToTokens(selection, 3000),
        untrusted: true,
      });
    }),
  );
}

/**
 * One request, no conversation, no tools. Redaction still applies: an inline edit sends the code
 * being edited, which is exactly the material a privacy policy is about.
 */
async function oneShot(deps: EditorDeps, system: string, user: string, token?: vscode.CancellationToken): Promise<string | undefined> {
  const settings = readSettings();
  const id = settings.chat.provider;
  try {
    const baseUrl = endpointFor(settings, id);
    const isLocal = isLocalEndpoint(baseUrl);
    const vault = new Vault();
    const payload = isLocal ? user : redact(user, vault, redactionPolicy(settings)).text;

    const provider = await providerFor(settings, deps.keys, id);
    const ctl = new AbortController();
    token?.onCancellationRequested(() => ctl.abort());

    const result = await runTurn({
      provider,
      model: settings.chat.model,
      messages: [
        { role: "system", content: system, cacheable: true },
        { role: "user", content: payload },
      ],
      maxTokens: 2048,
      temperature: 0.2,
      signal: ctl.signal,
      afterResponse: (t) => vault.restore(t),
    });
    return result.text;
  } catch (err) {
    const message = (err as Error).message;
    deps.log.appendLine(`[one-shot] ${message}`);
    void vscode.window.showErrorMessage(`Hivey Forge : ${message}`);
    return undefined;
  }
}

/** Models wrap code in fences even when told not to; unwrap rather than argue with them. */
export function stripFence(text: string): string {
  const m = text.match(/^\s*```[a-zA-Z0-9+#-]*\n([\s\S]*?)```\s*$/);
  return (m ? m[1]! : text).replace(/\n$/, "");
}

async function copyTerminalSelection(): Promise<string | undefined> {
  // There is no API to read a terminal selection; the supported route is the copy command, and
  // the clipboard is restored afterwards so the user does not lose what they had.
  const previous = await vscode.env.clipboard.readText();
  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
  const text = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(previous);
  return text === previous ? undefined : text;
}

interface GitExtensionApi {
  getAPI(version: number): {
    repositories: Array<{
      diff(staged: boolean): Promise<string>;
      inputBox: { value: string };
    }>;
  };
}

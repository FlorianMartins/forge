// Quick fixes on the editor's own diagnostics.
//
// This is the one place where an assistant inside an editor beats an assistant beside it: the
// language server already knows WHAT is wrong and WHERE, with a message written by people who
// understand the compiler. Handing that to the model — instead of asking it to find the bug by
// reading the file — turns a vague request into a precise one, and makes a small local model
// enough for a large share of everyday fixes.

import * as vscode from "vscode";

export class ForgeCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics.slice(0, 3)) {
      const fix = new vscode.CodeAction(`Corriger avec Forge : ${short(diagnostic.message)}`, vscode.CodeActionKind.QuickFix);
      fix.diagnostics = [diagnostic];
      fix.command = {
        command: "forge.fixDiagnostic",
        title: "Corriger",
        arguments: [document.uri, diagnostic],
      };
      actions.push(fix);

      const explain = new vscode.CodeAction("Expliquer ce problème", vscode.CodeActionKind.QuickFix);
      explain.diagnostics = [diagnostic];
      explain.command = {
        command: "forge.explainDiagnostic",
        title: "Expliquer",
        arguments: [document.uri, diagnostic],
      };
      actions.push(explain);
    }

    if (!range.isEmpty) {
      for (const [title, instruction] of [
        ["Écrire un test pour cette sélection", "Écris un test pour ce code, dans le style des tests déjà présents dans ce dépôt."],
        ["Documenter cette sélection", "Ajoute une documentation concise au-dessus de ce code, dans la langue et le style du fichier."],
      ] as const) {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.RefactorRewrite);
        action.command = { command: "forge.askWith", title, arguments: [instruction] };
        actions.push(action);
      }
    }

    return actions;
  }
}

function short(message: string): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

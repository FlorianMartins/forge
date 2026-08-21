// What only a real editor can tell us: that the extension activates, that everything the manifest
// promises actually exists, and that the pieces the user touches first are wired.

import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const ID = "hivey.hivey-forge";

suite("Hivey Forge", () => {
  test("the extension is present and activates", async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, "extension not found by id");
    await ext!.activate();
    assert.equal(ext!.isActive, true);
  });

  test("every command the manifest declares is registered", async () => {
    const ext = vscode.extensions.getExtension(ID)!;
    await ext.activate();
    const declared: string[] = (ext.packageJSON.contributes.commands as Array<{ command: string }>).map((c) => c.command);
    const registered = await vscode.commands.getCommands(true);
    const missing = declared.filter((c) => !registered.includes(c));
    assert.deepEqual(missing, [], `commands declared but not registered: ${missing.join(", ")}`);
  });

  test("settings read back with the defaults the manifest declares", () => {
    const c = vscode.workspace.getConfiguration("hiveyForge");
    assert.equal(c.get("chat.provider"), "local");
    assert.equal(c.get("privacy.redaction"), "strict");
    assert.equal(c.get("completion.enabled"), true);
    assert.ok((c.get<string[]>("privacy.blockedGlobs") ?? []).includes("**/.env*"));
  });

  test("the inline completion provider survives a model server that is not there", async () => {
    // Point at a closed port so the failure is immediate and deterministic. This is the path a
    // user hits on their first day — before `ollama serve` — and it must produce no suggestion and
    // no error dialog, not an exception in the extension host.
    const config = vscode.workspace.getConfiguration("hiveyForge");
    await config.update("endpoints.local", "http://127.0.0.1:45387/v1", vscode.ConfigurationTarget.Global);
    await config.update("completion.debounceMs", 0, vscode.ConfigurationTarget.Global);
    try {
      const doc = await vscode.workspace.openTextDocument({ language: "javascript", content: "function add(a, b) {\n  \n}\n" });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(1, 2, 1, 2);

      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes("vscode.executeInlineCompletionProvider")) return; // older host: nothing to drive
      const result = await vscode.commands.executeCommand<{ items: unknown[] }>(
        "vscode.executeInlineCompletionProvider",
        doc.uri,
        editor.selection.active,
      );
      assert.equal(result?.items.length ?? 0, 0, "no suggestion when no server answers");
    } finally {
      await config.update("endpoints.local", undefined, vscode.ConfigurationTarget.Global);
      await config.update("completion.debounceMs", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("the reports open without a script and without a model", async () => {
    await vscode.commands.executeCommand("hiveyForge.showEgress");
    await vscode.commands.executeCommand("hiveyForge.showCosts");
  });

  test("quick fixes are offered on a diagnostic", async () => {
    const doc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "ligne en erreur\n" });
    const collection = vscode.languages.createDiagnosticCollection("forge-test");
    const range = new vscode.Range(0, 0, 0, 5);
    collection.set(doc.uri, [new vscode.Diagnostic(range, "quelque chose ne va pas", vscode.DiagnosticSeverity.Error)]);

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", doc.uri, range);
    const titles = (actions ?? []).map((a) => a.title);
    assert.ok(
      titles.some((t) => t.startsWith("Corriger avec Hivey Forge")),
      `no Forge quick fix among: ${titles.join(" | ")}`,
    );
    collection.dispose();
  });
});

// Screenshot mode. Not a test: it drives a real conversation against a stub model server, then
// holds the window open while an outside process captures the screen. Guarded by an environment
// variable so it never runs in CI. Everything on the resulting image is real UI rendering real
// content — the only thing faked is the model that answered.
suite("Screenshot", () => {
  test("hold the window open with a real conversation", async function () {
    if (!process.env["FORGE_SCREENSHOT"]) return;
    this.timeout(180_000);

    const config = vscode.workspace.getConfiguration("hiveyForge");
    await config.update("endpoints.local", process.env["FORGE_SCREENSHOT"], vscode.ConfigurationTarget.Global);
    await config.update("chat.model", "qwen2.5-coder:7b", vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument({
      language: "typescript",
      content: [
        "export function totalTTC(lignes: Ligne[], tauxTVA = 0.2): number {",
        "  const ht = lignes.reduce((somme, l) => somme + l.prixUnitaire * l.quantite, 0);",
        "  return ht * (1 + tauxTVA);",
        "}",
        "",
      ].join("\n"),
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 3, 1);

    // Tidy the window for the capture: no auxiliary chat panel, no notification toast, and a
    // sidebar wide enough to read — the width a user would actually give it.
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
    await vscode.commands.executeCommand("notifications.clearAll").then(undefined, () => {});
    await vscode.commands.executeCommand("hiveyForge.chat.focus");
    for (let i = 0; i < 10; i++) await vscode.commands.executeCommand("workbench.action.increaseViewSize");
    await vscode.commands.executeCommand("hiveyForge.askWith", "Cette fonction arrondit-elle correctement ? Que corriger ?");
    await new Promise((r) => setTimeout(r, 4000));
    await vscode.commands.executeCommand("notifications.clearAll").then(undefined, () => {});

    // Long enough for the turn to stream and render, then for the capture to happen.
    await new Promise((r) => setTimeout(r, Number(process.env["FORGE_SCREENSHOT_HOLD"] ?? 45_000)));
  });
});

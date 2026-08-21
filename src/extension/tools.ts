// What the agent can do, expressed as tools the editor performs on its behalf.
//
// Every one of them goes through VS Code rather than through the filesystem directly, and that is
// not a stylistic choice: an edit applied as a WorkspaceEdit lands in the undo stack, respects the
// user's formatter, and shows up in the diff view. An edit written with `fs.writeFile` is a
// surprise the user cannot undo.
//
// The permission model is the same one Claude Code taught everyone to expect: reading is free,
// changing is asked. Each tool answers `approval()` for itself, so the rule is next to the thing
// it governs and a new tool cannot forget to have one.

import * as vscode from "vscode";
import type { Tool, ToolResult } from "../core/agent/loop.js";
import { headToTokens } from "../core/util/tokens.js";
import { EgressGate } from "./egress.js";
import type { Settings } from "./config.js";
import { relative } from "./workspace.js";

const MAX_READ_TOKENS = 6000;
const MAX_MATCHES = 60;

function root(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No folder is open.");
  return folder.uri;
}

function resolve(path: string, settings: Settings): vscode.Uri {
  const clean = path.replace(/^\.\//, "");
  // A tool call is model output, and model output can be steered by a file it just read. Escaping
  // the workspace is refused here rather than trusted to the model's good manners.
  if (clean.startsWith("/") || clean.includes("..")) {
    throw new Error(`Refused: “${path}” leaves the workspace.`);
  }
  if (EgressGate.isBlocked(clean, settings.privacy.blockedGlobs)) {
    throw new Error(`Refused: “${path}” is excluded by the privacy policy.`);
  }
  return vscode.Uri.joinPath(root(), clean);
}

export interface ToolDeps {
  settings: () => Settings;
  /** Shows a diff and returns what the user chose. */
  confirmEdit?: (uri: vscode.Uri, next: string) => Promise<boolean>;
}

export function buildTools(deps: ToolDeps): Tool[] {
  const s = () => deps.settings();

  const readFile: Tool = {
    schema: {
      name: "read_file",
      description: "Read a file from the workspace. Returns its text, truncated if very large.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the workspace root." } },
        required: ["path"],
      },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      const uri = resolve(String(args["path"] ?? ""), s());
      const doc = await vscode.workspace.openTextDocument(uri);
      ctx.report(`lu ${relative(uri)} (${doc.lineCount} lignes)`);
      return { content: headToTokens(doc.getText(), MAX_READ_TOKENS) };
    },
  };

  const listFiles: Tool = {
    schema: {
      name: "list_files",
      description: "List workspace files matching a glob, e.g. `src/**/*.ts`.",
      parameters: {
        type: "object",
        properties: { glob: { type: "string" }, limit: { type: "number" } },
        required: ["glob"],
      },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      const glob = String(args["glob"] ?? "**/*");
      const limit = Math.min(Number(args["limit"] ?? 100), 300);
      const uris = await vscode.workspace.findFiles(glob, undefined, limit);
      ctx.report(`${uris.length} fichier(s) pour ${glob}`);
      return { content: uris.map(relative).join("\n") || "(no match)" };
    },
  };

  const searchText: Tool = {
    schema: {
      name: "search_text",
      description: "Search the workspace for a regular expression. Returns matching lines with their paths.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, glob: { type: "string", description: "Optional file filter." } },
        required: ["pattern"],
      },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      const pattern = String(args["pattern"] ?? "");
      const glob = String(args["glob"] ?? "**/*");
      let re: RegExp;
      try {
        re = new RegExp(pattern, "g");
      } catch (err) {
        return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
      }
      const uris = await vscode.workspace.findFiles(glob, undefined, 800);
      const out: string[] = [];
      for (const uri of uris) {
        if (out.length >= MAX_MATCHES) break;
        try {
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i]!)) out.push(`${relative(uri)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        } catch {
          /* unreadable file */
        }
      }
      ctx.report(`${out.length} occurrence(s) de /${pattern}/`);
      return { content: out.join("\n") || "(no match)" };
    },
  };

  const diagnostics: Tool = {
    schema: {
      name: "get_diagnostics",
      description:
        "Errors and warnings the editor's language servers currently report. Use this after an edit to check the work, instead of guessing.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Optional: one file only." } } },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      const only = args["path"] ? resolve(String(args["path"]), s()).toString() : undefined;
      const all = vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, list] of all) {
        if (only && uri.toString() !== only) continue;
        for (const d of list.slice(0, 20)) {
          const sev = ["error", "warning", "info", "hint"][d.severity] ?? "info";
          lines.push(`${relative(uri)}:${d.range.start.line + 1} ${sev}: ${d.message}`);
        }
      }
      ctx.report(`${lines.length} diagnostic(s)`);
      return { content: lines.slice(0, 100).join("\n") || "No diagnostics." };
    },
  };

  const writeFile: Tool = {
    schema: {
      name: "write_file",
      description: "Create a file or replace its entire contents. Prefer edit_file for a change to an existing file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    approval: (args) => `écrire ${String(args["path"])}`,
    async run(args, ctx): Promise<ToolResult> {
      const uri = resolve(String(args["path"] ?? ""), s());
      const content = String(args["content"] ?? "");
      if (deps.confirmEdit && !(await deps.confirmEdit(uri, content))) {
        return { content: "The user rejected the change after reviewing the diff.", isError: true };
      }
      const edit = new vscode.WorkspaceEdit();
      let existed = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        existed = false;
      }
      if (existed) {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
      } else {
        edit.createFile(uri, { contents: new TextEncoder().encode(content), overwrite: false });
      }
      const ok = await vscode.workspace.applyEdit(edit);
      ctx.report(`${existed ? "modifié" : "créé"} ${relative(uri)}`);
      return ok
        ? { content: `Wrote ${relative(uri)} (${content.split("\n").length} lines).`, display: { uri: uri.toString() } }
        : { content: "The editor refused the edit.", isError: true };
    },
  };

  const editFile: Tool = {
    schema: {
      name: "edit_file",
      description:
        "Replace an exact snippet in a file. `old` must appear exactly once. This is the preferred way to change existing code: it is reviewable and it cannot silently rewrite the rest of the file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
        required: ["path", "old", "new"],
      },
    },
    approval: (args) => `modifier ${String(args["path"])}`,
    async run(args, ctx): Promise<ToolResult> {
      const uri = resolve(String(args["path"] ?? ""), s());
      const oldText = String(args["old"] ?? "");
      const newText = String(args["new"] ?? "");
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const first = text.indexOf(oldText);
      if (first < 0) return { content: "That snippet does not appear in the file. Read it again.", isError: true };
      if (text.indexOf(oldText, first + 1) >= 0) {
        return { content: "That snippet appears more than once. Include more surrounding lines.", isError: true };
      }
      const next = text.slice(0, first) + newText + text.slice(first + oldText.length);
      if (deps.confirmEdit && !(await deps.confirmEdit(uri, next))) {
        return { content: "The user rejected the change after reviewing the diff.", isError: true };
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(first), doc.positionAt(first + oldText.length)), newText);
      const ok = await vscode.workspace.applyEdit(edit);
      ctx.report(`modifié ${relative(uri)}`);
      return ok ? { content: `Edited ${relative(uri)}.` } : { content: "The editor refused the edit.", isError: true };
    },
  };

  const runCommand: Tool = {
    schema: {
      name: "run_command",
      description:
        "Run a shell command in the workspace terminal (tests, build, git). The user approves it first and watches it run.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, why: { type: "string" } },
        required: ["command"],
      },
    },
    approval: (args) => `exécuter \`${String(args["command"])}\``,
    async run(args, ctx): Promise<ToolResult> {
      const command = String(args["command"] ?? "");
      const terminal =
        vscode.window.terminals.find((t) => t.name === "Hivey Forge") ??
        vscode.window.createTerminal({ name: "Hivey Forge", cwd: root() });
      terminal.show(true);
      terminal.sendText(command, true);
      ctx.report(`lancé : ${command}`);
      // The output belongs to the user's terminal. Claiming to have read it would be a lie: the
      // shell integration API cannot return it reliably across every shell and platform.
      return {
        content:
          "The command was started in the user's terminal. Ask them for the output, or use get_diagnostics for compiler errors.",
      };
    },
  };

  return [readFile, listFiles, searchText, diagnostics, writeFile, editFile, runCommand];
}

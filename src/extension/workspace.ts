// Everything the assistant knows about the code, and the rules about what it may know.
//
// The map is built once per workspace and refreshed when files change, not on every turn: walking
// a large repository takes seconds, and a chat that pauses for seconds before answering feels
// broken. It is also capped — both in how many files are read and in how many tokens the result
// occupies — because an assistant that indexes a monorepo on a laptop is a fan-noise generator.

import * as vscode from "vscode";
import { t } from "../shared/i18n.js";
import { buildRepoMap, isMappable, type MapFile } from "../core/context/repomap.js";
import type { ContextItem } from "../core/session/session.js";
import { estimateTokens, headToTokens } from "../core/util/tokens.js";
import { EgressGate } from "./egress.js";
import type { Settings } from "./config.js";

const MAX_FILES = 1500;
const MAX_FILE_BYTES = 200_000;

export class WorkspaceContext {
  private map?: { text: string; builtAt: number; focus: string; files: number; omitted: number };
  private dirty = true;
  private readonly recent: string[] = [];

  constructor(private readonly disposables: vscode.Disposable[]) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    watcher.onDidCreate(() => (this.dirty = true));
    watcher.onDidDelete(() => (this.dirty = true));
    disposables.push(watcher);
    disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.dirty = true;
        this.noteRecent(doc.uri);
      }),
    );
  }

  private noteRecent(uri: vscode.Uri): void {
    const rel = relative(uri);
    const i = this.recent.indexOf(rel);
    if (i >= 0) this.recent.splice(i, 1);
    this.recent.unshift(rel);
    this.recent.splice(20);
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Paths of every file open in a visible editor, most relevant first. */
  openPaths(): string[] {
    const active = vscode.window.activeTextEditor?.document.uri;
    const open = vscode.window.visibleTextEditors.map((e) => relative(e.document.uri));
    return active ? [relative(active), ...open.filter((p) => p !== relative(active))] : open;
  }

  /**
   * The repository map, cached. `focus` is the file being edited: it changes the ranking, so a
   * different focus rebuilds the map from the already-read files.
   */
  async repoMap(budgetTokens: number, force = false): Promise<{ text: string; files: number; omitted: number } | undefined> {
    if (!vscode.workspace.workspaceFolders?.length) return undefined;
    const focus = this.openPaths()[0] ?? "";
    if (!force && !this.dirty && this.map && this.map.focus === focus) {
      return { text: this.map.text, files: this.map.files, omitted: this.map.omitted };
    }

    const files = await this.readWorkspaceFiles();
    const built = buildRepoMap(files, budgetTokens, {
      focusPath: focus,
      openPaths: this.openPaths(),
      recentPaths: this.recent,
    });
    this.map = { text: built.text, builtAt: Date.now(), focus, files: built.filesIncluded, omitted: built.filesOmitted };
    this.dirty = false;
    return { text: built.text, files: built.filesIncluded, omitted: built.filesOmitted };
  }

  private async readWorkspaceFiles(): Promise<MapFile[]> {
    // `findFiles` already honours files.exclude and search.exclude, which is where a team's own
    // "do not look here" rules live.
    const uris = await vscode.workspace.findFiles("**/*", undefined, MAX_FILES);
    const out: MapFile[] = [];
    for (const uri of uris) {
      const rel = relative(uri);
      if (!isMappable(rel)) continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        out.push({ path: rel, text: new TextDecoder().decode(bytes) });
      } catch {
        // Unreadable file: skip it. A permission error is not worth an error message here.
      }
    }
    return out;
  }

  /** The file in the active editor, or the selection when there is one. */
  activeContext(maxTokens = 3000): ContextItem | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return undefined;
    const rel = relative(ed.document.uri);
    if (!ed.selection.isEmpty) {
      const text = ed.document.getText(ed.selection);
      return {
        kind: "selection",
        label: `${rel}:${ed.selection.start.line + 1}-${ed.selection.end.line + 1}`,
        body: headToTokens(text, maxTokens),
        untrusted: true,
      };
    }
    return {
      kind: "file",
      label: rel,
      body: headToTokens(ed.document.getText(), maxTokens),
      untrusted: true,
    };
  }

  /** Turn a path the user picked into a context item, refusing the ones policy forbids. */
  async fileContext(uri: vscode.Uri, settings: Settings, maxTokens = 4000): Promise<ContextItem | undefined> {
    const rel = relative(uri);
    if (EgressGate.isBlocked(rel, settings.privacy.blockedGlobs)) {
      void vscode.window.showWarningMessage(t("Forge: {0} is excluded by the privacy policy and will not be attached.", rel));
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    return {
      kind: "file",
      label: `${rel}${estimateTokens(text) > maxTokens ? t(" (truncated)") : ""}`,
      body: headToTokens(text, maxTokens),
      untrusted: true,
    };
  }

  /** Files whose names match a query — what `#` completion in the chat box offers. */
  async findFiles(query: string, limit = 20): Promise<string[]> {
    const pattern = query ? `**/*${query}*` : "**/*";
    const uris = await vscode.workspace.findFiles(pattern, undefined, limit * 4);
    return uris
      .map(relative)
      .filter(isMappable)
      .slice(0, limit);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export function relative(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return uri.fsPath;
  return vscode.workspace.asRelativePath(uri, false);
}

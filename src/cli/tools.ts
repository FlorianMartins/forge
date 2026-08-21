// The terminal client's tools. Same contract as the editor's, different hands: here there is no
// WorkspaceEdit and no diff view, so the safety comes from three rules instead.
//
//   1. Nothing escapes the working directory. Paths are resolved and checked, not trusted.
//   2. Nothing is written without a diff printed first and a yes typed after it.
//   3. A command's output IS captured here (unlike in the editor, where it belongs to the user's
//      terminal), which makes the terminal client the better place to run tests.

import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool, ToolResult } from "../core/agent/loop.js";
import { headToTokens } from "../core/util/tokens.js";
import { isBlockedPath } from "../core/util/glob.js";

export interface CliToolOptions {
  cwd: string;
  blockedGlobs: string[];
  /** Prints a diff and asks. The loop's approver handles yes/no; this one shows what changes. */
  showDiff: (path: string, before: string, after: string) => void;
  maxOutputChars?: number;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", ".venv", "__pycache__", ".next"]);

export function safeResolve(opts: CliToolOptions, path: string): string {
  const full = isAbsolute(path) ? path : resolve(opts.cwd, path);
  const rel = relative(opts.cwd, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refused: “${path}” is outside the working directory.`);
  if (isBlockedPath(rel.split(sep).join("/"), opts.blockedGlobs)) {
    throw new Error(`Refused: “${path}” is excluded by the privacy policy.`);
  }
  return full;
}

async function walk(dir: string, root: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out, limit);
    else out.push(relative(root, full).split(sep).join("/"));
  }
}

export function buildCliTools(opts: CliToolOptions): Tool[] {
  const maxOut = opts.maxOutputChars ?? 8000;

  const readFileTool: Tool = {
    schema: {
      name: "read_file",
      description: "Read a file from the working directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      const path = safeResolve(opts, String(args["path"] ?? ""));
      const text = await readFile(path, "utf8");
      ctx.report(`lu ${args["path"]}`);
      return { content: headToTokens(text, 6000) };
    },
  };

  const listFiles: Tool = {
    schema: {
      name: "list_files",
      description: "List files under the working directory, skipping build output and dependencies.",
      parameters: { type: "object", properties: { subdir: { type: "string" }, limit: { type: "number" } } },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      const base = args["subdir"] ? safeResolve(opts, String(args["subdir"])) : opts.cwd;
      const out: string[] = [];
      await walk(base, opts.cwd, out, Math.min(Number(args["limit"] ?? 300), 1000));
      ctx.report(`${out.length} fichier(s)`);
      return { content: out.join("\n") || "(empty)" };
    },
  };

  const searchText: Tool = {
    schema: {
      name: "search_text",
      description: "Search the working directory for a regular expression.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, extension: { type: "string" } },
        required: ["pattern"],
      },
    },
    approval: () => false,
    async run(args, ctx): Promise<ToolResult> {
      let re: RegExp;
      try {
        re = new RegExp(String(args["pattern"] ?? ""));
      } catch (err) {
        return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
      }
      const ext = args["extension"] ? String(args["extension"]) : undefined;
      const files: string[] = [];
      await walk(opts.cwd, opts.cwd, files, 4000);
      const hits: string[] = [];
      for (const f of files) {
        if (ext && !f.endsWith(ext)) continue;
        if (hits.length >= 60) break;
        try {
          const info = await stat(join(opts.cwd, f));
          if (info.size > 400_000) continue;
          const lines = (await readFile(join(opts.cwd, f), "utf8")).split("\n");
          for (let i = 0; i < lines.length && hits.length < 60; i++) {
            if (re.test(lines[i]!)) hits.push(`${f}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        } catch {
          /* unreadable */
        }
      }
      ctx.report(`${hits.length} occurrence(s)`);
      return { content: hits.join("\n") || "(no match)" };
    },
  };

  const writeFileTool: Tool = {
    schema: {
      name: "write_file",
      description: "Create a file or replace its contents. Prefer edit_file for an existing file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    approval: (args) => `écrire ${String(args["path"])}`,
    async run(args, ctx): Promise<ToolResult> {
      const rel = String(args["path"] ?? "");
      const path = safeResolve(opts, rel);
      const content = String(args["content"] ?? "");
      let before = "";
      try {
        before = await readFile(path, "utf8");
      } catch {
        /* new file */
      }
      opts.showDiff(rel, before, content);
      await writeFile(path, content, "utf8");
      ctx.report(`écrit ${rel}`);
      return { content: `Wrote ${rel} (${content.split("\n").length} lines).` };
    },
  };

  const editFile: Tool = {
    schema: {
      name: "edit_file",
      description: "Replace an exact snippet in a file. The snippet must appear exactly once.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
        required: ["path", "old", "new"],
      },
    },
    approval: (args) => `modifier ${String(args["path"])}`,
    async run(args, ctx): Promise<ToolResult> {
      const rel = String(args["path"] ?? "");
      const path = safeResolve(opts, rel);
      const oldText = String(args["old"] ?? "");
      const newText = String(args["new"] ?? "");
      const text = await readFile(path, "utf8");
      const at = text.indexOf(oldText);
      if (at < 0) return { content: "That snippet does not appear in the file. Read it again.", isError: true };
      if (text.indexOf(oldText, at + 1) >= 0) {
        return { content: "That snippet appears more than once. Include more surrounding lines.", isError: true };
      }
      const next = text.slice(0, at) + newText + text.slice(at + oldText.length);
      opts.showDiff(rel, text, next);
      await writeFile(path, next, "utf8");
      ctx.report(`modifié ${rel}`);
      return { content: `Edited ${rel}.` };
    },
  };

  const runCommand: Tool = {
    schema: {
      name: "run_command",
      description: "Run a shell command in the working directory and return its output. Use it for tests and builds.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
        required: ["command"],
      },
    },
    approval: (args) => `exécuter \`${String(args["command"])}\``,
    async run(args, ctx): Promise<ToolResult> {
      const command = String(args["command"] ?? "");
      const timeout = Math.min(Number(args["timeoutMs"] ?? 120_000), 600_000);
      ctx.report(`$ ${command}`);
      return await new Promise<ToolResult>((resolveResult) => {
        const child = spawn(command, { cwd: opts.cwd, shell: true });
        let out = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, timeout);
        const onAbort = () => child.kill("SIGKILL");
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
        const append = (chunk: Buffer) => {
          out += chunk.toString();
          // Keep the END of a long log: the failure is at the bottom, not at the top.
          if (out.length > maxOut * 2) out = out.slice(-maxOut * 2);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("close", (code) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
          const tail = out.length > maxOut ? `…(début tronqué)\n${out.slice(-maxOut)}` : out;
          resolveResult({
            content: `exit code ${killed ? "killed (timeout)" : code}\n${tail || "(no output)"}`,
            isError: code !== 0,
          });
        });
      });
    },
  };

  return [readFileTool, listFiles, searchText, writeFileTool, editFile, runCommand];
}

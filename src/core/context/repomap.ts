// The repository map: the cheapest useful answer to "what is in this codebase?".
//
// A hosted assistant can afford to embed a whole repository and search it on every turn. Doing
// that here would mean either shipping an embedding pipeline that runs on the user's laptop for
// every file (slow, and wrong the moment they switch branches) or sending the code to a remote
// embedding API (the exact thing this extension exists to avoid).
//
// So the default context is a MAP, not the territory: every file's path plus its top-level
// symbols, ranked so the ones that matter to the file being edited come first, and cut to a token
// budget. A few thousand tokens describe a repository a hundred times their size, they compress
// well, they sit in the cacheable prefix of the prompt (so they are billed once per conversation
// rather than once per turn on providers with a prompt cache), and they let the model ask for the
// two files it actually needs instead of being handed forty.

import { estimateTokens } from "../util/tokens.js";
import { extractImports, extractSymbols, type Sym } from "./symbols.js";

export interface MapFile {
  path: string;
  text: string;
}

export interface RankHints {
  /** The file being edited. Its neighbours and its imports outrank everything else. */
  focusPath?: string;
  /** Files open in the editor: the user already said these matter. */
  openPaths?: string[];
  /** Recently edited paths, newest first. */
  recentPaths?: string[];
}

export interface RepoMapEntry {
  path: string;
  symbols: Sym[];
  score: number;
}

const NOISE =
  /(?:^|\/)(?:node_modules|\.git|dist|build|out|target|vendor|coverage|__pycache__|\.venv|venv|\.next|\.nuxt|\.cache|bin|obj)(?:\/|$)/;
const BINARYISH = /\.(?:png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|jar|so|dylib|dll|exe|bin|lock|min\.js|map)$/i;

export function isMappable(path: string): boolean {
  return !NOISE.test(path) && !BINARYISH.test(path);
}

/** A file's importance, before any relation to the current one is considered. */
function baseScore(path: string): number {
  let s = 0;
  const name = path.split("/").pop() ?? path;
  if (/^(?:index|main|app|mod|lib)\.[a-z]+$/i.test(name)) s += 3;
  if (/^(?:README|ARCHITECTURE|CONTRIBUTING)/i.test(name)) s += 3;
  if (/(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|composer\.json)$/.test(name)) s += 4;
  if (/(?:\.test\.|\.spec\.|_test\.|^test_)/.test(name)) s -= 2; // tests describe behaviour, but there are many
  if (/\.d\.ts$/.test(name)) s -= 3;
  s -= Math.min(3, path.split("/").length - 1) * 0.3; // shallow files are usually the entry points
  return s;
}

export function rankFiles(files: MapFile[], hints: RankHints = {}): RepoMapEntry[] {
  const focus = hints.focusPath;
  const focusFile = focus ? files.find((f) => f.path === focus) : undefined;
  const focusImports = focusFile ? extractImports(focusFile.path, focusFile.text) : [];
  const focusDir = focus ? focus.slice(0, focus.lastIndexOf("/") + 1) : "";
  const open = new Set(hints.openPaths ?? []);
  const recent = hints.recentPaths ?? [];

  return files
    .filter((f) => isMappable(f.path))
    .map((f) => {
      let score = baseScore(f.path);
      if (f.path === focus) score += 100;
      if (open.has(f.path)) score += 20;
      const r = recent.indexOf(f.path);
      if (r >= 0) score += Math.max(1, 10 - r);
      if (focusDir && f.path.startsWith(focusDir)) score += 6;
      // Imported by the focus file, or importing it: a direct edge in the dependency graph.
      const stem = f.path.replace(/\.[^./]+$/, "");
      if (focusImports.some((i) => stem.endsWith(i.replace(/^[./]+/, "")))) score += 15;
      if (focus && extractImports(f.path, f.text).some((i) => focus.replace(/\.[^./]+$/, "").endsWith(i.replace(/^[./]+/, "")))) score += 8;
      return { path: f.path, symbols: extractSymbols(f.path, f.text), score };
    })
    .filter((e) => e.symbols.length > 0 || e.score > 4)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export interface RepoMap {
  text: string;
  filesIncluded: number;
  filesOmitted: number;
  tokens: number;
}

export function buildRepoMap(files: MapFile[], budgetTokens: number, hints: RankHints = {}): RepoMap {
  const ranked = rankFiles(files, hints);
  const lines: string[] = ["Repository map (paths and top-level symbols; ask for a file to see its body):"];
  let tokens = estimateTokens(lines[0]!);
  let included = 0;

  for (const entry of ranked) {
    const head = `\n${entry.path}`;
    const body = entry.symbols.slice(0, 25).map((s) => `  ${s.line}: ${s.signature}`).join("\n");
    const chunk = body ? `${head}\n${body}` : head;
    const cost = estimateTokens(chunk);
    if (tokens + cost > budgetTokens) {
      // Not `break`: a small high-value file further down still fits where a huge one did not.
      if (tokens + estimateTokens(head) <= budgetTokens) {
        lines.push(head);
        tokens += estimateTokens(head);
        included++;
      }
      continue;
    }
    lines.push(chunk);
    tokens += cost;
    included++;
  }

  return {
    text: lines.join("\n"),
    filesIncluded: included,
    filesOmitted: Math.max(0, ranked.length - included),
    tokens,
  };
}

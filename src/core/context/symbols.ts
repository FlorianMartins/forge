// Top-level symbols, extracted with regular expressions rather than a parser.
//
// The obvious objection is that a regex is not a parser, and it is right: what follows will miss
// a symbol declared inside a macro and will occasionally name something that is commented out.
// The alternative costs a native tree-sitter binary per platform, a WASM build, or a language
// server round-trip — several megabytes and a supply-chain surface, for a REPOSITORY MAP whose
// job is to tell a model "there is a function called `parseInvoice` in billing/parse.ts". At that
// job a regex is accurate enough, and being wrong about one line costs one wrong line in a map,
// not a wrong answer.
//
// Inside VS Code the extension prefers the real thing when it is available — the editor's own
// DocumentSymbolProvider — and falls back here for files no language server has opened, which is
// most of a large repository.

export interface Sym {
  name: string;
  kind: "function" | "class" | "type" | "const" | "method" | "test";
  line: number;
  /** The declaration line, trimmed — a signature reads better than a bare name. */
  signature: string;
}

type LangRules = Array<{ re: RegExp; kind: Sym["kind"]; group?: number }>;

const TS_JS: LangRules = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=/, kind: "const" },
  { re: /^\s{2,}(?:public|private|protected|static|async|readonly|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, kind: "method" },
  { re: /^\s*(?:test|it|describe)\s*\(\s*["'`](.{3,80}?)["'`]/, kind: "test" },
];

const RULES: Array<{ ext: RegExp; rules: LangRules }> = [
  { ext: /\.(?:ts|tsx|js|jsx|mjs|cjs)$/, rules: TS_JS },
  {
    ext: /\.py$/,
    rules: [
      { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^([A-Z_][A-Z0-9_]*)\s*=/, kind: "const" },
    ],
  },
  {
    ext: /\.go$/,
    rules: [
      { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
      { re: /^type\s+([A-Za-z_]\w*)/, kind: "type" },
      { re: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: "const" },
    ],
  },
  {
    ext: /\.rs$/,
    rules: [
      { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/, kind: "type" },
      { re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    ext: /\.(?:java|kt|cs|scala)$/,
    rules: [
      { re: /^\s*(?:public|private|protected|internal|\s)*(?:abstract\s+|final\s+|sealed\s+|data\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^\s+(?:public|private|protected|internal|static|final|override|suspend|async|\s)*[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method" },
      { re: /^\s*(?:fun|def)\s+([A-Za-z_]\w*)/, kind: "function" },
    ],
  },
  {
    ext: /\.(?:php)$/,
    rules: [
      { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
      { re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/, kind: "function" },
    ],
  },
  {
    ext: /\.rb$/,
    rules: [
      { re: /^\s*def\s+([A-Za-z_][\w?!]*)/, kind: "function" },
      { re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    ext: /\.(?:c|h|cc|cpp|hpp|cxx)$/,
    rules: [
      { re: /^[A-Za-z_][\w\s*&:<>,]*\s[*&]?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: "function" },
      { re: /^\s*(?:struct|class|enum|union)\s+([A-Za-z_]\w*)/, kind: "type" },
      { re: /^\s*#define\s+([A-Z_][A-Z0-9_]*)/, kind: "const" },
    ],
  },
  {
    ext: /\.(?:sql)$/,
    rules: [
      // The schema prefix is consumed greedily on purpose: `hivey.sortie` names `sortie`.
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:table|materialized\s+view|view|function|procedure|index|policy|type|trigger)\s+(?:if\s+not\s+exists\s+)?(?:"?[a-z0-9_]+"?\s*\.\s*)?"?([a-z0-9_]+)/i, kind: "type" },
    ],
  },
];

export function extractSymbols(path: string, text: string, maxPerFile = 40): Sym[] {
  const entry = RULES.find((r) => r.ext.test(path));
  if (!entry) return [];
  const out: Sym[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < maxPerFile; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue; // minified or generated: nothing worth mapping
    for (const rule of entry.rules) {
      const m = rule.re.exec(line);
      if (m?.[rule.group ?? 1]) {
        out.push({
          name: m[rule.group ?? 1]!,
          kind: rule.kind,
          line: i + 1,
          signature: line.trim().replace(/\s*\{\s*$/, "").slice(0, 160),
        });
        break;
      }
    }
  }
  return out;
}

/** Imports, used to rank files by their relation to the file being edited. */
export function extractImports(path: string, text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /(?:^|\n)\s*from\s+([\w.]+)\s+import\s/g,
    /(?:^|\n)\s*use\s+([\w:]+)/g,
    /(?:^|\n)\s*#include\s+["<]([^">]+)[">]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

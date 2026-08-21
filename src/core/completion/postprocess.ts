// What comes back from a code model is nearly right, and the "nearly" is what makes an assistant
// feel broken. Five things are always wrong at least once a session, and each is cheaper to fix
// here than to ask a bigger model to avoid:
//
//   1. the model re-types what is already after the cursor (duplicated closing braces);
//   2. it wraps the answer in a markdown fence, because that is what its chat data looked like;
//   3. it keeps going into a whole new function when one line was wanted;
//   4. it opens brackets it never closes, leaving the file unparseable;
//   5. it re-emits the current line's indentation, doubling it.

export interface TrimOptions {
  suffix: string;
  multiline: boolean;
  /** Text already on the current line before the cursor — used to detect re-typed indentation. */
  linePrefix: string;
}

export function cleanCompletion(raw: string, opts: TrimOptions): string {
  let out = raw;
  if (!out) return "";

  // 2. Fences.
  const fence = out.match(/^\s*```[a-zA-Z0-9+#-]*\n([\s\S]*?)(?:```|$)/);
  if (fence) out = fence[1] ?? "";
  out = out.replace(/```\s*$/, "");

  // 5. Duplicated indentation: the model repeats the whitespace the editor already inserted.
  if (/^\s+$/.test(opts.linePrefix) && out.startsWith(opts.linePrefix)) {
    out = out.slice(opts.linePrefix.length);
  }

  // 1. Overlap with the suffix. Find the longest tail of the completion that is also the head of
  // what follows the cursor, and drop it.
  const suffixHead = opts.suffix.slice(0, 200);
  const maxOverlap = Math.min(out.length, suffixHead.length);
  for (let n = maxOverlap; n >= 3; n--) {
    if (out.slice(-n) === suffixHead.slice(0, n)) {
      out = out.slice(0, -n);
      break;
    }
  }

  // 3. Single-line mode stops at the first newline; multiline stops at a blank line, which is
  // where a model stops answering the question and starts writing the next one.
  if (!opts.multiline) {
    out = out.split("\n")[0] ?? "";
  } else {
    const blank = out.indexOf("\n\n\n");
    if (blank > 0) out = out.slice(0, blank);
  }

  // 4. Unbalanced brackets: cut back to the last position where the completion is balanced.
  out = truncateToBalanced(out);

  // Trailing blank space is never part of a suggestion: the editor puts the caret where it wants.
  return out.replace(/\s+$/, "");
}

/** Longest prefix of `s` whose brackets/quotes opened inside it are also closed inside it. */
export function truncateToBalanced(s: string): string {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  let lastBalanced = 0;
  let inString: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (closers.has(c)) {
      // A closer with nothing open belongs to the file, not to the completion: stop before it.
      if (stack.length && stack[stack.length - 1] === c) stack.pop();
      else return s.slice(0, lastBalanced);
    }
    if (!stack.length && !inString) lastBalanced = i + 1;
  }
  return stack.length || inString ? s.slice(0, lastBalanced) : s;
}

/** A completion that adds nothing is worse than none: it flickers and steals the Tab key. */
export function isUseless(completion: string): boolean {
  return completion.trim().length === 0 || /^[\s;,.)\]}]+$/.test(completion);
}

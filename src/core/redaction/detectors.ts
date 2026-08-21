// Detectors. Each one is a pure function from text to spans, so a rule can be tested on its own
// and a false positive can be traced to a name rather than to "the regex".
//
// Two principles the rules follow:
//   1. A secret is matched by SHAPE, not by the word next to it. `AKIA…` is an AWS key wherever
//      it appears; waiting for the word "aws" next to it is how scanners miss real leaks.
//   2. Anything that survives shape matching is checked for ENTROPY. A 40-character string that
//      looks random is treated as a credential even when no vendor prefix identifies it, because
//      the cost of redacting a hash by mistake is one placeholder in a prompt, and the cost of
//      the opposite is a credential in someone else's log.

import type { Finding, FindingKind } from "./types.js";

export interface RawSpan {
  kind: FindingKind;
  rule: string;
  start: number;
  end: number;
  value: string;
}

type Rule = {
  name: string;
  kind: FindingKind;
  re: RegExp;
  group?: number;
  /** Chooses the captured value when a rule has alternative groups. */
  pick?: (m: RegExpExecArray) => string | undefined;
  verify?: (value: string, quoted: boolean) => boolean;
};

/** Shannon entropy in bits per character — the classic "does this look random?" measure. */
export function entropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// A base64/hex blob is only interesting if it is both long and disordered. English prose reaches
// ~4.0 bits/char with spaces; a base64 key sits above 4.2 and has no spaces at all.
const HIGH_ENTROPY_MIN_LEN = 24;
const HIGH_ENTROPY_MIN_BITS = 3.6;

const RULES: Rule[] = [
  // ── Vendor-shaped credentials ──────────────────────────────────────────────────────────────
  { name: "aws-access-key", kind: "secret", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: "github-token", kind: "secret", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { name: "github-pat", kind: "secret", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { name: "slack-token", kind: "secret", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", kind: "secret", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "anthropic-key", kind: "secret", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-key", kind: "secret", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "openrouter-key", kind: "secret", re: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g },
  { name: "google-api-key", kind: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm-token", kind: "secret", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "hugging-face-token", kind: "secret", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "private-key-block", kind: "secret", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [^-]*-----/g },
  { name: "jwt", kind: "secret", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  // Credentials carried inside a URL: `postgres://user:p4ssw0rd@db.internal:5432/app`.
  { name: "url-credentials", kind: "secret", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/gi, group: 1 },
  // `PASSWORD = "…"`, `api_key: '…'`, `SECRET=…` — the assignment is what makes it a secret.
  //
  // The hard part is not finding these; it is not finding them in ordinary code. `apiKey: cfg.apiKey`,
  // `apiKey?: string`, `password = os.environ["PW"]` are all assignments to a secret-shaped name
  // whose value is a reference, a type or a lookup — never a credential. Running this scanner over
  // this very repository is what surfaced them, so the rule splits the two cases: a QUOTED value is
  // a literal and is treated as a secret; an UNQUOTED one has to look like a credential rather than
  // like an expression.
  {
    name: "assigned-secret",
    kind: "secret",
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth)\b\s*[?!]?\s*[:=]\s*(?:(["'`])([^"'`\n]{6,})\1|([^\s"'`,;)}\]]{6,}))/gi,
    // Either the quoted body or the bare token, whichever matched.
    pick: (m) => m[2] ?? m[3],
    verify: (v, quoted) => {
      // Placeholders and interpolations are not credentials, quoted or not.
      if (/^(?:\$\{|<|\{\{|%[a-z_]+%|xxx+|\*{3,}|change[_-]?me|your[_-]|todo|placeholder|example)/i.test(v)) return false;
      // A word in block capitals is a label, an enum member or a constant name — `secret: "SECRET"`
      // is a table of category names, and this scanner found one in its own source.
      if (/^[A-Z][A-Z_]*$/.test(v)) return false;
      if (quoted) return !/^(?:process\.|os\.|env[.[])/i.test(v);
      // Unquoted: reject anything with the shape of an expression, a type or a constant name.
      if (/[.(\[<]|::|->/.test(v)) return false;
      if (/^(?:string|number|boolean|any|unknown|null|true|false|undefined|none|nil|str|int)$/i.test(v)) return false;
      if (/^[A-Z_][A-Z0-9_]*$/.test(v)) return false; // SECRET = ANOTHER_CONSTANT
      // What is left must actually look random: a real value in a .env file does.
      return entropy(v) > 2.6 || v.length >= 16;
    },
  },

  // ── People ─────────────────────────────────────────────────────────────────────────────────
  { name: "email", kind: "identity", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "phone", kind: "identity", re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){2,4}\b/g,
    // Version numbers, dates and matrices all look like phone numbers. Require enough digits and
    // at least one real separator or an international prefix.
    verify: (v) => (v.replace(/\D/g, "").length >= 9 && /[\s.-]/.test(v)) || v.startsWith("+") },

  // ── Machines ───────────────────────────────────────────────────────────────────────────────
  { name: "ipv4", kind: "infra", re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    // Loopback and 0.0.0.0 carry no information about anyone's network.
    verify: (v) => !/^(?:127\.|0\.0\.0\.0$|255\.255\.255)/.test(v) },
  { name: "ipv6", kind: "infra", re: /\b(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}\b/g },
  { name: "mac-address", kind: "infra", re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g },
  // Hostnames on the private/corporate suffixes companies actually use.
  { name: "internal-host", kind: "infra", re: /\b(?:[a-z0-9-]+\.)+(?:internal|intranet|corp|local|lan|home|test|localdomain|priv|prod|preprod|staging)\b/gi },

  // ── Layout ─────────────────────────────────────────────────────────────────────────────────
  // A path tells the model where a file is; the account name in it tells it who the person is.
  { name: "unix-home", kind: "path", re: /(?:\/(?:home|Users))\/([A-Za-z0-9._-]+)/g, group: 1,
    verify: (v) => !["root", "runner", "ubuntu", "user", "node"].includes(v.toLowerCase()) },
  { name: "windows-home", kind: "path", re: /(?:[A-Za-z]:\\Users\\)([A-Za-z0-9._ -]+)/g, group: 1 },
];

/** Run every shape rule. Returns spans in text order; overlaps are resolved by the caller. */
export function scanShapes(text: string): RawSpan[] {
  const out: RawSpan[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0] === "") { re.lastIndex++; continue; }
      const value = rule.pick ? rule.pick(m) : m[rule.group ?? 0];
      if (value == null || value === "") continue;
      const quoted = rule.pick ? m[0].includes(`"${value}`) || m[0].includes(`'${value}`) || m[0].includes(`\`${value}`) : false;
      if (rule.verify && !rule.verify(value, quoted)) continue;
      const start = m[0] === value ? m.index : m.index + m[0].indexOf(value);
      out.push({ kind: rule.kind, rule: rule.name, start, end: start + value.length, value });
    }
  }
  return out;
}

/** Long, disordered strings that no vendor rule claimed. The safety net. */
export function scanEntropy(text: string): RawSpan[] {
  const out: RawSpan[] = [];
  const re = /[A-Za-z0-9+/=_-]{24,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = m[0];
    // A checksum is public by construction: `sha512-…` in a lock file, a git object id, a
    // subresource-integrity attribute. Redacting them adds noise and hides nothing.
    if (/(?:sha1|sha256|sha384|sha512|md5)-$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    if (/integrity["'\s:=]+$/i.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
    if (v.length < HIGH_ENTROPY_MIN_LEN) continue;
    // A long identifier is words joined by _ or -, and reads with low entropy; a key does not.
    if (entropy(v) < HIGH_ENTROPY_MIN_BITS) continue;
    // Require a mix: keys use several alphabets, English identifiers rarely do.
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length;
    if (classes < 3) continue;
    out.push({ kind: "secret", rule: "high-entropy", start: m.index, end: m.index + v.length, value: v });
  }
  return out;
}

/** Operator-supplied words: client names, project codenames, anything the org considers its own. */
export function scanTerms(text: string, terms: string[]): RawSpan[] {
  const out: RawSpan[] = [];
  for (const term of terms) {
    const t = term.trim();
    if (t.length < 3) continue;
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({ kind: "term", rule: "custom-term", start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  }
  return out;
}

/**
 * Resolve overlaps: the longest span wins, ties go to the more severe kind. Without this, the
 * e-mail rule and the assigned-secret rule can both claim `user=a@b.com` and produce nested
 * placeholders that no restore pass can undo.
 */
export function resolveOverlaps(spans: RawSpan[]): RawSpan[] {
  const severity: Record<FindingKind, number> = { secret: 5, identity: 4, term: 3, infra: 2, path: 1 };
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || severity[b.kind] - severity[a.kind],
  );
  const kept: RawSpan[] = [];
  for (const s of sorted) {
    const last = kept[kept.length - 1];
    if (last && s.start < last.end) continue; // fully or partially covered by a longer span
    kept.push(s);
  }
  return kept;
}

export type { Finding };

// The pipeline every byte crosses before it may reach a remote provider.
//
//   scan → resolve overlaps → filter by policy → replace → (block on secret) → send
//
// Local providers skip it entirely: redacting text that never leaves the machine costs quality
// for nothing. That decision is the caller's (`shouldRedact`), and it is the only place where the
// question "is this endpoint ours?" is answered.

import { scanShapes, scanEntropy, scanTerms, resolveOverlaps, type RawSpan } from "./detectors.js";
import { Vault } from "./pseudonymiser.js";
import { DEFAULT_POLICY, kindsFor, type Finding, type RedactionPolicy } from "./types.js";

export * from "./types.js";
export { Vault } from "./pseudonymiser.js";
export { entropy } from "./detectors.js";

export interface RedactionResult {
  text: string;
  findings: Finding[];
  /** True when a credential was found. Callers refuse the request when the policy says so. */
  hasSecret: boolean;
  changed: boolean;
}

/** Text the user typed can legitimately contain `⟨…⟩`; neutralise it so restore cannot be tricked. */
function escapePlaceholderShapes(text: string): string {
  return text.replace(/⟨([A-Z0-9]+_\d+)⟩/g, "<$1>");
}

export function redact(input: string, vault: Vault, policy: RedactionPolicy = DEFAULT_POLICY): RedactionResult {
  const text = escapePlaceholderShapes(input);
  const allowed = kindsFor(policy.level);

  const spans: RawSpan[] = [
    ...scanShapes(text),
    ...scanEntropy(text),
    ...(policy.customTerms.length ? scanTerms(text, policy.customTerms) : []),
  ].filter((s) => allowed.has(s.kind));

  const kept = resolveOverlaps(spans);
  if (!kept.length) return { text, findings: [], hasSecret: false, changed: text !== input };

  const findings: Finding[] = [];
  let out = "";
  let cursor = 0;
  for (const s of kept) {
    const placeholder = vault.placeholderFor(s.value, s.kind, s.rule);
    out += text.slice(cursor, s.start) + placeholder;
    cursor = s.end;
    findings.push({ kind: s.kind, rule: s.rule, start: s.start, end: s.end, value: s.value, placeholder });
  }
  out += text.slice(cursor);

  return {
    text: out,
    findings,
    hasSecret: findings.some((f) => f.kind === "secret"),
    changed: true,
  };
}

/** Convenience for message arrays: redacts every string field in place, sharing one vault. */
export function redactMessages<T extends { content: string }>(
  messages: T[],
  vault: Vault,
  policy: RedactionPolicy = DEFAULT_POLICY,
): { messages: T[]; findings: Finding[]; hasSecret: boolean } {
  const findings: Finding[] = [];
  let hasSecret = false;
  const out = messages.map((m) => {
    const r = redact(m.content, vault, policy);
    findings.push(...r.findings);
    hasSecret ||= r.hasSecret;
    return { ...m, content: r.text };
  });
  return { messages: out, findings, hasSecret };
}

/** A local endpoint is one that cannot leave the machine or the operator's own network. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const h = u.hostname;
    if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
    if (/^127\./.test(h)) return true;
    // RFC1918 + link-local + CGNAT: an address that no router will forward to the internet.
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
    if (/\.(?:internal|intranet|corp|local|lan|home)$/i.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

// The vault: the only place where "what the model saw" and "what the user wrote" are connected.
//
// Design choice that makes anonymisation usable rather than merely safe: replacement is
// REVERSIBLE and CONSISTENT. `alice@corp.fr` becomes `⟨EMAIL_1⟩` everywhere in the session, so the
// model can still reason ("the same address appears in the test and in the fixture") and every
// placeholder it echoes back is turned into the real value before the user ever sees it. A
// one-way hash would be safer and useless: the answer would be full of hashes.
//
// The vault lives in memory, dies with the session, and is never serialised. Nothing on disk maps
// a placeholder to a value — an audit log records that a redaction happened, not what it hid.

import type { FindingKind } from "./types.js";

const LABEL: Record<FindingKind, string> = {
  secret: "SECRET",
  identity: "IDENT",
  infra: "HOST",
  path: "USER",
  term: "TERM",
};

// Per-rule labels read better in a prompt than a single generic one: a model handles `⟨EMAIL_1⟩`
// far better than `⟨IDENT_1⟩` because the placeholder still carries the type.
const RULE_LABEL: Record<string, string> = {
  email: "EMAIL",
  phone: "PHONE",
  ipv4: "IP",
  ipv6: "IP6",
  "mac-address": "MAC",
  "internal-host": "HOST",
  "unix-home": "USER",
  "windows-home": "USER",
  "custom-term": "TERM",
};

export class Vault {
  private readonly byValue = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /** Stable placeholder for a value. Same value → same placeholder, for the vault's lifetime. */
  placeholderFor(value: string, kind: FindingKind, rule: string): string {
    const existing = this.byValue.get(value);
    if (existing) return existing;
    const label = RULE_LABEL[rule] ?? LABEL[kind];
    const n = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, n);
    const placeholder = `⟨${label}_${n}⟩`;
    this.byValue.set(value, placeholder);
    this.byPlaceholder.set(placeholder, value);
    return placeholder;
  }

  /** Put the real values back into text that came out of a model. */
  restore(text: string): string {
    if (!this.byPlaceholder.size) return text;
    return text.replace(/⟨[A-Z0-9]+_\d+⟩/g, (m) => this.byPlaceholder.get(m) ?? m);
  }

  get size(): number {
    return this.byPlaceholder.size;
  }

  /** For the egress preview: what was hidden, by category, never the values. */
  summary(): Array<{ label: string; count: number }> {
    return [...this.counters.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.counters.clear();
  }
}

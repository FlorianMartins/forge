// What the redaction pipeline knows about a piece of text before it may leave the machine.

/** Every category the detectors can recognise. Ordered from "never send" to "context noise". */
export type FindingKind =
  | "secret" // credentials, tokens, private keys — never leave, even redacted
  | "identity" // people: e-mail addresses, phone numbers, user names in paths
  | "infra" // machines: hostnames, IP addresses, internal URLs
  | "path" // filesystem layout that leaks a user or a company
  | "term"; // organisation-specific words the operator listed (client names, codenames)

export interface Finding {
  kind: FindingKind;
  /** Detector that produced this, for the audit log and for tests. */
  rule: string;
  start: number;
  end: number;
  value: string;
  /** Placeholder that replaced it, e.g. `⟨EMAIL_1⟩`. */
  placeholder: string;
}

export type RedactionLevel = "strict" | "balanced" | "off";

export interface RedactionPolicy {
  level: RedactionLevel;
  /** Extra words to always replace (company, client, codename). Case-insensitive, whole word. */
  customTerms: string[];
  /** Hard refusal: a secret found in text bound for a remote provider aborts the request. */
  blockOnSecret: boolean;
}

export const DEFAULT_POLICY: RedactionPolicy = {
  level: "strict",
  customTerms: [],
  blockOnSecret: true,
};

/** Which kinds a level acts on. `off` still catches secrets: that one is not a preference. */
export function kindsFor(level: RedactionLevel): Set<FindingKind> {
  switch (level) {
    case "strict":
      return new Set<FindingKind>(["secret", "identity", "infra", "path", "term"]);
    case "balanced":
      return new Set<FindingKind>(["secret", "identity", "term"]);
    case "off":
      return new Set<FindingKind>(["secret"]);
  }
}

// The gate every remote request passes through, and the record of the ones that did.
//
// An enterprise evaluating an AI assistant asks two questions: what leaves, and can we prove it.
// Most tools answer with a privacy policy. This one answers with a gate the user can inspect
// before the first byte moves, and a ledger they can read afterwards.
//
// The gate does four things, in this order, because each one can stop the next:
//   1. BLOCK  — a path matching a blocked glob is not sent, at all, whatever else is configured.
//   2. REDACT — reversible pseudonymisation of everything else.
//   3. REFUSE — a credential that survives redaction stops the request. Redaction removes it, so
//               reaching this point means something was shaped like a secret and could not be
//               replaced safely; sending it anyway is not a choice worth offering.
//   4. CONSENT— the user sees a summary of what is about to leave, once per session or every time.
//
// The ledger records metadata only: when, where to, which model, how many tokens, what it cost,
// how many placeholders were substituted. Never content. A log of what you were trying to keep
// private is not a privacy feature.

import * as vscode from "vscode";
import { redactMessages, Vault, type Finding } from "../core/redaction/index.js";
import type { ChatMessage } from "../core/providers/types.js";
import { Budget, type SpendStore, type Spend } from "../core/router/budget.js";
import { isBlockedPath, matchGlob } from "../core/util/glob.js";
import { estimateMessageTokens } from "../core/util/tokens.js";
import { redactionPolicy, type Settings } from "./config.js";

export interface EgressRecord {
  at: number;
  provider: string;
  host: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  usd: number;
  redactions: number;
  /** Kinds only — `EMAIL x3, HOST x1` — never the values. */
  redactionSummary: string;
}

const LEDGER_KEY = "hiveyForge.egress.ledger";
const SPEND_KEY = "hiveyForge.spend";
const CONSENT_KEY = "hiveyForge.consent";
const LEDGER_MAX = 500;

export class WorkspaceSpendStore implements SpendStore {
  constructor(private readonly memento: vscode.Memento) {}
  read(): Spend | undefined {
    return this.memento.get<Spend>(SPEND_KEY);
  }
  write(s: Spend): void {
    void this.memento.update(SPEND_KEY, s);
  }
}

export interface PreparedRequest {
  messages: ChatMessage[];
  vault: Vault;
  findings: Finding[];
  estimatedTokens: number;
}

export class EgressGate {
  private readonly consented = new Set<string>();

  constructor(
    private readonly state: vscode.Memento,
    readonly budget: Budget,
  ) {}

  /** Is this path one the operator declared off-limits for remote providers? */
  static isBlocked(path: string, globs: string[]): boolean {
    return isBlockedPath(path, globs);
  }

  /**
   * Redact, refuse, and ask. Returns undefined when the request must not happen; the reason has
   * already been shown to the user.
   */
  async prepare(
    messages: ChatMessage[],
    settings: Settings,
    target: { provider: string; model: string; baseUrl: string; isLocal: boolean },
    vault = new Vault(),
  ): Promise<PreparedRequest | undefined> {
    // Local endpoints skip the whole gate: redacting text that never leaves the machine costs
    // answer quality and buys nothing.
    if (target.isLocal) {
      return { messages, vault, findings: [], estimatedTokens: estimateMessageTokens(messages) };
    }

    const { messages: redacted, findings, hasSecret } = redactMessages(messages, vault, redactionPolicy(settings));

    if (hasSecret) {
      const proceed = await vscode.window.showWarningMessage(
        `Hivey Forge : ce que vous êtes sur le point d'envoyer contient ${findings.filter((f) => f.kind === "secret").length} élément(s) ressemblant à un secret. Ils ont été remplacés par des marqueurs, mais rien ne remplace une relecture.`,
        { modal: true },
        "Envoyer (marqueurs en place)",
        "Annuler",
      );
      if (proceed !== "Envoyer (marqueurs en place)") return undefined;
    }

    const estimatedTokens = estimateMessageTokens(redacted);
    if (!(await this.consent(settings, target, findings, estimatedTokens))) return undefined;

    return { messages: redacted, vault, findings, estimatedTokens };
  }

  private async consent(
    settings: Settings,
    target: { provider: string; model: string; baseUrl: string },
    findings: Finding[],
    tokens: number,
  ): Promise<boolean> {
    const policy = settings.privacy.egressPolicy;
    if (policy === "trust") return true;
    const host = safeHost(target.baseUrl);
    const key = `${host}|${target.model}`;
    if (policy === "ask-once" && (this.consented.has(key) || this.state.get<string[]>(CONSENT_KEY, []).includes(key))) {
      return true;
    }

    const summary = summarise(findings);
    const answer = await vscode.window.showInformationMessage(
      `Hivey Forge va envoyer ~${tokens} jetons à ${host} (${target.model}).` +
        (summary ? ` Anonymisé : ${summary}.` : " Aucune donnée sensible détectée."),
      { modal: true },
      "Envoyer",
      "Voir ce qui part",
      "Annuler",
    );
    if (answer === "Voir ce qui part") return false; // the preview command shows it; the user re-sends
    if (answer !== "Envoyer") return false;

    if (policy === "ask-once") {
      this.consented.add(key);
      const stored = this.state.get<string[]>(CONSENT_KEY, []);
      if (!stored.includes(key)) void this.state.update(CONSENT_KEY, [...stored, key]);
    }
    return true;
  }

  /** Called after a remote call completed. */
  record(entry: EgressRecord, settings: Settings): void {
    this.budget.record(entry.usd);
    if (!settings.privacy.auditLog) return;
    const ledger = this.state.get<EgressRecord[]>(LEDGER_KEY, []);
    ledger.unshift(entry);
    void this.state.update(LEDGER_KEY, ledger.slice(0, LEDGER_MAX));
  }

  ledger(): EgressRecord[] {
    return this.state.get<EgressRecord[]>(LEDGER_KEY, []);
  }

  clearLedger(): void {
    void this.state.update(LEDGER_KEY, []);
  }

  forgetConsent(): void {
    this.consented.clear();
    void this.state.update(CONSENT_KEY, []);
  }
}

export function summarise(findings: Finding[]): string {
  if (!findings.length) return "";
  const counts = new Map<string, number>();
  for (const f of findings) {
    const label = f.placeholder.replace(/[⟨⟩]/g, "").replace(/_\d+$/, "");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
}

export { matchGlob };

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// A conversation, and the one idea that makes it controllable: THE TRANSCRIPT IS NOT THE PROMPT.
//
// Every assistant that grew out of a chat window sends the whole history on every turn, and the
// user's only lever is "new conversation". That is expensive (the history is re-billed each turn)
// and imprecise (one bad answer keeps poisoning the next ten). Here the transcript is a log the
// user owns, and what the model sees is DERIVED from it on every turn:
//
//   • drop      — the exchange leaves the transcript for good;
//   • exclude   — the exchange stays visible to the user and stops being sent to the model. This
//                 is the sidebar behaviour we keep: a wrong answer can be muted without losing
//                 the trail of what was tried;
//   • pin       — the exchange survives context trimming when the budget gets tight.
//
// Excluding is not cosmetic: it is the cheapest and most direct control anyone has over both the
// quality and the price of the next turn.

import type { ChatMessage } from "../providers/types.js";
import { estimateTokens } from "../util/tokens.js";

export type EntryRole = "user" | "assistant";

export interface ContextItem {
  /** `file`, `selection`, `terminal`, `diff`, `url`, `symbol`… */
  kind: string;
  /** Display label: `src/app.ts:12-48`. */
  label: string;
  /** The actual text handed to the model. */
  body: string;
  /** Content the user did not write (a page, a log, a dependency) is fenced as untrusted. */
  untrusted?: boolean;
}

export interface Entry {
  id: string;
  role: EntryRole;
  text: string;
  at: number;
  /** Attachments the user added to this turn. */
  context?: ContextItem[];
  /** False when the user muted this exchange: kept on screen, not sent to the model. */
  included: boolean;
  /** Survives automatic trimming. */
  pinned?: boolean;
  model?: string;
  usdCost?: number;
  /** Set on an assistant entry that failed, so it is never replayed as if it were an answer. */
  error?: string;
}

export interface SessionData {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: Entry[];
}

export interface BuildOptions {
  systemPrompt: string;
  /** Token budget for the whole request, attachments included. */
  maxTokens: number;
  /** Repository map and other ambient context, sent once as a cacheable prefix. */
  ambient?: string;
  /** Per-turn nonce for the untrusted fence. */
  nonce: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** Entries left out because the budget ran out — the UI says so rather than silently forgetting. */
  trimmed: string[];
  estimatedTokens: number;
}

let counter = 0;
/** Ids are local and ordered; nothing about them needs to be unguessable. */
export function newId(prefix = "e"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export class Session {
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  entries: Entry[];

  constructor(data?: Partial<SessionData>) {
    this.id = data?.id ?? newId("s");
    this.title = data?.title ?? "";
    this.createdAt = data?.createdAt ?? Date.now();
    this.updatedAt = data?.updatedAt ?? this.createdAt;
    this.entries = data?.entries ?? [];
  }

  add(entry: Omit<Entry, "id" | "at" | "included"> & Partial<Pick<Entry, "id" | "at" | "included">>): Entry {
    const e: Entry = {
      id: entry.id ?? newId(),
      at: entry.at ?? Date.now(),
      included: entry.included ?? true,
      ...entry,
    } as Entry;
    this.entries.push(e);
    this.updatedAt = e.at;
    // The first thing the user said names the conversation until something better is generated.
    if (!this.title && e.role === "user") this.title = e.text.trim().split("\n")[0]!.slice(0, 60);
    return e;
  }

  get(id: string): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Remove an exchange for good. Removing a question removes the answer that belongs to it. */
  drop(id: string): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    const isUser = this.entries[i]!.role === "user";
    const followsAnswer = isUser && this.entries[i + 1]?.role === "assistant";
    this.entries.splice(i, followsAnswer ? 2 : 1);
    this.updatedAt = Date.now();
  }

  /** Mute or unmute an exchange. A question and its answer are muted together. */
  setIncluded(id: string, included: boolean): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.entries[i]!.included = included;
    const next = this.entries[i + 1];
    if (this.entries[i]!.role === "user" && next?.role === "assistant") next.included = included;
    const prev = this.entries[i - 1];
    if (this.entries[i]!.role === "assistant" && prev?.role === "user") prev.included = included;
    this.updatedAt = Date.now();
  }

  setPinned(id: string, pinned: boolean): void {
    const e = this.get(id);
    if (!e) return;
    e.pinned = pinned;
    this.updatedAt = Date.now();
  }

  /** Editing a question drops everything after it: the answers were about the old wording. */
  editUserEntry(id: string, text: string): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0 || this.entries[i]!.role !== "user") return;
    this.entries[i]!.text = text;
    this.entries.splice(i + 1);
    this.updatedAt = Date.now();
  }

  /** Drop the last answer so the same question can be asked again. */
  dropLastAnswer(): void {
    const last = this.entries[this.entries.length - 1];
    if (last?.role === "assistant") this.entries.pop();
  }

  totalCostUsd(): number {
    return this.entries.reduce((s, e) => s + (e.usdCost ?? 0), 0);
  }

  toJSON(): SessionData {
    return { id: this.id, title: this.title, createdAt: this.createdAt, updatedAt: this.updatedAt, entries: this.entries };
  }

  /**
   * Build the request. Order of operations matters: the system prompt and the ambient context go
   * first and are marked cacheable (a stable prefix is what a provider's prompt cache can reuse),
   * then the included entries, newest last. When the budget is short, muted entries are already
   * gone, unpinned old ones go next, and what was dropped is reported rather than hidden.
   */
  build(opts: BuildOptions): BuiltPrompt {
    const messages: ChatMessage[] = [{ role: "system", content: opts.systemPrompt, cacheable: true }];
    if (opts.ambient) {
      messages.push({ role: "user", content: opts.ambient, cacheable: true });
      messages.push({ role: "assistant", content: "Understood — I have the repository map." });
    }

    const included = this.entries.filter((e) => e.included && !e.error);
    const rendered = included.map((e) => ({ entry: e, text: renderEntry(e, opts.nonce) }));

    let budget = opts.maxTokens - estimateTokens(opts.systemPrompt) - estimateTokens(opts.ambient ?? "");
    const keep: typeof rendered = [];
    const trimmed: string[] = [];
    // Walk backwards: the newest turns are the ones the answer depends on.
    for (let i = rendered.length - 1; i >= 0; i--) {
      const r = rendered[i]!;
      const cost = estimateTokens(r.text) + 4;
      if (cost <= budget || r.entry.pinned) {
        budget -= cost;
        keep.unshift(r);
      } else {
        trimmed.push(r.entry.id);
      }
    }

    for (const r of keep) messages.push({ role: r.entry.role, content: r.text });

    return {
      messages,
      trimmed,
      estimatedTokens: messages.reduce((s, m) => s + estimateTokens(m.content) + 4, 0),
    };
  }
}

/**
 * Attachments are rendered as their own fenced block carrying a per-turn nonce, never
 * concatenated into the user's sentence. The reason is the sidebar's hard-won one: a file, a log
 * or a web page is written by someone else, and if it lands in the same channel as the user's
 * instruction then anything it contains reads as an instruction. A fence whose delimiter the
 * content cannot guess keeps "the user said this" and "I read this" apart by construction.
 */
export function renderEntry(e: Entry, nonce: string): string {
  if (!e.context?.length) return e.text;
  const blocks = e.context.map((c) => {
    const head = `[${c.kind}] ${c.label}`;
    if (!c.untrusted) return `${head}\n${c.body}`;
    const body = c.body.split(`⟦${nonce}`).join("⟦removed-fence");
    return `${head}\n⟦${nonce}:begin⟧\n${body}\n⟦${nonce}:end⟧`;
  });
  return `${e.text}\n\n--- attached context ---\n${blocks.join("\n\n")}`;
}

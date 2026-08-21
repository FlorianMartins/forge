// Searching and filtering the conversations, as pure functions over the stored sessions.
//
// It lives in core rather than in the panel for the usual reason — it is behaviour, and behaviour
// gets tested — but also because the terminal client wants the same `/chercher` one day, and a
// second implementation would drift from this one within a month.

import type { SessionData } from "./session.js";
import type { Mode } from "./modes.js";

export type Period = "all" | "today" | "week" | "month";
export type SortKey = "updated" | "created" | "messages" | "cost";

export interface HistoryFilter {
  /** Free text, matched against the title AND the body of every message. */
  query?: string;
  period?: Period;
  mode?: Mode | "all";
  /** Only conversations that cost something — the ones worth reviewing at the end of a month. */
  paidOnly?: boolean;
  sort?: SortKey;
}

export interface HistoryRow {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messages: number;
  usdCost: number;
  mode: Mode;
  /** The matching fragment, when the row was found by its content rather than by its title. */
  excerpt?: string;
}

export function summarise(session: SessionData): HistoryRow {
  return {
    id: session.id,
    title: session.title || "(sans titre)",
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messages: session.entries.length,
    usdCost: session.entries.reduce((sum, e) => sum + (e.usdCost ?? 0), 0),
    mode: (session.mode ?? "agent") as Mode,
  };
}

function periodStart(period: Period, now: number): number {
  const d = new Date(now);
  switch (period) {
    case "today":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case "week":
      return now - 7 * 86_400_000;
    case "month":
      return now - 30 * 86_400_000;
    case "all":
      return 0;
  }
}

/** Case- and accent-insensitive, because nobody types "déployé" the same way twice. */
export function normalise(text: string): string {
  return text
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function filterHistory(sessions: SessionData[], filter: HistoryFilter = {}, now = Date.now()): HistoryRow[] {
  const query = filter.query?.trim() ? normalise(filter.query.trim()) : "";
  const from = periodStart(filter.period ?? "all", now);

  const rows: HistoryRow[] = [];
  for (const session of sessions) {
    if (session.updatedAt < from) continue;
    if (filter.mode && filter.mode !== "all" && (session.mode ?? "agent") !== filter.mode) continue;

    const row = summarise(session);
    if (filter.paidOnly && row.usdCost <= 0) continue;

    if (query) {
      if (!normalise(row.title).includes(query)) {
        // Not in the title: look inside, and keep the fragment so the user sees WHY it matched.
        const hit = session.entries.find((e) => normalise(e.text).includes(query));
        if (!hit) continue;
        row.excerpt = excerptAround(hit.text, filter.query!.trim());
      }
    }
    rows.push(row);
  }

  const sort = filter.sort ?? "updated";
  rows.sort((a, b) => {
    switch (sort) {
      case "created":
        return b.createdAt - a.createdAt;
      case "messages":
        return b.messages - a.messages;
      case "cost":
        return b.usdCost - a.usdCost;
      case "updated":
      default:
        return b.updatedAt - a.updatedAt;
    }
  });
  return rows;
}

/** ~120 characters around the match, so a result reads as a sentence rather than as a word. */
export function excerptAround(text: string, query: string, radius = 60): string {
  const at = normalise(text).indexOf(normalise(query));
  if (at < 0) return text.slice(0, radius * 2).replace(/\s+/g, " ");
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/** Matches inside the open conversation: which entries, and where in each. */
export interface Match {
  entryId: string;
  count: number;
}

export function searchTranscript(session: SessionData, query: string): Match[] {
  const q = normalise(query.trim());
  if (!q) return [];
  const out: Match[] = [];
  for (const entry of session.entries) {
    const haystack = normalise(entry.text);
    let count = 0;
    let at = haystack.indexOf(q);
    while (at >= 0) {
      count++;
      at = haystack.indexOf(q, at + q.length);
    }
    if (count) out.push({ entryId: entry.id, count });
  }
  return out;
}

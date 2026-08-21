// Prices, in USD per million tokens. The catalogue is refreshed from OpenRouter by
// `scripts/update-models.mjs` (a scheduled workflow commits the diff), so no version or price is
// ever hard-coded by hand in this repository — the lesson from the sidebar's model catalogue.
//
// The table below is only the FALLBACK used before the first refresh, and to price the providers
// OpenRouter does not list. A model that is absent is priced as 0 and reported as "unknown"
// rather than guessed: a wrong price silently spends someone's budget.

export interface Price {
  in: number; // USD per 1M input tokens
  out: number; // USD per 1M output tokens
  cachedIn?: number; // USD per 1M tokens served from the provider's prompt cache
}

export const FALLBACK_PRICES: Record<string, Price> = {
  // Local inference costs electricity, not tokens.
  "local:*": { in: 0, out: 0 },
};

export interface PriceLookup {
  (model: string): Price | undefined;
}

/** Cheap-first lookup: exact id, then vendor-prefixed id, then a `vendor/*` wildcard. */
export function makeLookup(table: Record<string, Price>): PriceLookup {
  return (model: string) => {
    if (table[model]) return table[model];
    const slash = model.indexOf("/");
    if (slash > 0) {
      const bare = model.slice(slash + 1);
      if (table[bare]) return table[bare];
      const wildcard = `${model.slice(0, slash)}/*`;
      if (table[wildcard]) return table[wildcard];
    }
    return undefined;
  };
}

export interface CostBreakdown {
  usd: number;
  known: boolean;
  /** What the same call would have cost without the prompt cache — used to show the saving. */
  usdWithoutCache: number;
}

export function costOf(
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; costUsd?: number },
  price: Price | undefined,
): CostBreakdown {
  // A provider that reports its own cost is always right; an estimate never overrules a fact.
  if (typeof usage.costUsd === "number") {
    return { usd: usage.costUsd, known: true, usdWithoutCache: usage.costUsd };
  }
  if (!price) return { usd: 0, known: false, usdWithoutCache: 0 };
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens);
  const cachedRate = price.cachedIn ?? price.in * 0.1;
  const usd = (fresh * price.in + usage.cachedTokens * cachedRate + usage.completionTokens * price.out) / 1_000_000;
  const usdWithoutCache = (usage.promptTokens * price.in + usage.completionTokens * price.out) / 1_000_000;
  return { usd, known: true, usdWithoutCache };
}

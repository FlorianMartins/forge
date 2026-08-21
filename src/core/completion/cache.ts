// Two caches, because a coding assistant asks the same question constantly.
//
// EXACT: the same cursor context asked twice — undo/redo, moving the caret away and back, a
// re-render of the inline provider (VS Code calls it more often than a user types). A hash map
// answers those in microseconds.
//
// TYPED-THROUGH: the far more valuable one. The user accepted nothing, but typed the first
// characters of what was suggested. The remainder of that suggestion is still the answer, so the
// completion continues to display with NO request at all. On a local model this saves latency; on
// a remote one it is the difference between one request per keystroke and one per idea. Copilot
// does this too — it is the single reason a hosted assistant is affordable at all.

export interface CacheEntry {
  completion: string;
  at: number;
}

export class CompletionCache {
  private readonly map = new Map<string, CacheEntry>();
  private last?: { prefix: string; suffix: string; completion: string };

  constructor(
    private readonly maxEntries = 200,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static key(model: string, prefix: string, suffix: string): string {
    // Only the neighbourhood of the cursor decides a completion; hashing whole files would make
    // every keystroke elsewhere in the buffer a cache miss.
    return `${model} ${prefix.slice(-1200)} ${suffix.slice(0, 400)}`;
  }

  get(model: string, prefix: string, suffix: string): string | undefined {
    const key = CompletionCache.key(model, prefix, suffix);
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Refresh recency: a Map preserves insertion order, so delete+set is a working LRU.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.completion;
  }

  set(model: string, prefix: string, suffix: string, completion: string): void {
    const key = CompletionCache.key(model, prefix, suffix);
    this.map.set(key, { completion, at: this.now() });
    this.last = { prefix, suffix, completion };
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /**
   * The user typed some of the previous suggestion. Return what is left of it, or undefined if
   * they diverged. `undefined` is the signal to ask the model again.
   */
  continuation(prefix: string, suffix: string): string | undefined {
    const l = this.last;
    if (!l || !l.completion) return undefined;
    if (!prefix.startsWith(l.prefix)) return undefined;
    const typed = prefix.slice(l.prefix.length);
    if (typed.length === 0) return l.suffix === suffix ? l.completion : undefined;
    if (typed.length >= l.completion.length) return undefined;
    if (!l.completion.startsWith(typed)) return undefined; // diverged: the suggestion is dead
    const rest = l.completion.slice(typed.length);
    return rest.length ? rest : undefined;
  }

  /** Called when the user rejects a suggestion or the document changes structurally. */
  forgetLast(): void {
    this.last = undefined;
  }

  get size(): number {
    return this.map.size;
  }
}

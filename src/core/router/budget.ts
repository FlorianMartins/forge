// The spending guard. Two limits, because they catch different accidents:
//
//   • per request — one runaway prompt (a pasted 200 k-token log, an agent loop that re-reads a
//     build directory) cannot cost more than a coffee. Checked BEFORE the call, on an estimate.
//   • per day — the sum of many reasonable calls. Checked before the call, on facts recorded
//     after previous ones.
//
// The ledger is injected rather than owned, so the core stays free of any VS Code or filesystem
// API and the tests can run a whole day of spending in a millisecond.

export interface Spend {
  day: string; // YYYY-MM-DD, local time: a developer's day, not UTC's
  usd: number;
  calls: number;
}

export interface SpendStore {
  read(): Spend | undefined;
  write(s: Spend): void;
}

export class MemorySpendStore implements SpendStore {
  private value: Spend | undefined;
  read(): Spend | undefined {
    return this.value;
  }
  write(s: Spend): void {
    this.value = s;
  }
}

export interface BudgetLimits {
  perRequestUsd: number;
  dailyUsd: number; // 0 = no limit
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: "per-request" | "daily"; message: string };

export class Budget {
  constructor(
    private readonly store: SpendStore,
    private limits: BudgetLimits,
    private readonly today: () => string = defaultToday,
  ) {}

  setLimits(limits: BudgetLimits): void {
    this.limits = limits;
  }

  spentToday(): number {
    const s = this.store.read();
    return s && s.day === this.today() ? s.usd : 0;
  }

  callsToday(): number {
    const s = this.store.read();
    return s && s.day === this.today() ? s.calls : 0;
  }

  /** Called before a remote request, with the estimated cost. Local calls never come here. */
  check(estimatedUsd: number): BudgetVerdict {
    if (this.limits.perRequestUsd > 0 && estimatedUsd > this.limits.perRequestUsd) {
      return {
        ok: false,
        reason: "per-request",
        message: `estimated $${estimatedUsd.toFixed(3)} exceeds the per-request cap of $${this.limits.perRequestUsd.toFixed(2)}`,
      };
    }
    if (this.limits.dailyUsd > 0 && this.spentToday() + estimatedUsd > this.limits.dailyUsd) {
      return {
        ok: false,
        reason: "daily",
        message: `today's spend $${this.spentToday().toFixed(3)} + $${estimatedUsd.toFixed(3)} exceeds the daily cap of $${this.limits.dailyUsd.toFixed(2)}`,
      };
    }
    return { ok: true };
  }

  /** Called after a remote request, with what it really cost. */
  record(usd: number): void {
    const day = this.today();
    const cur = this.store.read();
    const base = cur && cur.day === day ? cur : { day, usd: 0, calls: 0 };
    this.store.write({ day, usd: base.usd + usd, calls: base.calls + 1 });
  }
}

function defaultToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Who is allowed to do what, and how a "yes" is remembered.
//
// Approving every read of every file is how a permission system trains people to click yes without
// looking — at which point it protects nobody. So the model here has three levels, and the middle
// one is the point:
//
//   ask     — the default for anything that changes the machine. A dialog, every time.
//   session — "yes, and stop asking for this tool until I close the conversation". Remembered in
//             memory only; a new session starts cautious again.
//   always  — written to disk. Reserved for what the user deliberately trusts, per tool AND, for
//             commands, per prefix: trusting `npm test` must not trust `npm publish`.
//   never   — refuse without asking. Useful for locking down a shared machine.
//
// The rule that makes this safe: a decision is stored against the SHAPE of the action, never
// against one occurrence of it. `write_file` trusted once is `write_file` trusted for the paths the
// policy allows, and nothing else.

export type Level = "ask" | "session" | "always" | "never";

export interface Rule {
  tool: string;
  /** For run_command: the first words of the command, e.g. `npm test`. Empty = the whole tool. */
  prefix?: string;
  level: Exclude<Level, "ask">;
}

export interface PermissionStore {
  read(): Rule[];
  write(rules: Rule[]): void;
}

export class MemoryPermissionStore implements PermissionStore {
  private rules: Rule[] = [];
  read(): Rule[] {
    return this.rules;
  }
  write(rules: Rule[]): void {
    this.rules = rules;
  }
}

/** The command prefix a rule is keyed on: the binary and its first subcommand. */
export function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  // `npm run test` is a different intent from `npm publish`, so two words carry the meaning; a
  // bare `ls` keeps one.
  return words.slice(0, words[0] === "npm" || words[0] === "yarn" || words[0] === "pnpm" || words[0] === "git" ? 2 : 1).join(" ");
}

export class Permissions {
  private readonly sessionGrants = new Set<string>();

  constructor(private readonly store: PermissionStore) {}

  private static key(tool: string, prefix?: string): string {
    return prefix ? `${tool}:${prefix}` : tool;
  }

  /** What happens if this action is attempted now. */
  decide(tool: string, args: Record<string, unknown>): Level {
    const prefix = tool === "run_command" ? commandPrefix(String(args["command"] ?? "")) : undefined;
    const rules = this.store.read();

    // A "never" always wins, whatever else matches: refusing is the safe direction.
    const exact = rules.find((r) => r.tool === tool && (r.prefix ?? "") === (prefix ?? ""));
    const broad = rules.find((r) => r.tool === tool && !r.prefix);
    if (exact?.level === "never" || broad?.level === "never") return "never";
    if (exact?.level === "always" || broad?.level === "always") return "always";
    if (this.sessionGrants.has(Permissions.key(tool, prefix)) || this.sessionGrants.has(Permissions.key(tool))) {
      return "session";
    }
    return "ask";
  }

  /** True when the action may run without asking. */
  allows(tool: string, args: Record<string, unknown>): boolean {
    const level = this.decide(tool, args);
    return level === "always" || level === "session";
  }

  /** Remember an answer. `scope` says how long. */
  remember(tool: string, args: Record<string, unknown>, scope: "session" | "always" | "never", broaden = false): void {
    const prefix = !broaden && tool === "run_command" ? commandPrefix(String(args["command"] ?? "")) : undefined;
    if (scope === "session") {
      this.sessionGrants.add(Permissions.key(tool, prefix));
      return;
    }
    const rules = this.store.read().filter((r) => !(r.tool === tool && (r.prefix ?? "") === (prefix ?? "")));
    rules.push({ tool, ...(prefix ? { prefix } : {}), level: scope });
    this.store.write(rules);
  }

  forget(tool: string, prefix?: string): void {
    this.store.write(this.store.read().filter((r) => !(r.tool === tool && (r.prefix ?? "") === (prefix ?? ""))));
    this.sessionGrants.delete(Permissions.key(tool, prefix));
  }

  clearSession(): void {
    this.sessionGrants.clear();
  }

  rules(): Rule[] {
    return [...this.store.read()];
  }

  /** Rules granted for this session only — shown separately so nothing looks permanent by mistake. */
  sessionRules(): string[] {
    return [...this.sessionGrants];
  }
}

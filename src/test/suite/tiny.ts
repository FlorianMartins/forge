// A test runner in forty lines, because the alternative pulled in a hundred packages and a
// high-severity advisory — in a repository whose fourth architecture decision is "no dependency we
// do not need". The extension-host suite has seven tests; this is all they need.

type Fn = () => void | Promise<void>;

interface Case {
  name: string;
  fn: Fn;
  timeoutMs: number;
}

const cases: Case[] = [];
let currentSuite = "";

export function suite(name: string, body: () => void): void {
  currentSuite = name;
  body();
  currentSuite = "";
}

export function test(name: string, fn: Fn, timeoutMs = 30_000): void {
  cases.push({ name: currentSuite ? `${currentSuite} · ${name}` : name, fn, timeoutMs });
}

export async function runAll(): Promise<void> {
  let failed = 0;
  const started = Date.now();
  for (const c of cases) {
    const t0 = Date.now();
    try {
      await withTimeout(c.fn(), c.timeoutMs, c.name);
      console.log(`  ✔ ${c.name} (${Date.now() - t0}ms)`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${c.name}\n      ${(err as Error).stack ?? (err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed} passing, ${failed} failing (${Math.round((Date.now() - started) / 1000)}s)`);
  if (failed) throw new Error(`${failed} test(s) failed`);
}

function withTimeout(value: void | Promise<void>, ms: number, name: string): Promise<void> {
  if (!(value instanceof Promise)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${name}`)), ms);
    value.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

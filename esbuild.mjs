// Build script. Three outputs, one bundler, no plugin:
//   dist/extension.js   — the extension host (CommonJS, `vscode` left external)
//   media/webview.js    — the discussion panel (IIFE, runs in the webview sandbox)
//   dist-tests/*.js     — the test files, so `node --test` can run TypeScript sources
//
// The extension ships ZERO runtime dependency: everything under src/ is our own code and the
// bundle is auditable by an enterprise before install. esbuild/typescript are dev-only.
import { build, context } from "esbuild";
import { readdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const prod = process.argv.includes("--prod");

const common = {
  bundle: true,
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
  target: "node18",
};

const targets = tests
  ? [
      {
        ...common,
        entryPoints: readdirSync("tests")
          .filter((f) => f.endsWith(".test.ts"))
          .map((f) => `tests/${f}`),
        outdir: "dist-tests",
        platform: "node",
        format: "cjs",
        sourcemap: false,
      },
    ]
  : [
      {
        ...common,
        entryPoints: ["src/extension/extension.ts"],
        outfile: "dist/extension.js",
        platform: "node",
        format: "cjs",
        external: ["vscode"],
      },
      {
        ...common,
        entryPoints: ["src/webview/main.ts"],
        outfile: "media/webview.js",
        platform: "browser",
        format: "iife",
      },
    ];

for (const t of targets) {
  if (watch) {
    const ctx = await context(t);
    await ctx.watch();
  } else {
    await build(t);
  }
}
if (watch) console.log("[hivey-forge] veille active");

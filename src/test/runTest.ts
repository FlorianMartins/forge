// Downloads a real VS Code, launches it headless with this extension loaded, and runs the suite in
// `suite/`. It is the only test that proves `activate()` works: everything else runs in Node, where
// a missing contribution point or a bad activation event cannot fail.

import { runTests } from "@vscode/test-electron";
import { resolve } from "node:path";

async function main(): Promise<void> {
  try {
    await runTests({
      extensionDevelopmentPath: resolve(__dirname, "../../"),
      extensionTestsPath: resolve(__dirname, "./suite/index.js"),
      // No workspace, no telemetry, no other extension: whatever fails here is ours.
      launchArgs: [
        "--disable-extensions",
        "--disable-gpu",
        "--disable-telemetry",
        // FORGE_LOCALE=fr runs the whole suite in a French editor, which is the only way to prove
        // the translation reaches a real user rather than only a unit test.
        ...(process.env["FORGE_LOCALE"] ? ["--locale", process.env["FORGE_LOCALE"]] : []),
      ],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();

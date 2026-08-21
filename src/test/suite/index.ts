import { runAll } from "./tiny.js";
import "./extension.test.js";

export function run(): Promise<void> {
  return runAll();
}

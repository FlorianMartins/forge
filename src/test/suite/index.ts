import Mocha from "mocha";
import { resolve } from "node:path";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30_000 });
  mocha.addFile(resolve(__dirname, "./extension.test.js"));
  return new Promise((res, rej) => {
    mocha.run((failures) => (failures ? rej(new Error(`${failures} test(s) failed`)) : res()));
  });
}

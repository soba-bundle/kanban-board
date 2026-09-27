import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [, , role, stateFile] = process.argv;
appendFileSync(stateFile, `${JSON.stringify({ role, pid: process.pid, ppid: process.ppid })}\n`);
const childRole = role === "root" ? "compiler" : role === "compiler" ? "test-runner" : undefined;
if (childRole) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), childRole, stateFile], {
    stdio: "ignore",
    windowsHide: true,
  });
}
setInterval(() => {}, 1000);

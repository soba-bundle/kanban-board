import { execFile } from "node:child_process";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandOptions {
  cwd: string;
  timeoutMs?: number;
}

export function runGit(args: string[], options: GitCommandOptions): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }

        const exitCode = typeof error.code === "number" ? error.code : 1;
        if (error.code === "ETIMEDOUT" || error.killed) {
          reject(new Error(`Git command timed out after ${options.timeoutMs ?? 30_000}ms: git ${args.join(" ")}`));
          return;
        }
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

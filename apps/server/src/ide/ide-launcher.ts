import spawn from "cross-spawn";

export function openInIde(executable: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [path], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

import { spawn, type ChildProcess } from "node:child_process";

export const EXTERNAL_OPEN_COMMAND = "xdg-open";

export type SpawnExternal = (command: string, args: string[], options: { stdio: "ignore"; detached: true }) => ChildProcess;

/** Hand the URL to the OS browser. The client does not load the page or see what the user types. */
export function openExternal(url: string, spawnImpl: SpawnExternal = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(EXTERNAL_OPEN_COMMAND, [url], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

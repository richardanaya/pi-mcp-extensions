import { existsSync, readFileSync } from "node:fs";
import type { EngineCall } from "./task-engine.ts";

export async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function readTrace(path: string): EngineCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EngineCall];
      } catch {
        return [];
      }
    });
}

export function serverPath(): string {
  return new URL("./stdio-server.ts", import.meta.url).pathname;
}

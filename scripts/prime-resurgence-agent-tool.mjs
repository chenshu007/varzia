#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failureSummary, runPrimeResurgenceSync } from "./lib/prime-resurgence-sync.mjs";

export const AGENT_WORK = "/tmp/varzia-agent-work";

export function parseAgentToolArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--mode", "--now"].includes(flag) || options[flag.slice(2)] !== undefined) throw new Error("Expected --mode and --now exactly once.");
    options[flag.slice(2)] = argv[++i];
  }
  if (!["check", "update"].includes(options.mode)) throw new Error("Mode must be check or update.");
  if (!options.now || !Number.isFinite(Date.parse(options.now)) || new Date(options.now).toISOString() !== options.now) throw new Error("A frozen ISO verification time is required.");
  return options;
}

export async function runAgentTool({ mode, now, rootDir, workDir = AGENT_WORK, sync = runPrimeResurgenceSync }) {
  await mkdir(workDir, { recursive: true });
  try {
    const result = await sync({ rootDir, dryRun: mode === "check", now: new Date(now) });
    await writeFile(path.join(workDir, "sync-summary.md"), result.summary, "utf8");
    return { status: result.status, changedFiles: result.changedFiles };
  } catch (error) {
    await writeFile(path.join(workDir, "sync-summary.md"), failureSummary(error), "utf8");
    throw error;
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseAgentToolArguments(process.argv.slice(2));
    const result = await runAgentTool({ ...options, rootDir: fileURLToPath(new URL("../", import.meta.url)) });
    console.log(JSON.stringify(result));
  } catch {
    console.error(`Official verification failed; no review candidate is approved. Read ${AGENT_WORK}/sync-summary.md in the private runner.`);
    process.exitCode = 1;
  }
}

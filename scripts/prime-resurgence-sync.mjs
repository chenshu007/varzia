#!/usr/bin/env node

import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  failureSummary,
  runNearRotationWatcher,
  runPrimeResurgenceSync,
  SYNC_MUTABLE_DATA_PATHS
} from "./lib/prime-resurgence-sync.mjs";

function parseArguments(argv) {
  const options = { dryRun: false, summaryFile: "", prBodyFile: "", mode: "announcement" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--mode") options.mode = argv[++index] || "";
    else if (argument === "--summary-file") options.summaryFile = argv[++index] || "";
    else if (argument === "--pr-body-file") options.prBodyFile = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (argv.includes("--summary-file") && !options.summaryFile) throw new Error("--summary-file requires a path.");
  if (argv.includes("--pr-body-file") && !options.prBodyFile) throw new Error("--pr-body-file requires a path.");
  if (!["announcement", "near-rotation"].includes(options.mode)) throw new Error(`Unsupported --mode: ${options.mode || "missing"}.`);
  return options;
}

async function publishSummary(markdown, options) {
  if (options.summaryFile) await writeFile(options.summaryFile, markdown, "utf8");
  if (options.prBodyFile) await writeFile(options.prBodyFile, markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
}

function safeFailureSummary(error) {
  try {
    return failureSummary(error);
  } catch {
    return "## Prime Resurgence sync\n\n- Result: FAILED\n- Reason: The original failure could not be rendered safely.\n- Production data modification: none\n- Pull request: not created or updated\n\nFAIL / NO PRODUCTION DATA MODIFICATION / NO PR WITH PARTIAL DATA\n";
  }
}

async function reportFailure(error, options) {
  const summary = safeFailureSummary(error);
  try {
    await publishSummary(summary, options);
  } catch (publishError) {
    const detail = publishError instanceof Error && publishError.message ? publishError.message : "unknown summary publication failure";
    try {
      process.stderr.write(`Unable to publish failure summary: ${detail}\n`);
    } catch {
      // Keep the original failure as the process outcome even when stderr is unavailable.
    }
  }
  try {
    process.stderr.write(`${summary}\n`);
  } catch {
    // The process exit code below remains the authoritative outcome.
  }
  process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--print-managed-paths") {
    process.stdout.write(`${SYNC_MUTABLE_DATA_PATHS.join("\n")}\n`);
    return;
  }
  let options = { dryRun: false, summaryFile: "", prBodyFile: "", mode: "announcement" };
  try {
    options = parseArguments(argv);
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const run = options.mode === "near-rotation" ? runNearRotationWatcher : runPrimeResurgenceSync;
    const result = await run({ rootDir, dryRun: options.dryRun });
    await publishSummary(result.summary, options);
    process.stdout.write(result.summary);
  } catch (error) {
    await reportFailure(error, options);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node

import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  failureSummary,
  runPrimeResurgenceSync
} from "./lib/prime-resurgence-sync.mjs";

function parseArguments(argv) {
  const options = { dryRun: false, summaryFile: "", prBodyFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--summary-file") options.summaryFile = argv[++index] || "";
    else if (argument === "--pr-body-file") options.prBodyFile = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (argv.includes("--summary-file") && !options.summaryFile) throw new Error("--summary-file requires a path.");
  if (argv.includes("--pr-body-file") && !options.prBodyFile) throw new Error("--pr-body-file requires a path.");
  return options;
}

async function publishSummary(markdown, options) {
  if (options.summaryFile) await writeFile(options.summaryFile, markdown, "utf8");
  if (options.prBodyFile) await writeFile(options.prBodyFile, markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = await runPrimeResurgenceSync({ rootDir, dryRun: options.dryRun });
    await publishSummary(result.summary, options);
    process.stdout.write(result.summary);
  } catch (error) {
    const summary = failureSummary(error);
    await publishSummary(summary, options);
    process.stderr.write(`${summary}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoReleaseReadyCandidate } from "./lib/prime-resurgence-sync.mjs";

const MANUAL_REVIEW_LINES = "This PR does not publish the rotation automatically.\nHuman review is required before changing it to published.";

export function releaseSummary(outcome) {
  const lines = ["", "### Automatic publication", ""];
  if (outcome.status === "published") {
    lines.push(`- Result: published ${outcome.rotationId} (${outcome.prelaunch ? "prelaunch, activates at startsAt" : "live"})`);
    lines.push(`- Price basis: ${outcome.result.priceBasis}`);
  } else if (outcome.status === "deferred") {
    lines.push(`- Result: deferred for ${outcome.rotationId}; the candidate stays provisional and the next sync retries.`);
    lines.push(`- Reason: ${outcome.reason}`);
  } else {
    lines.push(`- Result: skipped (${outcome.reason})`);
  }
  return `${lines.join("\n")}\n`;
}

async function appendSection(file, section, outcome) {
  if (!file) return;
  let text = "";
  try { text = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (outcome.status === "published") text = text.replace(MANUAL_REVIEW_LINES, "The automation pipeline published this rotation; it is merged without manual review.");
  await writeFile(file, text + section, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const options = { summaryFile: "", prBodyFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--summary-file") options.summaryFile = argv[++index] || "";
    else if (argv[index] === "--pr-body-file") options.prBodyFile = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outcome = await autoReleaseReadyCandidate({ rootDir });
  const section = releaseSummary(outcome);
  await appendSection(options.summaryFile, section, outcome);
  await appendSection(options.prBodyFile, section, outcome);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, section, "utf8");
  if (outcome.status === "deferred") process.stdout.write(`::warning::Automatic publication deferred: ${outcome.reason}\n`);
  process.stdout.write(section);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

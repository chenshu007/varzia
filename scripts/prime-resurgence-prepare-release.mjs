#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePrimeResurgenceRelease } from "./lib/prime-resurgence-sync.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [rotationId, ...flags] = argv;
  if (!rotationId || !/^[a-z0-9-]+$/.test(rotationId) || flags.some(flag => flag !== "--write") || flags.length > 1) {
    throw new Error("Usage: node scripts/prime-resurgence-prepare-release.mjs ROTATION_ID [--write] (default: dry-run)");
  }
  const result = await preparePrimeResurgenceRelease({ rootDir: fileURLToPath(new URL("../", import.meta.url)), rotationId, dryRun: !flags.includes("--write") });
  console.log(JSON.stringify(result, null, 2));
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

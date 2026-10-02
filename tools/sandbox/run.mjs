#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSandbox, sandboxPlan } from "../../scripts/lib/sandbox-runner.mjs";

export function parseArguments(argv) {
  const options = { mode: "check", planOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--plan") options.planOnly = true;
    else if (["--revision", "--mode", "--output", "--timeout-ms"].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      const key = { "--revision": "revision", "--mode": "mode", "--output": "outputDir", "--timeout-ms": "timeoutMs" }[flag];
      options[key] = flag === "--timeout-ms" ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  sandboxPlan(options);
  if (!options.planOnly && !options.outputDir) throw new Error("--output requires a new directory for this run.");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.planOnly) { console.log(JSON.stringify(sandboxPlan(options), null, 2)); return; }
  const names = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"];
  const explicit = names.map(name => process.env[name]);
  if (explicit.some(Boolean) && !explicit.every(Boolean)) throw new Error("Explicit credentials require VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.");
  if (!explicit.every(Boolean) && !process.env.VERCEL_OIDC_TOKEN) throw new Error("Existing Sandbox credentials are required. This runner does not start a login or create a project.");
  const credentials = explicit.every(Boolean) ? { token: explicit[0], teamId: explicit[1], projectId: explicit[2] } : {};
  const { Sandbox } = await import("@vercel/sandbox");
  const report = await runSandbox({ ...options, credentials, createSandbox: parameters => Sandbox.create(parameters), onStep: step => console.log(`Sandbox: ${step}`) });
  console.log(JSON.stringify(report, null, 2));
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    // SDK errors may include request context; the detailed report is redacted.
    console.error(error.report ? `Sandbox failed; see report.json (${error.report.error || error.report.cleanupError}).` : "Sandbox did not run. Check arguments and existing credentials.");
    process.exitCode = 1;
  }
}

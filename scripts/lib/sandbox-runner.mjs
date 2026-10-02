import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateRotationData, validateAnnouncementCandidates } from "../../js/data-validation.js";
import { SYNC_MUTABLE_DATA_PATHS } from "./prime-resurgence-sync.mjs";

export const SANDBOX_REPOSITORY = "https://github.com/chenshu007/varzia.git";
const WORKSPACE = "/vercel/sandbox";
const MAX_LOG_CHARS = 200_000;
const MAX_DATA_BYTES = 8_000_000;

export function sandboxPlan({ revision, mode = "check", timeoutMs = 300_000 } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("A full 40-character commit SHA is required.");
  if (!["check", "update"].includes(mode)) throw new Error("Mode must be check or update.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 300_000) throw new Error("Timeout must be between 30 and 300 seconds.");
  return {
    repository: SANDBOX_REPOSITORY, revision, mode, timeoutMs,
    commands: [
      { step: "checkout", cmd: "git", args: ["rev-parse", "HEAD"] },
      { step: "runtime", cmd: "node", args: ["--version"] },
      { step: "decompressor", cmd: "xz", args: ["--version"] },
      { step: "sync", cmd: "node", args: ["scripts/prime-resurgence-sync.mjs", "--mode", "announcement", ...(mode === "check" ? ["--dry-run"] : []), "--summary-file", "/tmp/varzia-sync-summary.md"] },
      { step: "verify", cmd: "npm", args: ["run", "verify"] },
      { step: "locales", cmd: "npm", args: ["run", "check:locales"] },
      { step: "tracked-diff", cmd: "git", args: ["diff", "--name-only", "HEAD"] },
      { step: "untracked", cmd: "git", args: ["ls-files", "--others", "--exclude-standard"] },
      { step: "patch", cmd: "git", args: ["diff", "--binary", "HEAD", "--", ...SYNC_MUTABLE_DATA_PATHS] }
    ]
  };
}

function redact(text, secrets) {
  let safe = String(text);
  for (const secret of secrets.filter(value => typeof value === "string" && value.length >= 8)) safe = safe.split(secret).join("[REDACTED]");
  return safe.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]");
}

export async function runSandbox({ revision, mode = "check", timeoutMs, outputDir, createSandbox, credentials = {}, now = () => new Date(), onStep = () => {} } = {}) {
  const plan = sandboxPlan({ revision, mode, timeoutMs });
  if (!outputDir || typeof createSandbox !== "function") throw new Error("Output directory and Sandbox factory are required.");
  const destination = path.resolve(outputDir);
  // Never overwrite a previous run or import results into the user's checkout.
  await mkdir(destination);
  const secrets = [credentials.token, process.env.VERCEL_OIDC_TOKEN, process.env.VERCEL_TOKEN];
  const report = { schemaVersion: 1, ...plan, commands: [], startedAt: now().toISOString(), status: "failed", stopped: false, changedFiles: [], artifacts: [] };
  let sandbox;
  let failure;
  const logs = [];
  const buffers = new Map();
  let patch = "";
  try {
    sandbox = await createSandbox({
      ...credentials, source: { type: "git", url: plan.repository, revision: plan.revision, depth: 1 },
      runtime: "node22", persistent: false, timeout: plan.timeoutMs,
      // Host credentials are used by the SDK only, never sent to the VM.
      env: { CI: "1" }
    });
    report.sandboxId = sandbox.sandboxId || sandbox.name;
    for (const command of plan.commands) {
      onStep(command.step);
      const result = await sandbox.runCommand({ cmd: command.cmd, args: command.args, cwd: WORKSPACE });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      if (stdout.length + stderr.length > MAX_LOG_CHARS) throw new Error(`Output limit exceeded in ${command.step}.`);
      logs.push(`## ${command.step}\n${redact(stdout, secrets)}${redact(stderr, secrets)}`);
      report.commands.push({ step: command.step, exitCode: result.exitCode });
      if (result.exitCode !== 0) throw new Error(`Sandbox ${command.step} failed (exit ${result.exitCode}).`);
      if (command.step === "checkout" && stdout.trim() !== plan.revision) throw new Error("Sandbox checkout does not match the requested commit.");
      if (command.step === "runtime" && !/^v22\./.test(stdout.trim())) throw new Error("Sandbox requires the CI Node 22 runtime.");
      if (command.step === "tracked-diff") {
        report.changedFiles = stdout.trim().split("\n").filter(Boolean);
        if (report.changedFiles.some(file => !SYNC_MUTABLE_DATA_PATHS.includes(file))) throw new Error("Sandbox changed a path outside managed data.");
        if (mode === "check" && report.changedFiles.length) throw new Error("Read-only check modified tracked files.");
      }
      if (command.step === "untracked" && stdout.trim()) throw new Error("Sandbox produced unexpected untracked files.");
      if (command.step === "patch") patch = stdout;
    }
    for (const file of SYNC_MUTABLE_DATA_PATHS) {
      const content = await sandbox.readFileToBuffer({ path: file, cwd: WORKSPACE });
      if (!content || content.length > MAX_DATA_BYTES) throw new Error(`Missing or oversized managed artifact: ${file}.`);
      buffers.set(file, content);
    }
    const [rotation, primes, relics, candidates] = SYNC_MUTABLE_DATA_PATHS.map(file => JSON.parse(buffers.get(file).toString("utf8")));
    validateRotationData(rotation, primes, relics);
    validateAnnouncementCandidates(candidates, rotation);
    const summary = await sandbox.readFileToBuffer({ path: "/tmp/varzia-sync-summary.md" });
    if (!summary || summary.length > MAX_LOG_CHARS) throw new Error("Missing or oversized sync summary.");
    buffers.set("sync-summary.md", Buffer.from(redact(summary.toString("utf8"), secrets)));
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.error = redact(error.message, secrets);
  } finally {
    if (sandbox) {
      try { await sandbox.stop(); report.stopped = true; }
      catch (error) { report.status = "failed"; report.cleanupError = redact(error.message, secrets); failure ||= error; }
    }
    report.finishedAt = now().toISOString();
  }
  // Stage the entire result beside the reserved empty destination, then move
  // it atomically. A local export failure cannot expose partial candidate data.
  let staging;
  try {
    staging = await mkdtemp(path.join(path.dirname(destination), ".varzia-export-"));
    if (report.status === "passed") {
      for (const [file, buffer] of buffers) {
        await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
        await writeFile(path.join(staging, file), buffer);
        report.artifacts.push(file);
      }
      await writeFile(path.join(staging, "candidate.patch"), patch);
      report.artifacts.push("candidate.patch");
    }
    await writeFile(path.join(staging, "commands.log"), logs.join("\n"));
    await writeFile(path.join(staging, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await rename(staging, destination);
  } catch (error) {
    report.status = "failed";
    report.artifacts = [];
    report.exportError = redact(error.message, secrets);
    failure ||= error;
    // Best effort: a full/unwritable disk may prevent even a failure report.
    try { await writeFile(path.join(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`); } catch {}
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
  if (failure) throw Object.assign(new Error(report.error || report.cleanupError || report.exportError), { report });
  return report;
}

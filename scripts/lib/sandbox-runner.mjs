import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateRotationData, validateAnnouncementCandidates } from "../../js/data-validation.js";
import { SYNC_MUTABLE_DATA_PATHS } from "./prime-resurgence-sync.mjs";
import { canonicalVerificationCommand, CODEX_IMAGE, CODEX_PRIVATE, codexAgentOptions, codexExecCommand, codexNetworkPolicy, prepareCodex, runCodexAgent } from "./codex-sandbox.mjs";

export const SANDBOX_REPOSITORY = "https://github.com/chenshu007/varzia.git";
const WORKSPACE = "/vercel/sandbox";
const MAX_LOG_CHARS = 200_000;
const MAX_DATA_BYTES = 8_000_000;

export function sandboxPlan({ revision, mode = "check", timeoutMs = 300_000, executor = "deterministic", ...agentOptions } = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("A full 40-character commit SHA is required.");
  if (!["check", "update"].includes(mode)) throw new Error("Mode must be check or update.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 300_000) throw new Error("Timeout must be between 30 and 300 seconds.");
  if (!["deterministic", "codex"].includes(executor)) throw new Error("Executor must be deterministic or codex.");
  const agent = executor === "codex" ? codexAgentOptions(agentOptions) : null;
  if (agent && agent.agentTimeoutMs + agent.loginTimeoutMs + 30_000 > timeoutMs) throw new Error("VM timeout must reserve at least 30 seconds after login and agent budgets.");
  return {
    repository: SANDBOX_REPOSITORY, revision, mode, timeoutMs,
    ...(agent ? { executor, agent, networkPolicy: codexNetworkPolicy({ checkout: true }) } : {}),
    commands: [
      { step: "checkout", cmd: "git", args: ["rev-parse", "HEAD"] },
      { step: "runtime", cmd: "node", args: ["--version"] },
      ...(agent ? [{ step: "codex-runtime", cmd: "codex", args: ["--version"] }] : [{ step: "bootstrap", cmd: "dnf", args: ["install", "-y", "xz"], sudo: true }]),
      { step: "decompressor", cmd: "xz", args: ["--version"] },
      ...(agent ? [
        { step: "codex-agent", ...codexExecCommand({ mode, frozenNow: "RUN_START_ISO_TIME", agent }) },
        { step: "post-agent-sha", cmd: "git", args: ["rev-parse", "HEAD"] },
        { step: "pre-verify-diff", cmd: "git", args: ["diff", "--name-only", "HEAD"] },
        { step: "pre-verify-untracked", cmd: "git", args: ["ls-files", "--others", "--exclude-standard"] },
        { step: "artifact-types", cmd: "node", args: ["-e", `const fs=require('fs');for(const f of ${JSON.stringify(SYNC_MUTABLE_DATA_PATHS)}){const s=fs.lstatSync(f);if(!s.isFile()||s.nlink!==1||s.size>8000000)throw Error('Invalid managed artifact type/size');}`] }
      ] : [{ step: "sync", cmd: "node", args: ["scripts/prime-resurgence-sync.mjs", "--mode", "announcement", ...(mode === "check" ? ["--dry-run"] : []), "--summary-file", "/tmp/varzia-sync-summary.md"] }]),
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
  return safe.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[REDACTED]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export async function runSandbox({ revision, mode = "check", timeoutMs, outputDir, createSandbox, credentials = {}, now = () => new Date(), onStep = () => {}, onDeviceLogin, executor = "deterministic", ...agentOptions } = {}) {
  const plan = sandboxPlan({ revision, mode, timeoutMs, executor, ...agentOptions });
  if (plan.agent && (!plan.agent.deviceLogin || !plan.agent.trustedSource || typeof onDeviceLogin !== "function")) throw new Error("Codex requires explicit --device-login, --trusted-source, and a private login display. No VM or model was run.");
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
  const deadline = Date.now() + plan.timeoutMs;
  const controller = new AbortController();
  const timeout = plan.agent ? setTimeout(() => controller.abort(new Error("Sandbox host deadline exceeded.")), plan.timeoutMs) : null;
  timeout?.unref();
  async function run(command) {
    onStep(command.step);
    const result = await sandbox.runCommand({ cmd: command.cmd, args: command.args, cwd: command.cwd || WORKSPACE,
      ...(command.sudo ? { sudo: true } : {}), ...(command.env ? { env: command.env } : {}),
      ...(plan.agent ? { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) } : {}) });
    const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
    if (stdout.length + stderr.length > MAX_LOG_CHARS) throw new Error(`Output limit exceeded in ${command.step}.`);
    logs.push(`## ${command.step}\n${command.privateOutput ? "[private account status omitted]" : redact(stdout, secrets) + redact(stderr, secrets)}`);
    report.commands.push({ step: command.step, exitCode: result.exitCode });
    if (result.exitCode !== 0) throw new Error(`Sandbox ${command.step} failed (exit ${result.exitCode}).`);
    if (command.expectedStdout && stdout.trim() !== command.expectedStdout) throw new Error("Canonical checkout SHA mismatch.");
    if (command.requireAccountAuth && !/logged in using chatgpt/i.test(stdout + stderr)) throw new Error("A ChatGPT account login is required; API key fallback is disabled.");
    return stdout;
  }
  try {
    sandbox = await createSandbox({
      ...credentials, source: { type: "git", url: plan.repository, revision: plan.revision, depth: 1 },
      ...(plan.agent ? { image: CODEX_IMAGE, networkPolicy: plan.networkPolicy, signal: controller.signal } : { runtime: "node22" }), persistent: false, timeout: plan.timeoutMs,
      // Host credentials are used by the SDK only, never sent to the VM.
      env: { CI: "1" }
    });
    report.sandboxId = sandbox.sandboxId || sandbox.name;
    for (const command of plan.commands) {
      if (command.step === "codex-agent") {
        report.agentBundle = await prepareCodex({ sandbox, mode, revision, frozenNow: report.startedAt, run, signal: controller.signal });
        await sandbox.updateNetworkPolicy(codexNetworkPolicy({ login: true }), { signal: controller.signal });
        onStep("device-login");
        await runCodexAgent({ sandbox, mode, frozenNow: report.startedAt, agent: plan.agent, run, onDeviceLogin, report, signal: controller.signal });
        await run({ step: "erase-login", cmd: "rm", args: ["-rf", `${CODEX_PRIVATE}/codex`] });
        report.authErased = true;
        await sandbox.updateNetworkPolicy(codexNetworkPolicy(), { signal: controller.signal });
        continue;
      }
      if (command.step === "verify" && plan.agent) await run(canonicalVerificationCommand({ mode, frozenNow: report.startedAt }));
      // Agent processes cannot read/write the private canonical checkout. All
      // final checks and exports use that authoritative copy, avoiding races
      // with late writes from an agent-spawned background process.
      const canonical = plan.agent && ["verify", "locales", "tracked-diff", "untracked", "patch"].includes(command.step);
      const stdout = await run(canonical ? { ...command, cwd: `${CODEX_PRIVATE}/baseline` } : command);
      if (["checkout", "post-agent-sha"].includes(command.step) && stdout.trim() !== plan.revision) throw new Error("Sandbox checkout does not match the requested commit.");
      if (command.step === "runtime" && !(plan.agent ? /^v24\./ : /^v22\./).test(stdout.trim())) throw new Error(plan.agent ? "Codex universal image requires Node 24; no runtime fallback." : "Sandbox requires the CI Node 22 runtime.");
      if (command.step === "codex-runtime") {
        const version = /^codex-cli (\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < 159)) throw new Error("Codex CLI >=0.159 is required for the reviewed permission/config interface.");
        report.codexVersion = version[0];
      }
      if (["tracked-diff", "pre-verify-diff"].includes(command.step)) {
        report.changedFiles = stdout.trim().split("\n").filter(Boolean);
        if (report.changedFiles.some(file => !SYNC_MUTABLE_DATA_PATHS.includes(file))) throw new Error("Sandbox changed a path outside managed data.");
        if (mode === "check" && report.changedFiles.length) throw new Error("Read-only check modified tracked files.");
      }
      if (["untracked", "pre-verify-untracked"].includes(command.step) && stdout.trim()) throw new Error("Sandbox produced unexpected untracked files.");
      if (command.step === "patch") patch = stdout;
    }
    for (const file of SYNC_MUTABLE_DATA_PATHS) {
      const content = await sandbox.readFileToBuffer({ path: file, cwd: plan.agent ? `${CODEX_PRIVATE}/baseline` : WORKSPACE }, plan.agent ? { signal: controller.signal } : undefined);
      if (!content || content.length > MAX_DATA_BYTES) throw new Error(`Missing or oversized managed artifact: ${file}.`);
      buffers.set(file, content);
    }
    const [rotation, primes, relics, candidates] = SYNC_MUTABLE_DATA_PATHS.map(file => JSON.parse(buffers.get(file).toString("utf8")));
    validateRotationData(rotation, primes, relics);
    validateAnnouncementCandidates(candidates, rotation);
    const summary = await sandbox.readFileToBuffer({ path: plan.agent ? `${CODEX_PRIVATE}/canonical/sync-summary.md` : "/tmp/varzia-sync-summary.md" }, plan.agent ? { signal: controller.signal } : undefined);
    if (!summary || summary.length > MAX_LOG_CHARS) throw new Error("Missing or oversized sync summary.");
    buffers.set("sync-summary.md", Buffer.from(redact(summary.toString("utf8"), secrets)));
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.error = redact(error.message, secrets);
  } finally {
    if (sandbox) {
      if (plan.agent && !report.authErased) {
        try {
          const result = await sandbox.runCommand({ cmd: "rm", args: ["-rf", `${CODEX_PRIVATE}/codex`], timeoutMs: 10_000, signal: AbortSignal.timeout(10_000) });
          if (result.exitCode !== 0) throw new Error("Temporary login erasure failed.");
          report.authErased = true;
        } catch { report.authErased = false; report.status = "failed"; report.cleanupError = "Temporary login erasure failed; VM shutdown required."; failure ||= new Error(report.cleanupError); }
      }
      try { await sandbox.stop(plan.agent ? { signal: AbortSignal.timeout(10_000) } : undefined); report.stopped = true; }
      catch (error) { report.status = "failed"; report.cleanupError = redact(error.message, secrets); failure ||= error; }
    }
    report.finishedAt = now().toISOString();
    if (timeout) clearTimeout(timeout);
    if (plan.agent) {
      // Model report strings never bypass the normal diagnostic redaction.
      if (report.agentReview) report.agentReview = JSON.parse(redact(JSON.stringify(report.agentReview), secrets));
      report.budgetEnforcement = "VM/command wall-time hard limits; token budget checked after the single turn (not a prebilling spend cap).";
    }
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSandbox, sandboxPlan } from "../scripts/lib/sandbox-runner.mjs";
import { canonicalVerificationCommand, CODEX_PRIVATE, CODEX_SKILL, codexEventAccumulator, codexExecCommand, codexNetworkPolicy, deviceLoginDisplay, validateCodexReport } from "../scripts/lib/codex-sandbox.mjs";
import { parseAgentToolArguments, runAgentTool } from "../scripts/prime-resurgence-agent-tool.mjs";
import { SYNC_MUTABLE_DATA_PATHS } from "../scripts/lib/prime-resurgence-sync.mjs";
import { parseArguments, main } from "../tools/sandbox/run.mjs";

const revision = "a".repeat(40);
const frozenNow = "2026-10-02T12:00:00.000Z";
const options = { revision, executor: "codex", model: "gpt-6.1-sol", trustedSource: true, deviceLogin: true };
const fixtures = new Map(await Promise.all([...SYNC_MUTABLE_DATA_PATHS, CODEX_SKILL, "scripts/prime-resurgence-agent-tool.mjs"].map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url))])));
const ready = mode => ({ skill: CODEX_SKILL, mode, status: "ready", summary: "Official evidence checked; review only.", warnings: [], checks: { officialSync: true, verify: true, locales: true } });
function events({ tokens = 100, skipSkill = false, skipTool = false, failure = false } = {}) {
  return [
    { type: "thread.started", thread_id: "private-thread" },
    ...[...(skipSkill ? [] : [`cat ${CODEX_SKILL}`]), ...(skipTool ? [] : [`node scripts/prime-resurgence-agent-tool.mjs --mode check --now ${frozenNow}`]), "npm run verify", "npm run check:locales"].map(command => ({ type: "item.completed", item: { type: "command_execution", command, exit_code: 0, aggregated_output: "private upstream content" } })),
    failure ? { type: "turn.failed", error: { message: "private failure detail" } } : { type: "turn.completed", usage: { input_tokens: tokens, output_tokens: 12, cached_input_tokens: 0 } }
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
}
function fixture({ mode = "check", failStep, loginFailure = false, apiAuth = false, invalidReport = false, blocked = false, changedFiles = [], untracked = "", wrongShaStep, badBundle = false, stopFailure = false, badData = false, eventOptions = {}, hangAgent = false, oldCli = false } = {}) {
  const calls = []; const policies = []; let step; let params; let stopped = false; let killed = false;
  const result = (stdout = "", code = 0, stderr = "") => ({ exitCode: code, stdout: async () => stdout, stderr: async () => stderr });
  return {
    calls, policies, onStep(value) { step = value; }, get params() { return params; }, get stopped() { return stopped; }, get killed() { return killed; },
    async createSandbox(value) {
      params = value;
      return {
        sandboxId: "sbx_codex_fixture",
        async mkDir(file) { calls.push({ mkdir: file }); },
        async writeFiles(files) { calls.push({ writes: files.map(file => file.path) }); },
        async updateNetworkPolicy(policy) { policies.push(policy); },
        async runCommand(command) {
          calls.push(command);
          if (command.cmd === "codex" && command.args[0] === "login" && command.detached) return {
            async *logs() { yield { stream: "stdout", data: "https://auth.openai.com/codex/device\nABCD-EFGH\n" }; },
            async wait() { return result("", loginFailure ? 1 : 0); }, async kill() { killed = true; }
          };
          if (command.cmd === "codex" && command.args[0] === "exec") return {
            async *logs() {
              if (hangAgent) throw new Error("Agent command deadline exceeded.");
              const text = events(eventOptions); yield { stream: "stdout", data: text.slice(0, 17) }; yield { stream: "stdout", data: text.slice(17) };
              yield { stream: "stderr", data: "private agent diagnostic" };
            }, async wait() { return result(); }, async kill() { killed = true; }
          };
          if (command.cmd === "rm") return result("", failStep === "erase-login" ? 1 : 0);
          const stdout = ["checkout", "post-agent-sha", "canonical-sha"].includes(step) ? (step === wrongShaStep ? "b".repeat(40) : revision)
            : step === "runtime" ? "v24.15.0\n" : step === "codex-runtime" ? (oldCli ? "codex-cli 0.130.0" : "codex-cli 0.159.3")
              : step === "account-auth" ? (apiAuth ? "Logged in using an API key" : "Logged in using ChatGPT")
                : ["pre-verify-diff", "tracked-diff"].includes(step) ? changedFiles.join("\n")
                  : ["pre-verify-untracked", "untracked"].includes(step) ? untracked : step === "patch" ? "review patch\n" : "";
          return result(stdout, step === failStep ? 1 : 0);
        },
        async readFileToBuffer({ path: file }) {
          calls.push({ read: file });
          if (file === `${CODEX_PRIVATE}/review.json`) return Buffer.from(JSON.stringify(invalidReport ? { status: "ready" } : { ...ready(mode), ...(blocked ? { status: "blocked" } : {}) }));
          if (file === `${CODEX_PRIVATE}/canonical/sync-summary.md`) return Buffer.from("Independently verified official sources.\n");
          if (badBundle && file === CODEX_SKILL) return Buffer.from("Untrusted changed skill");
          if (badData && file === SYNC_MUTABLE_DATA_PATHS[0]) return Buffer.from('{"schemaVersion":999}');
          return fixtures.get(file);
        },
        async stop() { stopped = true; if (stopFailure) throw new Error("stop unavailable"); }
      };
    }
  };
}
async function output(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "varzia-codex-test-"));
  t.after(() => rm(parent, { recursive: true, force: true })); return path.join(parent, "run");
}
async function execute(t, params = {}) {
  const f = fixture(params); const outputDir = await output(t); const login = [];
  const promise = runSandbox({ ...options, mode: params.mode || "check", outputDir, createSandbox: f.createSandbox, now: () => new Date(frozenNow), onStep: f.onStep, onDeviceLogin: text => login.push(text) });
  return { f, outputDir, login, promise };
}

test("Codex planning is credential-free, explicit and refuses invalid runtime/model/budgets", () => {
  const plan = sandboxPlan(options);
  assert.equal(plan.agent.auth, "chatgpt-device-code"); assert.equal(plan.agent.authPersistence, "this-VM-only");
  assert.equal(plan.agent.image, "vercel/sandbox/universal"); assert.ok(!plan.commands.some(cmd => cmd.sudo));
  assert.deepEqual(Object.keys(plan.networkPolicy.allow), ["github.com"]);
  for (const fields of [{ model: "" }, { model: "openai/gpt-6.1-sol" }, { model: "gpt; touch /tmp/pwn" }, { maxTotalTokens: 200001 }, { agentTimeoutMs: 150001 }, { loginTimeoutMs: 90001 }, { timeoutMs: 30000 }, { executor: "anything" }]) assert.throws(() => sandboxPlan({ ...options, ...fields }));
  assert.equal(parseArguments(["--executor", "codex", "--revision", revision, "--model", "gpt-6.1-sol", "--plan"]).deviceLogin, undefined);
});
test("absent device consent/trusted source/private display fails before output or VM allocation", async t => {
  let creates = 0; const outputDir = await output(t);
  for (const fields of [{ deviceLogin: false }, { trustedSource: false }, { onDeviceLogin: undefined }]) await assert.rejects(runSandbox({ ...options, outputDir, createSandbox: () => { creates++; }, onDeviceLogin() {}, ...fields }), /explicit/);
  assert.equal(creates, 0); await assert.rejects(readFile(path.join(outputDir, "report.json")), /ENOENT/);
  await assert.rejects(main(["--executor", "codex", "--revision", revision, "--model", "gpt-6.1-sol", "--output", outputDir]), /private interactive terminal/);
});
test("Codex consumes skill and tools, host independently verifies, erases auth and stops before exporting", async t => {
  const { f, outputDir, login, promise } = await execute(t); const report = await promise;
  assert.equal(report.status, "passed"); assert.equal(report.stopped, true); assert.equal(report.authErased, true);
  assert.equal(report.agentAudit.skillRead, true); assert.equal(report.agentAudit.officialToolRan, true);
  assert.deepEqual(report.agentAudit.usage, { input_tokens: 100, output_tokens: 12, cached_input_tokens: 0 });
  assert.ok(report.commands.some(cmd => cmd.step === "official-recheck"));
  assert.ok(f.calls.some(cmd => cmd.cmd === "npm" && cmd.cwd === `${CODEX_PRIVATE}/baseline`));
  assert.equal(f.params.image, "vercel/sandbox/universal"); assert.equal(f.params.runtime, undefined);
  assert.equal(f.params.persistent, false); assert.deepEqual(f.params.env, { CI: "1" });
  assert.equal(f.policies.length, 2); assert.ok(f.policies[0].allow["auth.openai.com"]); assert.equal(f.policies[1].allow["chatgpt.com"], undefined);
  const exec = f.calls.find(call => call.cmd === "codex" && call.args[0] === "exec");
  assert.ok(exec.args.at(-1).includes("$varzia-official-update")); assert.ok(exec.args.at(-1).includes(frozenNow));
  assert.ok(exec.args.includes("--output-schema")); assert.ok(exec.args.includes("--ephemeral"));
  assert.ok(exec.args.includes('forced_login_method="chatgpt"')); assert.ok(exec.args.join(" ").includes(`"${CODEX_PRIVATE}"="deny"`));
  assert.equal(exec.args.some(arg => arg.includes("danger-full-access") || arg.includes("bypass")), false);
  assert.equal(f.calls.some(call => call.read?.endsWith("auth.json")), false);
  assert.ok(login.join("").includes("ABCD-EFGH"));
  const diagnostics = await readFile(path.join(outputDir, "commands.log"), "utf8") + await readFile(path.join(outputDir, "report.json"), "utf8");
  for (const text of ["ABCD-EFGH", "private upstream content", "private agent diagnostic", "private-thread"]) assert.equal(diagnostics.includes(text), false);
  for (const file of SYNC_MUTABLE_DATA_PATHS) assert.deepEqual(await readFile(path.join(outputDir, file)), fixtures.get(file));
});
test("update also requires host canonical comparison and retains independent verify/locale gates", async t => {
  const { promise, f } = await execute(t, { mode: "update", changedFiles: ["data/rotation.json"] }); const report = await promise;
  assert.deepEqual(report.changedFiles, ["data/rotation.json"]);
  const steps = report.commands.map(command => command.step);
  assert.ok(steps.indexOf("erase-login") < steps.indexOf("official-recheck"));
  assert.ok(steps.indexOf("pre-verify-diff") < steps.indexOf("verify"));
  assert.ok(steps.indexOf("official-recheck") < steps.indexOf("verify"));
  assert.ok(f.calls.some(cmd => cmd.args?.join(" ").includes('"/vercel/sandbox/data"="write"')));
});
for (const params of [
  { loginFailure: true }, { apiAuth: true }, { invalidReport: true }, { blocked: true }, { badBundle: true }, { oldCli: true }, { hangAgent: true },
  { eventOptions: { failure: true } }, { eventOptions: { tokens: 100001 } }, { eventOptions: { skipSkill: true } }, { eventOptions: { skipTool: true } },
  { failStep: "permission-guard" }, { failStep: "source-policy" }, { failStep: "official-recheck" }, { failStep: "artifact-types" },
  { failStep: "verify" }, { failStep: "locales" }, { failStep: "erase-login" }, { stopFailure: true }, { badData: true },
  { mode: "update", changedFiles: ["scripts/lib/prime-resurgence-sync.mjs"] }, { changedFiles: ["data/rotation.json"] }, { untracked: "injected.mjs" },
  { wrongShaStep: "post-agent-sha" }, { wrongShaStep: "canonical-sha" }
]) test(`agent failure withholds every candidate and always attempts shutdown: ${JSON.stringify(params)}`, async t => {
  const { f, promise, outputDir } = await execute(t, params);
  await assert.rejects(promise); assert.equal(f.stopped, true);
  assert.deepEqual((await readdir(outputDir)).sort(), ["commands.log", "report.json"]);
  const report = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
  assert.equal(report.status, "failed"); assert.deepEqual(report.artifacts, []);
  if (["source-policy", "permission-guard"].includes(params.failStep) || params.badBundle || params.oldCli) assert.equal(f.calls.some(cmd => cmd.args?.[0] === "login"), false);
  if (params.loginFailure || params.apiAuth) assert.equal(f.calls.some(cmd => cmd.args?.[0] === "exec"), false);
  if (params.changedFiles?.includes("scripts/lib/prime-resurgence-sync.mjs") || params.untracked) assert.equal(report.commands.some(cmd => cmd.step === "verify"), false);
});
test("JSONL parsing handles chunks and rejects malformed/incomplete/oversized streams and unknown usage", () => {
  const parser = codexEventAccumulator(1000); const text = events(); for (const chunk of text) parser.feed(chunk);
  assert.equal(parser.finish().skillRead, true);
  assert.throws(() => codexEventAccumulator(1000).finish(), /did not complete/);
  assert.throws(() => codexEventAccumulator(1000).feed('{"oops"\n'), /JSON/);
  assert.throws(() => codexEventAccumulator(1000).feed("x".repeat(200001)), /output limit/);
  assert.throws(() => codexEventAccumulator(1000).feed('{"type":"turn.completed"}\n'), /usage/);
  assert.throws(() => codexEventAccumulator(1000).feed(events() + events()), /Multiple/);
});
test("agent schema and options cannot create auth/provider/network fallback", () => {
  const command = codexExecCommand({ mode: "check", frozenNow, agent: sandboxPlan(options).agent });
  assert.equal(command.env.CODEX_HOME, `${CODEX_PRIVATE}/codex`); assert.equal(command.args.includes("--sandbox"), false);
  assert.equal(Object.keys(command.env).some(key => /KEY|TOKEN/.test(key)), false);
  assert.equal(command.args.some(arg => /gateway|api_key/i.test(arg)), false);
  assert.equal(codexNetworkPolicy({ login: true }).allow["api.github.com"], undefined);
  assert.throws(() => validateCodexReport({ ...ready("check"), authorization: "publish" }, "check"), /Invalid/);
});
test("device display exposes only the official URL and short code, never raw login diagnostics", () => {
  const shown = []; const display = deviceLoginDisplay(text => shown.push(text));
  const login = 'access_token=never-display\nhttps://evil.example/codex/device\n\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\u001b[94mABCD-EFGH\u001b[0m\nBearer private-token\n';
  for (const character of login) display.feed(character); display.finish();
  assert.equal(shown.length, 2); assert.ok(shown.join("").includes("ABCD-EFGH"));
  for (const secret of ["never-display", "evil.example", "private-token"]) assert.equal(shown.join("").includes(secret), false);
  assert.throws(() => deviceLoginDisplay(() => {}).finish(), /unavailable/);
});
test("agent tool preserves deterministic updater, frozen time and dry-run mode with review output", async t => {
  const workDir = await output(t); const inputs = [];
  const result = await runAgentTool({ ...parseAgentToolArguments(["--mode", "check", "--now", frozenNow]), rootDir: "/fixture", workDir, sync: async value => { inputs.push(value); return { status: "no-change", changedFiles: [], summary: "official source warnings" }; } });
  assert.equal(inputs[0].dryRun, true); assert.equal(inputs[0].now.toISOString(), frozenNow); assert.equal(result.status, "no-change");
  assert.equal(await readFile(path.join(workDir, "sync-summary.md"), "utf8"), "official source warnings");
  for (const argv of [["--mode", "publish", "--now", frozenNow], ["--mode", "check", "--now", "yesterday"], ["--mode", "check", "--mode", "update"], ["--mode", "check", "--now", frozenNow, "--command", "push"]]) assert.throws(() => parseAgentToolArguments(argv));
  await assert.rejects(runAgentTool({ mode: "update", now: frozenNow, rootDir: "/fixture", workDir, sync: async () => { throw new Error("Official sources disagree."); } }), /disagree/);
  assert.match(await readFile(path.join(workDir, "sync-summary.md"), "utf8"), /Official sources disagree/);
});
test("host canonical verifier actually recomputes from original data and rejects plausible forged output", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "varzia-canonical-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const control = path.join(root, "control"); const workspace = path.join(root, "repo"); const baseline = path.join(control, "baseline");
  await mkdir(path.join(baseline, "scripts"), { recursive: true }); await mkdir(path.join(baseline, "data")); await mkdir(path.join(workspace, "data"), { recursive: true });
  const data = Buffer.from('{"canonical":true}\n');
  for (const file of SYNC_MUTABLE_DATA_PATHS) { await writeFile(path.join(baseline, file), data); await writeFile(path.join(workspace, file), data); }
  await writeFile(path.join(baseline, "scripts/prime-resurgence-agent-tool.mjs"), `import{mkdir,writeFile}from'node:fs/promises';export async function runAgentTool({workDir}){await mkdir(workDir,{recursive:true});await writeFile(workDir+'/sync-summary.md','canonical evidence');}`);
  const command = canonicalVerificationCommand({ mode: "update", frozenNow });
  const args = command.args.map(arg => arg.replaceAll(CODEX_PRIVATE, control).replaceAll("/vercel/sandbox", workspace).replaceAll("/tmp/varzia-sync-summary.md", path.join(root, "summary.md")));
  assert.equal(spawnSync(process.execPath, args).status, 0);
  assert.equal(await readFile(path.join(root, "summary.md"), "utf8"), "canonical evidence");
  await writeFile(path.join(workspace, SYNC_MUTABLE_DATA_PATHS[0]), '{"canonical":true,"forged":true}\n');
  const failed = spawnSync(process.execPath, args); assert.notEqual(failed.status, 0); assert.match(failed.stderr.toString(), /differs from independent/);
});

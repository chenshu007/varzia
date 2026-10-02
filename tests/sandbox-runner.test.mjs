import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSandbox, sandboxPlan, SANDBOX_REPOSITORY } from "../scripts/lib/sandbox-runner.mjs";
import { SYNC_MUTABLE_DATA_PATHS } from "../scripts/lib/prime-resurgence-sync.mjs";
import { parseArguments } from "../tools/sandbox/run.mjs";

const revision = "a".repeat(40);
const fixtureFiles = new Map(await Promise.all(SYNC_MUTABLE_DATA_PATHS.map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url))])));
function fixture({ failStep, changedFiles = [], wrongSha = false, stopFailure = false, badData = false, mode = "check" } = {}) {
  const calls = [];
  const plan = sandboxPlan({ revision, mode });
  let stopped = false;
  let options;
  return {
    calls, get stopped() { return stopped; }, get options() { return options; },
    async createSandbox(params) {
      options = params;
      return {
        sandboxId: "sbx_fixture",
        async runCommand(command) {
          calls.push(command);
          const step = plan.commands[calls.length - 1].step;
          const stdout = step === "checkout" ? (wrongSha ? "b".repeat(40) : revision)
            : step === "runtime" ? "v22.20.0\n" : step === "tracked-diff" ? changedFiles.join("\n")
            : step === "patch" ? "diff --git a/data/rotation.json b/data/rotation.json\n" : "";
          return { exitCode: step === failStep ? 1 : 0, stdout: async () => stdout, stderr: async () => step === failStep ? "Bearer hidden-token\n" : "" };
        },
        async readFileToBuffer({ path: file }) {
          if (file === "/tmp/varzia-sync-summary.md") return Buffer.from("Official sync summary\n");
          if (badData && file === "data/rotation.json") return Buffer.from('{"schemaVersion":999}');
          return fixtureFiles.get(file);
        },
        async stop() { stopped = true; if (stopFailure) throw new Error("stop unavailable"); }
      };
    }
  };
}
async function output(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "varzia-sandbox-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return path.join(parent, "run");
}
test("runner pins this repository and fixed commands; invalid options allocate no VM", () => {
  assert.throws(() => sandboxPlan({ revision: "main; echo injected" }), /commit SHA/);
  assert.throws(() => sandboxPlan({ revision, mode: "publish" }), /Mode/);
  assert.throws(() => sandboxPlan({ revision, timeoutMs: 300_001 }), /Timeout/);
  assert.equal(sandboxPlan({ revision }).repository, SANDBOX_REPOSITORY);
  assert.throws(() => parseArguments(["--revision", revision, "--output"]), /requires a value/);
  assert.throws(() => parseArguments(["--revision", revision, "--command", "anything"]), /Unknown/);
});
test("successful check verifies locales and exports validated artifacts after stopping", async t => {
  const f = fixture(); const outputDir = await output(t);
  const report = await runSandbox({ revision, outputDir, createSandbox: f.createSandbox });
  assert.equal(report.status, "passed"); assert.equal(report.stopped, true);
  assert.equal(f.options.persistent, false); assert.equal(f.options.timeout, 300_000);
  assert.equal(f.options.source.revision, revision); assert.deepEqual(f.options.env, { CI: "1" });
  assert.deepEqual(f.calls.find(call => call.cmd === "npm" && call.args[1] === "check:locales").args, ["run", "check:locales"]);
  assert.ok(f.calls.find(call => call.args.includes("--dry-run")));
  for (const file of SYNC_MUTABLE_DATA_PATHS) assert.deepEqual(await readFile(path.join(outputDir, file)), fixtureFiles.get(file));
  assert.ok(report.artifacts.includes("candidate.patch"));
});
test("update runs write sync but only exports allowlisted data; credentials stay on host", async t => {
  const f = fixture({ mode: "update", changedFiles: ["data/rotation.json"] });
  const report = await runSandbox({ revision, mode: "update", outputDir: await output(t), createSandbox: f.createSandbox, credentials: { token: "private-token", teamId: "team_fixture", projectId: "prj_fixture" } });
  assert.deepEqual(report.changedFiles, ["data/rotation.json"]);
  assert.equal(f.calls.some(call => call.args.includes("--dry-run")), false);
  assert.equal(JSON.stringify(f.calls).includes("private-token"), false);
  assert.equal(JSON.stringify(report).includes("private-token"), false);
});
for (const options of [{ failStep: "sync" }, { failStep: "verify" }, { wrongSha: true }, { changedFiles: ["js/app.js"], mode: "update" }, { changedFiles: ["data/rotation.json"] }, { badData: true }, { stopFailure: true }]) {
  test(`failure stops VM and withholds candidate files: ${JSON.stringify(options)}`, async t => {
    const f = fixture(options); const outputDir = await output(t);
    await assert.rejects(runSandbox({ revision, mode: options.mode || "check", outputDir, createSandbox: f.createSandbox }));
    assert.equal(f.stopped, true);
    assert.deepEqual((await readdir(outputDir)).sort(), ["commands.log", "report.json"]);
    const report = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
    assert.equal(report.status, "failed"); assert.deepEqual(report.artifacts, []);
    assert.equal((await readFile(path.join(outputDir, "commands.log"), "utf8")).includes("hidden-token"), false);
  });
}
test("creation failure is recorded; an existing output directory is never overwritten", async t => {
  const outputDir = await output(t); let creates = 0;
  const createSandbox = async () => { creates++; throw new Error("creation unavailable"); };
  await assert.rejects(runSandbox({ revision, outputDir, createSandbox }), /creation unavailable/);
  await assert.rejects(runSandbox({ revision, outputDir, createSandbox }), /EEXIST/);
  assert.equal(creates, 1);
  assert.equal(JSON.parse(await readFile(path.join(outputDir, "report.json"))).stopped, false);
});

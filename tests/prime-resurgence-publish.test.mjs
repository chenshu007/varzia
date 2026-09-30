import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishCandidate } from "../scripts/prime-resurgence-publish.mjs";
import { SYNC_MUTABLE_DATA_PATHS } from "../scripts/lib/prime-resurgence-sync.mjs";

const prefix = "automation/prime-resurgence-sync";
const repo = "example/varzia";
const title = "chore: prepare Prime Resurgence data update";
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";

// Git reads, commits, refs, and lease enforcement are real. Only GitHub is
// mocked: these tests must never create remote branches/PRs in the real repo.
function fixture(t, { candidate = 2 } = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "varzia-publish-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const remote = path.join(temp, "remote.git");
  const cwd = path.join(temp, "checkout");
  const exec = (command, args, directory = cwd) => execFileSync(command, args, {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: "Human", GIT_AUTHOR_EMAIL: "human@example.com",
      GIT_COMMITTER_NAME: "Human", GIT_COMMITTER_EMAIL: "human@example.com" }
  }).trim();
  exec("git", ["init", "--bare", remote], temp);
  exec("git", ["clone", remote, cwd], temp);
  const git = (...args) => exec("git", args);
  git("switch", "--create", "main");
  mkdirSync(path.join(cwd, "data"));
  for (const file of SYNC_MUTABLE_DATA_PATHS) writeFileSync(path.join(cwd, file), '{"version":1}\n');
  writeFileSync(path.join(cwd, "README.md"), "baseline\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  git("push", "origin", "main");
  const baseSha = git("rev-parse", "HEAD");
  const artifact = path.join(temp, "prime-resurgence-candidate");
  mkdirSync(path.join(artifact, "data"), { recursive: true });
  for (const file of SYNC_MUTABLE_DATA_PATHS) writeFileSync(path.join(artifact, file), `{"version":${candidate}}\n`);
  writeFileSync(path.join(artifact, "base-sha.txt"), `${baseSha}\n`);
  writeFileSync(path.join(artifact, "pr-body.md"), "Validated candidate\n");
  const env = { ...process.env, BASE_BRANCH: "main", AUTOMATION_BRANCH: prefix,
    GITHUB_REPOSITORY: repo, PR_TITLE: title, RUNNER_TEMP: temp };
  const state = { prs: [], calls: [], logs: [], beforeGit: null, beforeGh: null, createError: null };
  const makePR = (branch, sha, options = {}) => ({ number: state.prs.length + 1, state: "open", draft: true,
    base: { ref: "main" }, head: { ref: branch, sha, repo: { full_name: repo } }, ...options });
  const run = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "git") {
      state.beforeGit?.(args);
      // Honor git config identity in publish commits, instead of fixture identity.
      if (args[0] === "commit") return execFileSync("git", args, {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
          GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: botEmail,
          GIT_COMMITTER_NAME: "github-actions[bot]", GIT_COMMITTER_EMAIL: botEmail }
      });
      return exec(command, args);
    }
    assert.equal(command, "gh");
    state.beforeGh?.(args);
    if (args[0] === "auth") return "";
    if (args[0] === "api") {
      if (args[1].includes("?")) {
        assert.ok(args.includes("--paginate"));
        assert.ok(args.includes("--slurp"));
        // Exercise multiple pages, including an empty page.
        return JSON.stringify([[], ...state.prs.map(pr => [pr])]);
      }
      const number = Number(args[1].split("/").at(-1));
      return JSON.stringify(state.prs.find(pr => pr.number === number));
    }
    assert.deepEqual(args.slice(0, 2), ["pr", "create"]);
    assert.ok(args.includes("--draft"));
    const branch = args[args.indexOf("--head") + 1];
    const sha = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/)[0];
    if (state.createError === "network") throw new Error("GitHub unavailable");
    state.prs.push(makePR(branch, sha));
    if (state.createError === "lost-response") throw new Error("Response lost after successful create");
    return `https://github.com/${repo}/pull/${state.prs.length}`;
  };
  const publish = () => publishCandidate({ cwd, env, run, log: message => state.logs.push(message) });
  const reset = () => {
    git("reset", "--hard");
    git("switch", "main");
    git("reset", "--hard", baseSha);
  };
  const oldPR = ({ version = 3, state: prState = "open", draft = true, human = false, branch = prefix } = {}) => {
    git("switch", "--create", branch, baseSha);
    for (const file of SYNC_MUTABLE_DATA_PATHS) writeFileSync(path.join(cwd, file), `{"version":${version}}\n`);
    git("add", "data");
    git("-c", `user.email=${botEmail}`, "commit", "--author", `github-actions[bot] <${botEmail}>`, "-m", title);
    if (human) {
      writeFileSync(path.join(cwd, "README.md"), "human review changes\n");
      git("add", "README.md");
      git("commit", "-m", "human review");
    }
    const sha = git("rev-parse", "HEAD");
    git("push", "origin", branch);
    const pr = makePR(branch, sha, { state: prState, draft, merged_at: prState === "closed" ? null : undefined });
    state.prs.push(pr);
    reset();
    return pr;
  };
  return { cwd, temp, remote, git, exec, baseSha, artifact, env, state, makePR, publish, reset, oldPR };
}

function assertUntouched(f, pr, snapshot) {
  assert.deepEqual(pr, snapshot);
  assert.equal(f.git("ls-remote", "--heads", "origin", `refs/heads/${pr.head.ref}`).split(/\s/)[0], pr.head.sha);
  assert.ok(!f.state.calls.some(call => call[0] === "gh" && ["edit", "ready", "close"].includes(call[2])));
  const pushes = f.state.calls.filter(call => call[0] === "git" && call[1] === "push");
  assert.ok(pushes.every(call => !call.includes(`HEAD:refs/heads/${pr.head.ref}`)));
}

test("no PR: create one bot-owned data commit from validated default and a Draft PR", t => {
  const f = fixture(t);
  const result = f.publish();
  assert.equal(result.status, "created");
  assert.match(result.branch, /^automation\/prime-resurgence-sync-[a-f0-9]{20}-1$/);
  assert.equal(f.git("rev-parse", "HEAD^"), f.baseSha);
  assert.equal(f.git("show", "-s", "--format=%ae", "HEAD"), botEmail);
  assert.equal(f.git("show", "-s", "--format=%s", "HEAD"), title);
  assert.deepEqual(f.git("diff", "--name-only", f.baseSha, "HEAD").split("\n"), [...SYNC_MUTABLE_DATA_PATHS].sort());
  assert.equal(f.state.prs.length, 1);
  assert.equal(f.state.prs[0].draft, true);
});

for (const draft of [true, false]) {
  test(`${draft ? "Draft" : "non-Draft open"} PR with same data: success without push/edit/duplicate`, t => {
    const f = fixture(t);
    const pr = f.oldPR({ version: 2, draft });
    const snapshot = structuredClone(pr);
    assert.equal(f.publish().status, "skipped");
    assertUntouched(f, pr, snapshot);
    assert.equal(f.state.prs.length, 1);
    assert.ok(!f.state.calls.some(call => call[0] === "git" && call[1] === "push"));
  });
  test(`${draft ? "Draft" : "existing automation PR is no longer Draft"}: different data rolls over successfully`, t => {
    const f = fixture(t);
    const pr = f.oldPR({ draft });
    const snapshot = structuredClone(pr);
    assert.equal(f.publish().status, "created");
    assertUntouched(f, pr, snapshot);
    assert.equal(f.state.prs.length, 2);
    assert.equal(f.state.prs[1].draft, true);
  });
}

for (const merged of [false, true]) {
  test(`${merged ? "merged" : "closed"} PR: never push to old branch, even with same candidate data`, t => {
    const f = fixture(t);
    const pr = f.oldPR({ state: "closed", version: 2, draft: false });
    pr.merged_at = merged ? "2026-09-29T12:00:00Z" : null;
    const snapshot = structuredClone(pr);
    assert.equal(f.publish().status, "created");
    assertUntouched(f, pr, snapshot);
  });
}

test("no diff: clean success without PR lookup or push", t => {
  const f = fixture(t, { candidate: 1 });
  f.oldPR({ draft: false });
  assert.equal(f.publish().status, "skipped");
  assert.ok(!f.state.calls.some(call => call[0] === "gh" && call[1] === "api"));
  assert.ok(!f.state.calls.some(call => call[0] === "git" && call[1] === "push"));
});

test("human commits on automation branch: preserve commits and non-data changes, roll over", t => {
  const f = fixture(t);
  const pr = f.oldPR({ human: true });
  const snapshot = structuredClone(pr);
  assert.equal(f.publish().status, "created");
  assertUntouched(f, pr, snapshot);
  assert.equal(f.git("show", `${pr.head.sha}:README.md`), "human review changes");
  assert.equal(f.git("show", "HEAD:README.md"), "baseline");
});

test("repeated sync: content deduplication keeps exactly one open candidate PR", t => {
  const f = fixture(t);
  assert.equal(f.publish().status, "created");
  f.reset();
  assert.equal(f.publish().status, "skipped");
  assert.equal(f.state.prs.length, 1);
});

test("closed/merged history reserves deleted content branch names; next generation is stable", t => {
  const f = fixture(t);
  const first = f.publish();
  f.state.prs[0].state = "closed";
  f.state.prs[0].merged_at = "2026-09-29T12:00:00Z";
  f.git("push", "origin", "--delete", first.branch);
  f.reset();
  const second = f.publish();
  assert.equal(second.status, "created");
  assert.equal(second.branch, first.branch.replace(/-1$/, "-2"));
});

test("PR goes ready/closed/merged during publication: no existing ref or PR is modified", t => {
  const f = fixture(t);
  const pr = f.oldPR();
  f.state.beforeGit = args => {
    if (args[0] === "push") {
      pr.draft = false;
      pr.state = "closed";
      pr.merged_at = "2026-09-29T12:00:00Z";
    }
  };
  assert.equal(f.publish().status, "created");
  assertUntouched(f, pr, structuredClone(pr));
});

test("PR closes during fetch and its listed SHA becomes unavailable: clean skip", t => {
  const f = fixture(t);
  const pr = f.oldPR();
  f.state.beforeGit = args => {
    if (args[0] === "fetch") {
      pr.state = "closed";
      throw new Error("Listed commit is no longer available");
    }
  };
  assert.equal(f.publish().status, "skipped");
  assertUntouched(f, pr, structuredClone(pr));
});

test("unrelated fetch/network failure remains a hard failure", t => {
  const f = fixture(t);
  f.oldPR();
  f.state.beforeGit = args => {
    if (args[0] === "fetch") throw new Error("Network failure");
  };
  assert.throws(() => f.publish(), /Network failure/);
});

test("two publishers claim the same new name: empty-SHA lease protects even fast-forwardable human ref", t => {
  const f = fixture(t);
  let branch;
  f.state.beforeGit = args => {
    if (args[0] === "push") {
      branch = args.at(-1).replace("HEAD:refs/heads/", "");
      f.exec("git", ["update-ref", `refs/heads/${branch}`, f.baseSha], f.remote);
    }
  };
  assert.equal(f.publish().status, "skipped");
  assert.equal(f.git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/)[0], f.baseSha);
  assert.equal(f.state.prs.length, 0);
});

test("default branch advances after validation: clean skip before push", t => {
  const f = fixture(t);
  f.state.beforeGit = args => {
    if (args[0] === "commit") {
      const advanced = f.exec("git", ["commit-tree", `${f.baseSha}^{tree}`, "-p", f.baseSha, "-m", "default advanced"], f.remote);
      f.exec("git", ["update-ref", "refs/heads/main", advanced], f.remote);
    }
  };
  assert.equal(f.publish().status, "skipped");
  assert.ok(!f.state.calls.some(call => call[0] === "git" && call[1] === "push"));
});

test("PR creation succeeds but response is lost: success and retry deduplication", t => {
  const f = fixture(t);
  f.state.createError = "lost-response";
  assert.equal(f.publish().status, "skipped");
  f.reset();
  assert.equal(f.publish().status, "skipped");
  assert.equal(f.state.prs.length, 1);
});

test("real API failure still fails; orphan branch cannot block a later successful sync", t => {
  const f = fixture(t);
  f.state.createError = "network";
  assert.throws(() => f.publish(), /GitHub unavailable/);
  const orphan = f.git("branch", "--show-current");
  const orphanSha = f.git("rev-parse", "HEAD");
  f.reset();
  f.state.createError = null;
  const result = f.publish();
  assert.equal(result.status, "created");
  assert.equal(result.branch, orphan.replace(/-1$/, "-2"));
  assert.equal(f.git("ls-remote", "--heads", "origin", `refs/heads/${orphan}`).split(/\s/)[0], orphanSha);
});

test("fork PR with automation name cannot reserve or deduplicate the repository's candidate", t => {
  const f = fixture(t);
  f.state.prs.push(f.makePR(prefix, "not-a-real-sha", { head: { ref: prefix, sha: "not-a-real-sha", repo: { full_name: "fork/varzia" } } }));
  assert.equal(f.publish().status, "created");
});

test("dirty checkout remains a hard failure; no unrelated changes can be published", t => {
  const f = fixture(t);
  writeFileSync(path.join(f.cwd, "README.md"), "unrelated change\n");
  assert.throws(() => f.publish(), /not clean/);
  assert.equal(f.state.calls.filter(call => call[0] === "gh").length, 0);
});

test("single bot commit allowlist guard still rejects non-data content before any push", t => {
  const f = fixture(t);
  f.state.beforeGit = args => {
    if (args[0] === "commit") {
      writeFileSync(path.join(f.cwd, "README.md"), "injected unrelated change\n");
      f.git("add", "README.md");
    }
  };
  assert.throws(() => f.publish(), /non-data change/);
  assert.ok(!f.state.calls.some(call => call[0] === "git" && call[1] === "push"));
});

test("CLI simulation: existing automation PR is no longer Draft exits 0 and preserves the reviewed branch", t => {
  const f = fixture(t);
  const pr = f.oldPR({ draft: false, human: true });
  const snapshot = structuredClone(pr);
  const bin = path.join(f.temp, "bin");
  mkdirSync(bin);
  const apiFixture = path.join(f.temp, "prs.json");
  const callsFile = path.join(f.temp, "gh-calls.jsonl");
  writeFileSync(apiFixture, JSON.stringify(f.state.prs));
  const fakeGh = path.join(bin, "gh");
  writeFileSync(fakeGh, `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_GH_CALLS, JSON.stringify(args) + '\\n');
const prs = JSON.parse(readFileSync(process.env.TEST_GH_PRS, 'utf8'));
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'api') {
  console.log(JSON.stringify(args[1].includes('?') ? [prs] : prs.find(pr => String(pr.number) === args[1].split('/').at(-1))));
} else if (args[0] === 'pr' && args[1] === 'create' && args.includes('--draft')) {
  console.log('https://github.com/example/varzia/pull/2');
} else { throw new Error('Unexpected gh mutation: ' + JSON.stringify(args)); }
`);
  chmodSync(fakeGh, 0o755);
  const script = new URL("../scripts/prime-resurgence-publish.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], {
    cwd: f.cwd, encoding: "utf8", env: { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TEST_GH_PRS: apiFixture, TEST_GH_CALLS: callsFile,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created Draft candidate PR/);
  assertUntouched(f, pr, snapshot);
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(args => args[0] === "pr").length, 1);
  assert.ok(calls.some(args => args[0] === "pr" && args[1] === "create" && args.includes("--draft")));
});

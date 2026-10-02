import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYNC_MUTABLE_DATA_PATHS } from "./lib/prime-resurgence-sync.mjs";

const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

// Collection times change on every run against an unmerged candidate. They
// are audit metadata, not new data; retain all source/effective timestamps.
function candidateContent(value, historyEntry = false) {
  if (Array.isArray(value)) return value.map(entry => candidateContent(entry, historyEntry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => key !== "discoveredAt" && key !== "checkedAt" && !(historyEntry && key === "at"))
      .map(key => [key, candidateContent(value[key], key === "statusHistory")]));
  }
  return value;
}

// Existing branches are immutable, even while Draft. GitHub cannot atomically
// test a PR's Draft state and update its Git ref; a second state check alone
// would still allow a ready/merge race to change a human-owned branch.
export function publishCandidate({ env = process.env, cwd = process.cwd(), run, log = console.log } = {}) {
  const execute = run ?? ((command, args) => execFileSync(command, args, {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env, cwd
  }));
  const git = (...args) => execute("git", args).trim();
  const gh = (...args) => execute("gh", args).trim();
  const { BASE_BRANCH: base, AUTOMATION_BRANCH: prefix, GITHUB_REPOSITORY: repo, PR_TITLE: title } = env;
  if (!base || !prefix || !repo || !title || !env.RUNNER_TEMP) throw new Error("Missing publish environment.");
  git("check-ref-format", "--branch", base);
  git("check-ref-format", "--branch", prefix);
  const artifact = path.join(env.RUNNER_TEMP, "prime-resurgence-candidate");
  const baseSha = readFileSync(path.join(artifact, "base-sha.txt"), "utf8").trim();
  readFileSync(path.join(artifact, "pr-body.md"), "utf8");
  if (!/^[a-f0-9]{40}$/.test(baseSha) || git("rev-parse", "HEAD") !== baseSha) {
    throw new Error("Checkout does not match the validated candidate base.");
  }
  if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("Publish checkout is not clean.");
  gh("auth", "setup-git");
  const remoteHead = branch => git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(/\s/)[0];
  const currentBase = () => {
    const sha = remoteHead(base);
    if (!sha) throw new Error("Default branch is missing.");
    return sha === baseSha;
  };
  const skip = reason => {
    log(reason);
    return { status: "skipped", reason };
  };
  if (!currentBase()) return skip("Default branch advanced after validation; waiting for a fresh sync.");

  for (const file of SYNC_MUTABLE_DATA_PATHS) copyFileSync(path.join(artifact, file), path.join(cwd, file));
  git("diff", "--check");
  const changed = git("diff", "--name-only").split("\n").filter(Boolean);
  if (changed.some(file => !SYNC_MUTABLE_DATA_PATHS.includes(file))) throw new Error("Unexpected artifact path.");
  if (!changed.length) return skip("No candidate diff against the default branch.");
  git("add", "--", ...SYNC_MUTABLE_DATA_PATHS);
  git("diff", "--cached", "--check");
  const snapshot = read => JSON.stringify(SYNC_MUTABLE_DATA_PATHS.map(file => [file, candidateContent(JSON.parse(read(file)))]));
  const candidateSnapshot = snapshot(file => readFileSync(path.join(cwd, file), "utf8"));
  if (candidateSnapshot === snapshot(file => git("show", `${baseSha}:${file}`))) {
    return skip("No substantive candidate diff against the default branch.");
  }
  const digest = createHash("sha256").update(candidateSnapshot).digest("hex").slice(0, 20);

  // Paginate all states: closed/merged PRs reserve names even after their refs
  // are deleted. Forks with a similarly named branch do not own our refs.
  const listPRs = () => JSON.parse(gh("api", `repos/${repo}/pulls?state=all&per_page=100`, "--paginate", "--slurp"))
    .flat().filter(pr => pr.head.repo?.full_name === repo &&
      (pr.head.ref === prefix || pr.head.ref.startsWith(`${prefix}-`)));
  const sameData = sha => {
    git("fetch", "--no-tags", "origin", sha);
    if (git("ls-tree", "-r", "--name-only", sha, "--", ...SYNC_MUTABLE_DATA_PATHS).split("\n").length !== SYNC_MUTABLE_DATA_PATHS.length) return false;
    try {
      return snapshot(file => git("show", `${sha}:${file}`)) === candidateSnapshot;
    } catch (error) {
      // Human edits may leave invalid JSON. Preserve that branch and roll over.
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  };
  let prs = listPRs();
  for (const pr of prs.filter(pr => pr.state === "open" && pr.base.ref === base)) {
    let matches;
    try {
      matches = sameData(pr.head.sha);
    } catch (error) {
      // A close/merge/force-push between listing and fetching can make the
      // listed SHA unavailable. Retry next run, without masking real failures.
      const latest = JSON.parse(gh("api", `repos/${repo}/pulls/${pr.number}`));
      if (latest.state !== "open" || latest.head.sha !== pr.head.sha) {
        return skip("Automation PR changed during candidate comparison; waiting for a fresh sync.");
      }
      throw error;
    }
    if (!matches) continue;
    const latest = JSON.parse(gh("api", `repos/${repo}/pulls/${pr.number}`));
    if (latest.state === "open" && latest.base.ref === base && latest.head.sha === pr.head.sha) {
      return skip(`Candidate already present in ${latest.draft ? "Draft" : "review"} PR #${pr.number}; leaving it untouched.`);
    }
  }

  // Reserve a deterministic content name plus a generation. Never reuse a
  // ref recorded in PR history or present on the remote (including orphans).
  const reserved = new Set(prs.map(pr => pr.head.ref));
  const refs = git("ls-remote", "--heads", "origin").split("\n").filter(Boolean);
  for (const ref of refs) reserved.add(ref.split(/\s+/)[1].replace(/^refs\/heads\//, ""));
  let generation = 1;
  while (reserved.has(`${prefix}-${digest}-${generation}`)) generation++;
  const branch = `${prefix}-${digest}-${generation}`;
  git("check-ref-format", "--branch", branch);
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", BOT_EMAIL);
  git("switch", "--create", branch, baseSha);
  git("commit", "-m", title);

  // Preserve the original ownership/allowlist checks, now before publishing
  // a new ref rather than as permission to overwrite an existing one.
  const mergeBase = git("merge-base", baseSha, "HEAD");
  if (mergeBase !== baseSha || git("rev-list", "--count", `${mergeBase}..HEAD`) !== "1") {
    throw new Error("Automation branch is not exactly one bot-owned candidate commit.");
  }
  if (git("show", "-s", "--format=%ae", "HEAD") !== BOT_EMAIL) throw new Error("Unexpected automation branch author.");
  if (git("show", "-s", "--format=%s", "HEAD") !== title) throw new Error("Unexpected automation branch commit subject.");
  if (git("diff", "--name-only", mergeBase, "HEAD").split("\n").some(file => !SYNC_MUTABLE_DATA_PATHS.includes(file))) {
    throw new Error("Automation branch contains a non-data change.");
  }
  if (!currentBase()) return skip("Default branch advanced after validation; waiting for a fresh sync.");
  try {
    // An empty expected SHA means the ref MUST NOT exist. Even an ordinary
    // push could fast-forward a concurrently created human ref; this cannot.
    git("push", `--force-with-lease=refs/heads/${branch}:`, "origin", `HEAD:refs/heads/${branch}`);
  } catch (error) {
    if (remoteHead(branch)) return skip("Candidate branch was claimed concurrently; leaving it untouched for the next sync.");
    throw error;
  }
  if (!currentBase()) return skip("Default branch advanced before PR creation; waiting for a fresh sync.");
  if (remoteHead(branch) !== git("rev-parse", "HEAD")) return skip("Candidate branch changed before PR creation; leaving it untouched.");
  prs = listPRs();
  if (prs.some(pr => pr.head.ref === branch)) return skip("Candidate branch already has PR history; leaving it untouched.");
  try {
    const url = gh("pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title,
      "--body-file", path.join(artifact, "pr-body.md"), "--draft");
    log(`Created Draft candidate PR: ${url}`);
    return { status: "created", branch, url };
  } catch (error) {
    // A successful create with a lost response (or a concurrent manual create)
    // must not turn into a duplicate PR on retry.
    if (listPRs().some(pr => pr.head.ref === branch)) return skip("Candidate PR was created concurrently; leaving it untouched.");
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishCandidate();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

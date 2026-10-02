# Codex + skill review runner

> Status: this describes the earlier Codex implementation proposal in draft PR6. The current requested deliverable is the Chinese [Sandbox agent architecture design](sandbox-agent-architecture.md), covering Claude Code, Codex, and OpenCode with native named persistence. Per-run login below is an implementation choice, not a Vercel limitation; this document does not establish that account-auth automation is approved or applicable to this public repository.

`npm run sandbox:agent` launches the Codex bundled in Vercel's universal image and explicitly invokes `$varzia-official-update`. Codex reads the repository skill, runs the deterministic official updater, examines the evidence, runs repository and locale checks, and returns a structured review report. The host independently rebuilds the result from the pinned original commit before approving any export. This path uses the user's ChatGPT subscription through device-code login; it has no API-key or AI Gateway billing fallback.

## Inspect and run

Install the existing pinned host SDK with `npm ci --prefix tools/sandbox --ignore-scripts`. The host needs existing Vercel Sandbox credentials as described in [sandbox-runner.md](sandbox-runner.md); these are separate from Codex account authentication.

Inspect the plan without a VM, login, credentials, source fetch, or model request:

```sh
npm run sandbox:agent -- --plan --revision REVIEWED_40_CHARACTER_SHA --model ACCOUNT_MODEL_ID
```

The revision must contain the reviewed skill and `scripts/prime-resurgence-agent-tool.mjs` with bytes matching the host checkout. The pre-skill main commit `42ff791` cannot run this new executor. Use the full reviewed commit SHA from the agent implementation branch, then review the entire source at that SHA before passing `--trusted-source`. A changed bundle, project Codex configuration, alternate skill, AGENTS file, symlink, or dirty checkout fails before login. No new project, Vercel login, snapshot, dependency installation, or sudo bootstrap is attempted.

Run only from your private interactive terminal, after reviewing the plan and accepting Sandbox compute usage and subscription usage:

```sh
npm run sandbox:agent -- --revision REVIEWED_40_CHARACTER_SHA \
  --model ACCOUNT_MODEL_ID --reasoning-effort xhigh --mode check \
  --trusted-source --device-login --output /tmp/varzia-agent-unique
```

Use `--mode update` to prepare provisional data. `ACCOUNT_MODEL_ID` is an explicit model available to your Codex account, for example `gpt-6.1-sol` if your account exposes that ID. The runner does not discover, substitute, retry with a different model, or route to a Gateway model. Missing authorization flags, a noninteractive terminal, or missing existing Sandbox credentials allocate no VM.

The VM runs `codex login --device-auth`. The terminal displays only the exact official login URL and short one-time code, without forwarding raw login diagnostics. Complete the sign-in yourself on the official page. Device login must be enabled in your ChatGPT security settings or workspace permissions. The runner requires `codex login status` to report ChatGPT auth and forces `model_provider="openai"` and `forced_login_method="chatgpt"`. An unavailable/expired login stops before model execution.

## Credential lifecycle

Each invocation creates a new nonpersistent VM. The Codex cache exists only at `/tmp/varzia-host-control/codex` **inside that VM**; Codex may store and refresh its `auth.json` there during this run. No host auth file is read or uploaded. The host never reads the VM auth file, exports tokens, stores login logs, or snapshots/mounts a credential drive. The Codex command permission profile denies all reads and writes to the entire host-control directory, and a non-model guard proves that private reads and source writes are denied **before** login.

After Codex finishes, the host erases that cache and removes account domains from the VM firewall before independent validation. All error paths also attempt cache erasure and VM shutdown. `report.json` records `authErased`, `stopped`, and cleanup errors; a cleanup failure withholds every candidate. A failed shutdown requires inspection of the reported VM identity in the Vercel Sandbox dashboard. SDK/host interruption cannot guarantee immediate shutdown, so the VM's independent five-minute maximum lifetime is also required.

The next run requires device login again. This implementation is on-demand, and does not turn account login into unattended scheduled automation. Persistent account authorization is a separate design and approval decision: specify trusted private runner ownership, secure credential storage, refresh handling, retention, revocation, and access restrictions before adding it. No such storage or authorization has been configured. Do not expose this runner to public CI jobs, fork PRs, arbitrary SHAs, or other users.

## Enforced boundaries

| Layer | Boundary |
| --- | --- |
| VM | `@vercel/sandbox` 3.5.1; `image: vercel/sandbox/universal`; `persistent: false`; no ports, snapshots, shared drives, or credentials in VM env |
| Runtime | Node 24, bundled `codex-cli >=0.159`, and `xz` are checked; unsupported/missing tools fail before login |
| Source | Fixed repository and full SHA; trusted skill/tool hashes; clean regular source; `.codex`, alternate `.agents` content, and AGENTS rejected |
| Codex commands | Named permission profile: source read-only; `data/` writable in update mode; `/tmp/varzia-agent-work` writable; host-control and `/proc` denied; no approval escalation |
| Codex configuration | CLI overrides; ignore user config/rules; ephemeral session; hosted web search, plugins, hooks, and additional agents disabled; no `danger-full-access` or bypass flags |
| Network | Checkout permits only `github.com`; agent phase permits exact official-source hosts plus `auth.openai.com` and `chatgpt.com`; host validation permits only official-source hosts |
| Command network | Active Codex proxy allows only official-source domains, excluding auth/model, GitHub publishing and deployment destinations; VM firewall also controls Codex service traffic |
| Candidate | All four managed files must byte-match host recomputation from the original commit using the same frozen time; unavailable or changing official evidence fails closed |
| Export | Host-only canonical checkout supplies data and patch; host rechecks schemas, tests, locale, paths, untracked files and artifact types; exports occur only after successful shutdown |
| Publication | Review patch only; no agent GitHub write credentials, commit, push, PR creation, release preparation, merge or deploy |

The `data/` write grant allows the updater's atomic temporary-file writes. The host still accepts only `data/rotation.json`, `data/primes.json`, `data/relics.json`, and `data/prime-resurgence-candidates.json`; a source edit or unexpected file aborts before running repository code again. Official source consistency, existing published rotations, numerical probabilities, recipes, locale evidence, and provisional publication behavior remain the deterministic updater's responsibility. Source/upstream instructions cannot extend the profile or the host export/publication allowlist. Model assertions and command classification are observations, never authority to approve data.

The agent copy cannot access the private canonical checkout. Final `verify`, locale checks, diff, patch, and JSON exports come from that copy, so late agent/background writes cannot replace approved data. Real credentials are absent by this stage. A successful report includes the actual CLI version, bundle SHA256, frozen verification time, command exits, skill/tool observations, aggregate usage, model review, VM identity, shutdown outcome, and standard validated artifacts. Failed runs export only `report.json` and redacted `commands.log`; raw JSONL, reasoning, tool output, thread identifiers and login codes are not exported.

## Budgets and operational limits

The VM lifetime is capped at 300 seconds, including bootstrap/login/model/validation. Default device login budget is 90 seconds and model command budget is 120 seconds. `--login-timeout-ms` (1–90 seconds), `--agent-timeout-ms` (1–150 seconds), and `--timeout-ms` (30–300 seconds) must leave at least 30 seconds for validation; every host command also receives the remaining deadline. No timeout extension or model retry is allowed. An output limit terminates oversized model streams. Cleanup has a separate bounded attempt.

`--max-total-tokens` defaults to 100000 and accepts 1000–200000. This is an **observed acceptance limit after the single completed turn**, not a prebilling hard spend cap: Codex's CLI does not expose a verified per-request dollar/subscription budget here. Usage above the limit withholds artifacts but has already consumed account usage. Hard operational controls are wall time, one invocation/turn, bounded output, no retries, and no API/Gateway fallback. Sandbox compute is billed independently of the ChatGPT subscription. This implementation has not incurred VM/model usage during development.

The managed universal tag rolls nightly. Its actual CLI version and permission guard must pass every run; no snapshot contents or old `node22` runtime are assumed to include Codex. A reviewed digest could be added later after inspecting an actual image. The original deterministic `sandbox:run` retains Node 22 and existing behavior, and CI/scheduled publishing remain unchanged. Native Ubuntu permission enforcement, actual bundled versions, device login, current model availability and official-source access still need a separately authorized live smoke run. Mock success does not establish these runtime facts.

## Verified interfaces

Implementation uses the installed SDK 3.5.1 declarations (`image`, `persistent`, `networkPolicy`, `updateNetworkPolicy`, `runCommand`, `timeoutMs`, `logs`, `wait`, `kill`, file methods, and abort signals) and local Codex 0.159.3 CLI help. A credential-free native macOS `codex sandbox` probe passed: private reads and source writes were denied while data and scratch writes were permitted. This checks the CLI/TOML interface and macOS enforcement, not the untested Linux VM. Permissions are passed as one TOML table because CLI dotted override keys split domain names containing dots. Official references checked on 2026-10-02:

- [Vercel Sandbox includes Codex](https://vercel.com/sandbox), [managed images](https://vercel.com/docs/sandbox/concepts/images), [SDK reference](https://vercel.com/docs/sandbox/sdk-reference), [firewall](https://vercel.com/docs/sandbox/concepts/firewall).
- [Codex authentication and device login](https://developers.openai.com/codex/auth), [noninteractive execution and JSONL/schema output](https://developers.openai.com/codex/noninteractive), [repository skills](https://developers.openai.com/codex/skills), [permission profiles and enforcement](https://learn.chatgpt.com/docs/permissions).

No HarnessAgent migration is needed for this subscription route: the host lifecycle stays intact while the bundled Codex actually consumes the skill and executes its tools. Gateway/HarnessAgent integration would introduce separate auth/billing choices that this implementation does not make.

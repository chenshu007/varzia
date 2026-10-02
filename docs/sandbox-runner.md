# On-demand Varzia updater and check runner (STA-7)

The runner starts one ephemeral Vercel Sandbox, clones only `chenshu007/varzia` at a full commit SHA, runs the existing official-data updater and the complete repository checks, exports review artifacts, and stops the VM. It uses the SDK's Node 22 runtime to match CI and installs the updater's `xz` decompressor into that temporary VM with `dnf`. The static Cloudflare Pages application stays unchanged.

Install the separate host tool dependency:

```sh
npm ci --prefix tools/sandbox --ignore-scripts
```

Inspect the plan without credentials, network requests, or a VM:

```sh
npm run sandbox:run -- --plan --revision FULL_40_CHARACTER_COMMIT_SHA
```

Use an existing `VERCEL_OIDC_TOKEN`, or all three existing `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` environment variables. Authentication stays on the host. The runner does not start a login, create a project, provision credentials, or copy host environment variables into the VM. Do not put secrets in command arguments or committed files.

Run a check or prepare an update in a new output directory whose parent already exists:

```sh
npm run sandbox:run -- --revision FULL_40_CHARACTER_COMMIT_SHA --mode check --output /tmp/varzia-check-unique
npm run sandbox:run -- --revision FULL_40_CHARACTER_COMMIT_SHA --mode update --output /tmp/varzia-update-unique
```

`check` calls the updater with `--dry-run` and requires an empty tracked diff. `update` allows only the four managed JSON files to change. Both run `npm run verify` and `npm run check:locales` against the resulting data. A command, checkout, validation, unexpected path, or shutdown failure withholds all candidate artifacts. Each VM has a maximum five-minute lifetime; `stop()` runs on success and failure. No scheduler, snapshots, custom network policy, exposed ports, GitHub write credentials, push, merge, or deployment is configured.

A successful output contains `report.json`, redacted `commands.log`, `sync-summary.md`, `candidate.patch`, and four validated `data/` JSON files. The report records the repository SHA, command exit codes, changed paths, VM identity, timestamps, and shutdown result. Results are exported into a separate new directory; they are never applied to the local checkout. Existing output directories are rejected. A failed run keeps diagnostics only. Human review and a separate PR remain the publication gate.

World State sometimes returns 403 from Linux networks. When unavailable, the updater can revalidate a uniquely known active rotation using fresh English/Chinese current pages, the exact pair-specific Vault group, official numeric drop probabilities, and Public Export recipes. A missing/conflicting page, ambiguous identity, or missing exact Vault fails closed. This fallback reports the World State warning and retains `planner-preset` pricing evidence; it does not claim an observed sale price.

## Prepare a publication proposal

Ordinary updater and Sandbox update runs always keep newly generated rotations provisional. To propose publication of a validated candidate after the official current pages confirm it is live, invoke the explicit release preparation tool on an isolated review branch:

```sh
npm run prime-resurgence:prepare-release -- ROTATION_ID
npm run prime-resurgence:prepare-release -- ROTATION_ID --write
```

The default is a dry run. `--write` rechecks current pages, announcements, the exact Vault, drop tables, recipes, and available live inventory, then produces a `published` data diff for a human-reviewed PR. It does not commit, push, merge, or deploy. Announcement publication time and first actual data preparation time are stored separately. The consumed ready candidate is removed so it does not refer to a now-published rotation.

# i18n and Sandbox comparison (STA-8)

Verified on 2026-10-02 after the existing STA-6 fix and the STA-7 implementation. The scope follows the current Linear descriptions: compare results, differences, advantages, disadvantages, and the next decision. Publication remains subject to human review of [draft PR #5](https://github.com/chenshu007/varzia/pull/5).

## What each change solves

| Concern | Existing STA-6 i18n fix | STA-7 Sandbox runner |
| --- | --- | --- |
| Problem | A growing or reordered official catalog broke a fixed English-name array assertion. | An updater needs a reproducible, isolated environment and reviewable output. |
| Implementation | Commit `bd72a768` resolves known records by ID and checks bilingual fields across every record, including future candidate fixtures. | The host starts an ephemeral Node 22 VM at an exact repository SHA, installs `xz`, runs official-data sync and full verification, validates exports, and stops the VM. |
| Coverage | English equipment/relic/part names, canonical Chinese immutability, catalog growth, record ordering, and unchanged simulation results. | Checkout identity, runtime, sync, all repository tests, generated locale consistency, managed-path limits, validated data artifacts, and shutdown. |
| User-visible result | Catalog additions retain correct English and Chinese display names. | The same application data and i18n behavior, plus on-demand isolated checks and update artifacts for review. |
| Limitation | Assertions do not isolate execution or prove that live upstream endpoints are reachable. | VM isolation does not supply missing translations; the complete i18n tests must still pass after generation. |

The changes are complementary. STA-6 changes test robustness, while STA-7 provides a second execution environment. Neither changes Monte Carlo probabilities, required quantities, or CDF behavior. A schema-only validation would miss absent English names, so the runner executes the full test suite against its resulting data before exporting anything.

## Same-commit execution evidence

Code and data revision: `dd520f067eb6fa4eb30d2a33b51b0013a99b3444`. The later comparison-document commit does not change this executable revision.

| Check | Local Mac | Sandbox check | Sandbox update |
| --- | --- | --- | --- |
| Runtime | Node 26.10; xz 5.8.4 | Node 22; xz 5.2.5 | Node 22; xz 5.2.5 |
| Official-data result | No change; live World State matches the proposed published rotation | No change; current pages plus exact Vault match the proposed published rotation | Same as Sandbox check |
| Lineup / relics / required parts | 6 / 6 / 26 | 6 / 6 / 26 | 6 / 6 / 26 |
| Public Export recipes | 6/6; no manual exceptions | 6/6; no manual exceptions | 6/6; no manual exceptions |
| Full verification | 374 tests passed; syntax and diff checks passed | 374 tests passed; syntax and diff checks passed | 374 tests passed; syntax and diff checks passed |
| Locale generation check | Passed | Passed | Passed |
| Tracked changes / patch bytes | No data changes | None / 0 | None / 0 |
| VM lifecycle | Not applicable | Passed and stopped, 48.979 seconds | Passed and stopped, 47.258 seconds |
| Execution window (UTC) | 2026-10-02, immediately before comparison | 22:11:25.242–22:12:14.221 | 22:12:47.475–22:13:34.733 |

Both Sandbox runs exported all four managed JSON files. Each exported file is byte-for-byte identical to the local PR file, with these SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `data/rotation.json` | `1874bc764fc7411659e864b70857dca407f62e6adb2d86a34560cae6e8364d6f` |
| `data/primes.json` | `8fb1b6b10d0e2fe43eab08a0ff55414395a26188e111c6899dc86ea4d4a098b5` |
| `data/relics.json` | `381db49bb368cb01190c100a978432279921e32a53aa7b322d93ef7f980c6fb2` |
| `data/prime-resurgence-candidates.json` | `3c66f850be3e3ee0d24978fea060b1a582ca4284d00ead26737f743cdfae7a69` |

The ignored local evidence directories are `artifacts/sandbox-check-dd520f0` and `artifacts/sandbox-update-dd520f0`, containing `report.json`, `commands.log`, `sync-summary.md`, an empty `candidate.patch`, and the validated data. These successful live runs exercise today's no-change path; fixture tests separately exercise generated updates and rejection of failures, unexpected paths, invalid data, and shutdown errors.

## Observed differences and fixes

1. World State returned HTTP 403 in the VM, while it succeeded on the Mac. The VM used fresh English and Chinese current pages, the exact `ProteaIvaraVault`, official numeric drop probabilities, and Public Export recipes. Its summary records the warning and treats price as the planner preset; it does not claim a live observed price. Mac validation separately confirmed six relics at 1 Aya from October 1, 18:00 UTC to October 29, 18:00 UTC. Missing/conflicting official evidence still fails validation.
2. The default VM did not include `xz`. The runner now installs it inside the temporary VM before sync.
3. Sandbox xz 5.2.5 rejected the official known-size LZMA stream with its end marker. The file received by both environments had the same compressed SHA-256. The bounded compatibility retry changes only the size header to unknown-size, retains the complete compressed input, requires successful end-marker decoding, and checks the original **raw** output byte count. Tests reject truncation, trailing garbage, an incorrect size, oversized output, and invalid UTF-8 that would otherwise distort the size check.
4. Five old sync fixtures depended on the actual clock and on subsequently published catalog entries. Their time and baseline data are now fixed, while explicit boundary-time tests retain their own supplied clocks. This is separate from the earlier STA-6 catalog-growth repair.

## Decision

Keep the existing static Cloudflare Pages application and human-reviewed PR publication flow. Use the on-demand Sandbox runner as an optional isolated updater/check environment with an exact commit, bounded lifetime, host-only authentication, and exported review artifacts. Continue running the STA-6 i18n assertions and the complete verification suite in both CI and Sandbox.

The extra VM startup and temporary dependency installation cost about 48 seconds in these runs. Endpoint access can differ by environment, so reports must distinguish observed inventory from page/Vault fallback evidence. No scheduler, automatic publication, persistent VM, network-policy change, new project, or credential grant is needed for this decision. The current PR is ready for human review; merge and publication have not been performed.

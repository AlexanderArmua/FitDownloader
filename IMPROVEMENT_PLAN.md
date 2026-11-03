# FitDownloader improvement plan

Created: 2026-11-03 (America/Buenos_Aires).

This is a trackable implementation backlog and handoff document for the project. Read alongside `AGENTS.md`. The test foundation and REL-01 through REL-07 are implemented and validated. Remaining reliability and product work is tracked below.

## Resume checkpoint

| Field | Current value |
| --- | --- |
| Work status | REL-07 complete: awaited controls, partial-success reporting and retained download ownership on API rejection. Version 0.2.5 published to the user's repository after required CI passed. |
| Primary repository | https://github.com/AlexanderArmua/FitDownloader |
| Source baseline | Original reviewed commit `a4afffa92c75d89ccc3b9061ba2ecdd65d82531e`, version 0.2.1; current runtime commit `6fdac97`, version 0.2.5. |
| Current implementation branch | REL-07 branch `fix/browser-operation-failures`, runtime commit `6fdac97`, fast-forwarded to `main` with this documentation checkpoint. Start a new focused branch for REL-09. |
| Next task | **REL-09:** early download-completion registration, then REL-08 browser download-manager event synchronization. |
| Latest implementation boundary | Awaited per-file Chrome controls, persisted retry intent/errors, generation-safe partial Cancel, late creation recovery, failed-query preservation and popup retry/error handling. Host protocol and permissions unchanged. |
| Next behavior work | Reproduce terminal download events arriving before the creation callback/map registration, including tiny downloads, recovery and Cancel interleavings. Reconcile before releasing slots; prevent duplicate starts. |
| Current validation | `npm run check`: 172 passing unit/DOM tests. `npm run test:browser`: all 11 pass. All 63 named regressions pass. Coverage: 93.26% lines / 89.59% branches / 98.59% functions, above unchanged floors. Required Windows/Linux unit and Chromium CI jobs passed: https://github.com/AlexanderArmua/FitDownloader/actions/runs/41763729760 . |
| Product decisions | Closing source pages keeps started batches; the popup exposes saved batches from any tab. Full browser startup pauses queues until Resume; worker wake continues eligible work after reconciliation. Global concurrency remains an optional future feature. |
| Blockers | None. Windows browser tests need normal process permissions. |
| Changed areas | Chrome control/search failure handling, durable error/retry fields, popup partial-result/retry flow, failure regression tests, real Chrome rejection integration, version 0.2.5 and docs. |
| Publication status | User authorized pushing and continuing on 2026-11-03. REL-07 runtime `6fdac97` passed all required CI before advancing own main. This documentation checkpoint records publication. No release object created. |

To resume in a new chat, ask: **“Read AGENTS.md and IMPROVEMENT_PLAN.md, inspect the checkout, and continue from the resume checkpoint.”**

When work stops, replace this checkpoint with current facts. Do not make a future reader reconstruct progress from the chat or the entire work log.

## Decisions and constraints

- Tests come before behavior changes. Build a useful safety net first, then fix recovery bugs; do not wait for exhaustive coverage to fix them.
- The scope is the user's fork. `origin` is AlexanderArmua/FitDownloader; `upstream` is axel-devs/FitDownloader. Existing upstream PR #2 is independent of this backlog.
- Preserve the functioning ad-free host resolver. The user confirmed real downloads worked after the POST-flow change. That is manual user confirmation, not proof that every supported response format has been tested live.
- No automatic ad-page opening, remote script execution, CAPTCHA solving, browser-security weakening, or broader host access as an incidental change.
- The user authorized starting test work on 2026-11-03. That foundation is now local; continue from the current checkpoint, not from the original planning state.
- Current runtime is plain JavaScript/HTML/CSS with no package installation required for the existing tests. Add tooling selectively; a framework migration is not a prerequisite.
- Keep default-branch checks green. Demonstrate a failing regression locally, fix it, then merge the passing test and fix together. Any intentionally deferred test must be explicit and tracked; do not count it as covered behavior.
- Numerical coverage targets are proposed goals, not evidence of correctness or blockers to urgent fixes. Capture a truthful baseline before selecting enforceable thresholds.
- Do not implement all 60 items as one change. Each checkbox is independently trackable; phase exit criteria define sensible stopping points.
- Optional features may require additional browser permissions or a product decision. Document the tradeoff before implementing them; do not silently widen permissions.

## Original review baseline and architecture (historical)

This section records the starting point. Current commands and results are in the resume checkpoint, `AGENTS.md`, and `tests/README.md`; TEST-01 has now replaced the coverage setup described below.

| Component | Present behavior / limitation |
| --- | --- |
| `background.js` | MV3 service worker, more than 1,000 lines; includes host parsing, queue, persistence, download events, and message handlers. |
| `popup.js` / `popup.html` | Selection, batch status, concurrency input, and embedded settings. Selection currently lives primarily in the popup DOM. |
| `options.js` / `options.html` | Separate settings implementation, but no `options_page`/`options_ui` registration in the manifest. |
| `manifest.json` | Version 0.2.1; HTTPS permissions for the source site and supported file hosts; downloads/storage/scripting/tabs/activeTab permissions. |
| `tests/background.test.cjs` | VM-based tests with mocked Chrome APIs and network responses. |
| `tests/popup.test.cjs` | Three tests, mainly input validation, settings synchronization, and message order; does not exercise a real browser DOM. |
| Repository tooling | No checked-in CI workflow, package scripts, lint/type-check configuration, release workflow, or LICENSE file at review time. |

Current test command:

```text
node --test tests/*.test.cjs
```

The review ran on Node **24.8.0**, Windows/PowerShell. Record the supported version explicitly when tooling is added.

### Coverage caveat

The normal coverage command currently reports 100% with **no application files listed**. That result is invalid as an application baseline. Application code is executed through unnamed `vm.runInContext` calls.

A temporary diagnostic supplied real file URLs to the existing VM calls, without changing repository files, and obtained:

| Application script | Line coverage | Branch coverage | Function coverage |
| --- | ---: | ---: | ---: |
| `background.js` | 50.79% | 67.01% | 69.81% |
| `popup.js` | 31.50% | 60.00% | 25.00% |
| `options.js` | Not executed | Not measured | Not measured |

The combined line result for the two measured files was 44.90%; it excludes the unexecuted options script and is **not** whole-repository coverage. Treat these as diagnostic observations, not permanent CI thresholds.

For TEST-01, supply explicit filenames for application VM execution or introduce importable units without changing behavior. Also ensure unexecuted application files appear in reporting; naming VM scripts alone does not solve that denominator problem. Do not count test harness or syntax-compilation coverage as runtime application coverage.

## Execution phases and gates

### Phase 0 — Establish trustworthy checks

Tasks: TEST-01, TEST-02, TEST-03, TEST-07, TEST-08, DEV-01, DEV-02. TEST-06 can expand incrementally with each bug fix.

1. Inspect branch/status and rerun the existing 25-test suite.
2. Fix coverage accounting before setting thresholds.
3. Improve shared mocks and add characterization tests for behavior that already works: host resolution, queue limits, pause/cancel, and popup settings.
4. Establish repeatable commands and CI. CI can be authored locally; whether remote checks have run must be reported separately.
5. Add coverage reporting with an honest initial floor; do not impose the eventual target immediately.

Exit: the existing tests pass; application coverage lists real scripts and missing coverage honestly; a fresh checkout has documented validation commands; test failures cause required CI failures. A minimal native-checkbox defect discovered by real-browser tests was fixed during this phase; queue/recovery behavior remains unchanged.

### Phase 1 — Fix batch recovery with regression tests

Tasks: TEST-04, TEST-05, REL-01 through REL-10. ARCH-02, ARCH-03, and ARCH-05 can be pulled forward only as needed for a focused fix.

Recommended sequence: preserve terminal views (REL-04), recover orphaned starting work (REL-03), decouple source-tab closure (REL-01), then restore/reconcile after worker termination (REL-02). Reorder if one requires the stable-identity work first.

For each fix: write a reproducing test; demonstrate the failure; implement the smallest coherent fix; run regression plus suite; update the checkbox and checkpoint. Retain existing download IDs and avoid re-downloading completed or active files.

Exit: popup reopening retains errors/retry actions; closing a source tab does not silently abandon its queue; worker recreation reconciles saved state; orphaned resolution jobs recover; browser API failures do not produce false UI success. All regressions pass.

### Phase 2 — Strengthen architecture and browser integration

Tasks: remaining ARCH tasks, TEST-09, TEST-10, and incremental coverage improvements.

Extract responsibilities one at a time behind existing behavior. Build browser tests using controlled fixtures and tiny downloads, with no dependency on live third-party hosting. Do not add localhost or test-only hosts to the production permission list merely to simplify tests.

Exit: queue/resolver/storage logic can be tested independently; actual popup behavior has browser coverage; storage migration/recovery is exercised; host parsing remains ad-free and constrained.

### Phase 3 — Improve everyday UI and UX

Tasks: UX-01 through UX-12. Start with title/status clarity, accessibility, saved selection, verification actions, and readable filenames before the larger manager view.

Exit: keyboard and pointer selection work; closing/reopening the popup preserves selections; failed and verification states have usable actions; progress remains understandable at zoom and with long filenames. Verify appearance and behavior in a browser.

### Phase 4 — Add selected queue features

Tasks: FEAT-01 through FEAT-10. Pick features based on user priorities; do not assume all optional features are approved for immediate implementation.

Recommended first additions: bounded retry/rate-limit handling, duplicate and missing-part detection, and a test-first-file action. Global concurrency depends on stable batch identity. Restart restoration depends on Phase 1; queue import must reuse URL validation.

Exit for each feature: acceptance behavior is documented, meaningful automated tests pass, UI behavior is manually checked where relevant, and any new permissions are explicit.

### Phase 5 — Release and maintain the fork

Tasks: DEV-03 through DEV-10. Documentation and repository hygiene may proceed earlier when they do not distract from the recovery fixes.

Exit: versioned release packaging is repeatable; runtime ZIP excludes tests/development files; release notes and screenshots match behavior; fork/upstream contribution and synchronization instructions are clear. Publishing itself follows the active session's authorization.

## Task register

Checkboxes represent completion, not merely that work was attempted. Reference the original review number in the **Review** column to preserve the full 60-item backlog.

### Testing and coverage

| Done | ID | Review | Priority | Deliverable / acceptance criterion |
| --- | --- | ---: | --- | --- |
| [x] | TEST-01 | 11 | P1 | Collect truthful application coverage, including unexecuted scripts; eliminate the empty-report 100% trap and document reproduction. |
| [x] | TEST-02 | 12 | P1 | Add CI for tests, application coverage, applicable static checks, and manifest validation; report local versus remote results separately. Authored locally; remote execution pending publication. |
| [x] | TEST-03 | 13 | P1 | Establish a verified baseline and coverage floor, then ratchet upward. Enforced overall floors: 85% lines / 75% branches / 95% functions; current results recorded above. |
| [x] | TEST-04 | 14 | P1 | All four original defects demonstrated red, fixed, and promoted into the required lifecycle suite; 12 focused recovery checks pass and the diagnostic CI exception is removed. |
| [x] | TEST-05 | 15 | P1 | Exercise completion, interruption, missing downloads, saved-state hydration, and worker recreation through public event/message boundaries. |
| [x] | TEST-06 | 16 | P1 | Shared Chrome mocks support delayed/rejected operations, runtime errors, storage quotas, persistence across worker recreation, and controlled event ordering. |
| [x] | TEST-07 | 17 | P1 | Test popup rendering for selection, empty/active/paused/failed/completed states and retry actions, beyond the existing three settings tests. |
| [x] | TEST-08 | 18 | P1 | Verify mouse, label, Space, range, Ctrl/Meta, and Select All interactions in real Chromium; fixed the demonstrated native checkbox/Space cancellation defect. |
| [x] | TEST-09 | 19 | P2 | Real Chromium MV3 scanning, selection, popup reopen, storage rehydration after browser restart, and tiny data download/reconciliation. Live host protocol and automatic queue restart are explicitly outside this passing integration claim. |
| [x] | TEST-10 | 20 | P2 | Fixtures cover malformed headers, relative/missing paths, challenges, 429, 1 MiB HTML, timeouts/body failures, and unsupported responses. Response-size protection itself remains ARCH-06. |

### Reliability and recovery

| Done | ID | Review | Priority | Deliverable / acceptance criterion |
| --- | --- | ---: | --- | --- |
| [x] | REL-01 | 1 | P1 | Source closure retains sessions/mappings; completion continues the queue. Saved batches remain inspectable/controllable from unrelated tabs, verified through the real popup. |
| [x] | REL-02 | 2 | P1 | Shared once-per-worker hydration/reconciliation resumes eligible queued work; browser startup pauses queues for explicit Resume. Concurrent recovery and saved verification pauses are tested. |
| [x] | REL-03 | 3 | P1 | Worker-local resolver ownership distinguishes live requests from orphaned persisted `starting` jobs; tests cover both requeueing and avoiding duplicate live requests. |
| [x] | REL-04 | 4 | P1 | Terminal results/Retry survive reopening and reconciliation; explicit Scan page again starts fresh selection only after active work finishes/cancels. Verified in unit and browser tests. |
| [x] | REL-05 | 5 | P1 | Durable batch/file IDs route queues, messages and completion; tab/index-reuse failures fixed. Schema-2 migration preserves Chrome download IDs, stable reloads, legacy backups and failure safety. |
| [x] | REL-06 | 6 | P1 | Serialize mutations/persistence and share hydration promises; controlled concurrency tests prove older reads/writes cannot overwrite newer state. |
| [x] | REL-07 | 7 | P1 | Await pause/resume/cancel results; represent API rejection accurately and retain tracking of downloads still running. |
| [ ] | REL-08 | 8 | P1 | Browser download-manager pause/resume/cancel/removal changes synchronize with batch state without reopening the popup. |
| [ ] | REL-09 | 9 | P1 | Completion arriving before mapping registration is reconciled without lost progress, stuck slots, or duplicate work. |
| [ ] | REL-10 | 10 | P1 | Cancel aborts outstanding resolver fetch/body reads; intentional aborts do not become misleading failures or trigger replacement downloads. |

### Architecture and security hardening

| Done | ID | Review | Priority | Deliverable / acceptance criterion |
| --- | --- | ---: | --- | --- |
| [ ] | ARCH-01 | 21 | P2 | Extract URL policy, host resolver, scheduler, storage, Chrome wrappers, and message handling incrementally; keep runtime behavior and tests stable. |
| [ ] | ARCH-02 | 22 | P2 | Document and enforce valid batch/file transitions, including resolving, verification, terminal states, and cancellation. |
| [ ] | ARCH-03 | 23 | P2 | Structured error codes carry safe user-facing explanations and recovery actions; UI does not infer behavior from string matching. |
| [ ] | ARCH-04 | 24 | P2 | Validate message sender/payload shapes, item limits, settings, and target batch IDs. Treat this as hardening, not a previously proven external-message exploit. |
| [ ] | ARCH-05 | 25 | P2 | Version storage and migrate/validate old, corrupt, or partial state without discarding trackable browser downloads. |
| [ ] | ARCH-06 | 26 | P2 | Bound remote body size and total processing time; rejection/cancellation paths are covered. |
| [ ] | ARCH-07 | 27 | P2 | Observe final redirect destinations and enforce/document the supported HTTPS host policy without claiming initial URL validation covers redirects. |
| [ ] | ARCH-08 | 28 | P2 | Resolve duplicate/unregistered options UI, share settings validation, and audit requested permissions; remove redundant permissions only after browser validation. |

### UI and usage

| Done | ID | Review | Priority | Deliverable / acceptance criterion |
| --- | --- | ---: | --- | --- |
| [ ] | UX-01 | 29 | P2 | Show the batch/game title and source domain consistently; wire up or replace the unused title element. |
| [ ] | UX-02 | 30 | P2 | Show per-file and aggregate byte progress with explicit unknown-total behavior. |
| [ ] | UX-03 | 31 | P2 | Show sampled speed/ETA only when meaningful; handle pause, unknown sizes, and noisy measurements. |
| [ ] | UX-04 | 32 | P2 | Persist per-batch selection across popup closure and harmless rerenders; do not reselect everything silently. |
| [ ] | UX-05 | 33 | P2 | Add filename search and state filters without losing selection or changing hidden files unexpectedly. |
| [ ] | UX-06 | 34 | P2 | Make long filenames and source URLs inspectable by keyboard and pointer without relying solely on hover tooltips. |
| [ ] | UX-07 | 35 | P2 | Per-file retry, pause/resume, skip, copy-link, and original-page actions work consistently with batch state and queue limits. |
| [ ] | UX-08 | 36 | P2 | Verification state has an original-page action, clear explanation, and usable Resume; no automatic challenge solving. |
| [ ] | UX-09 | 37 | P2 | Proper labels, keyboard focus, live status announcements, and non-color status cues; verify with keyboard and accessibility checks. |
| [ ] | UX-10 | 38 | P2 | Clarify or remove separate row highlighting; selection semantics are consistent for checkbox/label/keyboard/modifier actions. |
| [ ] | UX-11 | 39 | P2 | Improve spacing, readable type, zoom handling, logo footprint, and dark/light/system themes; verify representative viewports and long content. |
| [ ] | UX-12 | 40 | P2 | Add a persistent manager tab or optional side panel for multiple/large batches; choose the surface and permissions explicitly. |

### Optional feature expansion

| Done | ID | Review | Priority | Deliverable / acceptance criterion |
| --- | --- | ---: | --- | --- |
| [ ] | FEAT-01 | 41 | P2 | Optional global concurrency cap complements existing per-batch limits; fairness and simultaneous batches are tested. |
| [ ] | FEAT-02 | 42 | P2 | Bounded transient-error retries use backoff and attempt limits; verification and permanent errors do not loop indefinitely. |
| [ ] | FEAT-03 | 43 | P2 | Respect HTTP 429 / Retry-After, with visible delayed state and no busy retry loop. |
| [ ] | FEAT-04 | 44 | P2 | Persist batch history across full browser restart and offer explicit resume; reuse REL-02 rather than invent a second recovery system. |
| [ ] | FEAT-05 | 45 | P3 | Allow queue/batch priority changes without invalidating IDs or restarting active downloads. |
| [ ] | FEAT-06 | 46 | P2 | Detect missing/duplicate archive-part numbers from filenames; explain that naming checks do not verify archive integrity. |
| [ ] | FEAT-07 | 47 | P2 | Canonicalize landing URLs independently of display fragments and detect duplicate/already-completed items; avoid false matches across distinct files. |
| [ ] | FEAT-08 | 48 | P3 | Add language/optional-file groups and reusable selection presets where filenames provide sufficient evidence; keep manual override. |
| [ ] | FEAT-09 | 49 | P3 | Safe per-batch subfolders and filename-conflict settings work within Chrome's download constraints; reject unsafe paths. |
| [ ] | FEAT-10 | 50 | P2 | Validated queue import/export, selected-link copying, and test-first-file flow; never import arbitrary executable settings or untrusted hosts. |

### Development, release, and maintenance

| Done | ID | Review | Priority | Deliverable / acceptance criterion |
| --- | --- | ---: | --- | --- |
| [x] | DEV-01 | 51 | P1 | Node 24 (>=24.8.0), npm scripts, pinned lockfile, install/check/browser instructions and isolated cache paths are documented. |
| [ ] | DEV-02 | 52 | P1 | Add scoped lint/format/type checks (JSDoc/checkJs is an option); separate mechanical formatting from behavior changes. |
| [ ] | DEV-03 | 53 | P2 | Produce runtime-only release ZIPs with manifest/version validation; do not publish a release unless authorized in the active session. |
| [ ] | DEV-04 | 54 | P2 | Maintain a changelog with compatibility and upgrade notes tied to actual releases. |
| [ ] | DEV-05 | 55 | P2 | Add useful issue templates with versions, reproduction, and safe diagnostic guidance; avoid requesting private URLs/tokens unnecessarily. |
| [ ] | DEV-06 | 56 | P2 | Add contribution and security-reporting instructions, including test/fixture expectations and a valid reporting channel. |
| [ ] | DEV-07 | 57 | P2 | Clarify upstream attribution/licensing; no LICENSE existed at review time. Do not unilaterally relicense inherited code. |
| [ ] | DEV-08 | 58 | P2 | Explain permissions, saved URLs/history, host-cookie behavior, retention, and a working clear-history action. |
| [ ] | DEV-09 | 59 | P3 | Update screenshots and fork feature/install/release documentation to match the shipped version. |
| [ ] | DEV-10 | 60 | P2 | Document an upstream-sync branch/check/review workflow that preserves the user's working fork and avoids history rewrites. |

## Reproduced recovery defects

These findings were reproduced with isolated mocked browser APIs during review, not with destructive live downloads:

- **REL-01:** Start a tracked download, invoke source-tab removal, and observe both the session and mapping deleted while the browser download remains active. The remaining queue loses its coordinator.
- **REL-03:** Hydrate an item as `starting` with no download ID. Reconciliation leaves it unchanged; pumping does not resolve it. Recovery must distinguish a live resolver from an orphan.
- **REL-04:** Reconcile a terminal failed session. `hasStarted` becomes false; popup dispatch renders file selection instead of the failed batch/retry view.
- **REL-02:** No comprehensive worker-start recovery path currently restores/reconciles all queues. Service-worker termination is part of the normal MV3 lifecycle, so test worker recreation and persisted-state behavior explicitly.

The fourth point is an architectural gap identified by inspection; do not misreport it as a completed real-browser restart reproduction. TEST-04/TEST-05 should establish the exact expected behavior before changing implementation.

## Definition of done for an implementation slice

- The task's acceptance criterion is met; behavior changes have a meaningful regression test.
- Existing tests and relevant new checks pass; coverage reporting is truthful.
- Browser-facing changes have appropriate real DOM/browser validation, or an explicit documented verification gap.
- URL policy, ad-free behavior, concurrency, and duplicate-download protection remain intact.
- No unrelated user changes, secrets, private diagnostic data, or generated noise are included.
- Plan checkbox, resume checkpoint, work log, and relevant usage instructions are current.
- Commit/push/PR/release status is recorded accurately; local success is not described as remote CI success.

## Work log

### 2026-11-03 — Plan created

- Created this plan and root `AGENTS.md` at the user's request; implementation intentionally has not started.
- Preserved every item from the 60-item review with stable IDs and original-review mapping.
- Prioritized test/coverage foundation before runtime recovery work, with a regression-first sequence and phase gates.
- Recorded baseline commit, commands, diagnostic coverage, reproduced issues, product decisions, and restart instructions so a new chat does not need the prior conversation.
- No implementation branch, runtime change, test change, commit, push, or new PR was created for this planning task.

### 2026-11-03 — Test foundation implemented

- Branch: `chore/test-foundation`, HEAD still `a4afffa`; changes are uncommitted and unpushed.
- Implemented TEST-01/02/03/05/06/07/08/09/10 and DEV-01. TEST-04 is partially authored but deliberately stays open because its four desired recovery behaviors still fail. DEV-02 has scoped correctness linting only; broad formatting/type checks remain pending.
- Added pinned npm development dependencies/lockfile, Node version guidance, c8 reporting/integrity checks, manifest checks, realistic shared Chrome mocks, JSDOM rendering tests, and isolated Playwright Chromium tests. No npm dependency is used by the extension runtime.
- `npm run check` passes: 104 unit/DOM tests, lint, manifest validation, and coverage floors of 85% lines / 75% branches / 95% functions. Actual application coverage: 90.41% lines / 81.51% branches / 97.87% functions. All three runtime scripts are included; tests, tooling, and known-failure specs are excluded.
- `npm run test:browser` passes all 6 checks on Windows with normal process permissions: actual isolated scanning; native row/label/Space/range/Ctrl/Meta selection; popup settings persistence; state rehydration across browser restart; tiny generated Chrome download and reconciliation. No live file host, advertisements, or archives are used.
- Real Chromium first demonstrated a failing Space-key checkbox assertion. Fixed only the native toggle cancellation in `popup.js`; JSDOM and real Chromium regressions now pass. This is the only production behavior change in the test-foundation work.
- `npm run test:regressions` was run and all 4 specifications fail for the tracked REL-01..04 defects. These are strict executable failures, not skips/TODOs and not passing coverage. Required checks remain separate; CI has an explicit non-blocking diagnostic job. As fixes land, promote each passing regression into the required suite and remove that exception when none remain.
- Scoped CI workflow is authored with pinned action revisions and read-only permissions. Windows/Linux unit checks and Linux browser checks have not run remotely because no push occurred.
- Dependency audit after patched `minimatch`/`glob` development overrides reported 0 vulnerabilities. Keep overrides tested when updating dependencies.
- Implementation/release status: no commit, push, release, or new PR. Existing upstream PR #2 unchanged. Planning files from the prior task remain preserved in the working tree.
- Exact next step: `node --test --test-name-pattern=REL-04 tests/regressions/recovery.test.cjs`, fix terminal-view retention, and move the passing assertion into `tests/lifecycle.test.cjs`. Then REL-03, REL-01, REL-02. Product decisions about a persistent manager and browser-start resume are still open; do not silently treat the integration rehydration test as automatic queue restart support.

### 2026-11-03 — Published foundation; completed first recovery milestone

- User explicitly authorized pushing to the fork and continuing implementation. Committed/pushed foundation as `7c000d7` to `origin/chore/test-foundation` and created `fix/batch-recovery` from it.
- Foundation remote workflow: https://github.com/AlexanderArmua/FitDownloader/actions/runs/41749035632 . Required unit jobs on Windows/Linux and browser job passed; the old known-defect diagnostic job failed as expected before the fixes.
- Demonstrated REL-04, REL-03, REL-01 and REL-02 specifications failing before fixing each. All assertions now live in the required lifecycle suite. Removed the empty red-spec file and non-blocking CI job; `npm run test:regressions` now runs the passing recovery subset.
- Fixed terminal result retention and added deliberate rescanning, guarded against replacing active work. Added worker-local resolver ownership to requeue abandoned jobs while leaving live requests alone.
- Source-tab closure keeps started batch state and download mappings. The popup can discover saved batches from unrelated tabs, select a batch and direct pause/resume/cancel/retry to its owner. Actual source-tab URLs are checked before rescanning; closed sources are not injected into.
- Shared hydration and once-per-worker recovery reconcile browser downloads before queue pumping. Worker wake continues eligible work; full browser startup pauses queues for user Resume. Full serialization and stable identity migration remain REL-06/REL-05, not claimed complete here.
- Local validation: 120 unit/DOM tests, all 12 focused recovery tests, lint/manifest checks, all 8 Chromium tests. Coverage: 88.69% lines / 82.42% branches / 98.03% functions, above unchanged floors. Added code explains the change in percentages; thresholds were not weakened.
- Browser checks use only controlled fixtures and tiny text data, including closed-source popup controls and terminal-history/rescan behavior. Live host compatibility was not retested with an archive.
- Version bumped to 0.2.2 in manifest/package/lockfile. No release object or upstream PR change was requested or created.
- Publication completed: recovery commit `ef55d70` pushed to `origin/fix/batch-recovery`; all three required remote jobs passed at https://github.com/AlexanderArmua/FitDownloader/actions/runs/41750317691 . Fast-forwarded/pushed own `main` to that tested runtime commit. Local main and origin/main matched at publication verification. This final checkpoint is a documentation-only follow-up.
- Next implementation task is REL-05, then REL-06/REL-07. Remaining known architectural limits include legacy tab/index ownership, the download-ID persistence window, and non-serialized mutations.

### REL-05 preparation (completed below)

- Start from current main on a new `fix/stable-batch-identities` branch. Read the current code and rerun checks; do not assume line numbers or test counts remain unchanged.
- First write regressions for source tab-ID reuse after browser restart, queue item reorder/filter operations, and migrating a persisted legacy download map without losing or duplicating active Chrome downloads.
- Use separate durable batch/item IDs and optional source-tab metadata. Route popup actions and download mappings by durable IDs; retain generation checks to invalidate stale workers.
- Migrate existing `ffSessions` / `ffDownloadMap` atomically or with a recoverable schema-version protocol. Preserve paused/verification/terminal states and validate legacy data. Do not silently turn a migration into a new download run.
- Update batch-picker values and message validation together with ownership changes. Test old storage, newly created batches, closed sources, explicit rescans, and completion events racing with migration.
- Keep the larger persistent manager, global cap, and full mutation serialization as separate tasks. Existing shared hydration promises are only part of REL-06, not proof of complete concurrency safety.

### 2026-11-03 — REL-05: durable ownership and saved-state migration

- Branch `fix/stable-batch-identities`, based on main `86516ef`; extension/package/lockfile version 0.2.3. No release object created.
- Demonstrated three regression failures before implementation: reused source-tab ID selected the old batch, reordered completion updated the wrong file, and reordering stranded a live resolver. All now pass in `tests/identities.test.cjs`.
- Sessions use opaque batch IDs, each file has a stable ID, and download maps/resolvers use batch ID + file ID + generation. `sourceTabId` is optional metadata with explicit attachment. A new scan receives a new batch ID and retains historical results; browser startup detaches previous source bindings.
- Replaced the separate legacy records with one schema-2 `ffBatchState` snapshot containing batches and download mappings. Migration commits before exposing state, leaves legacy keys unchanged, preserves active Chrome IDs, reconstructs partial old writes, and rejects unsupported/ambiguous snapshots without deleting data. Full concurrent mutation serialization is still REL-06.
- Updated messages, saved-batch picker, live broadcasts and checkbox selection to use IDs. Cross-batch file selection and old numeric-tab control messages are rejected. Queue ordering no longer determines ownership.
- The message dispatcher was consolidated to route every control through the new identity contract. Pause/resume await browser API results, but comprehensive rollback/partial-failure consistency is not claimed complete (REL-07).
- Validation: 140 unit/DOM tests and 9 isolated Chromium tests pass, including legacy state across browser restart and old/new scans sharing source metadata. Host protocol and production permission lists were preserved. No real archive or ad page was used.
- Coverage: 91.83% lines, 86.43% branches, 98.36% functions; thresholds were not weakened. All 31 named recovery/identity/migration regressions pass.
- Publication: runtime commit `69f4c98` pushed to `origin/fix/stable-batch-identities`. Required Windows/Linux unit and browser jobs passed at https://github.com/AlexanderArmua/FitDownloader/actions/runs/41753517891 before fast-forwarding own main. This final checkpoint is documentation only.
- Next task: REL-06. Add deferred storage and reconciliation/control interleaving regressions before changing mutation scheduling; keep network operations outside critical sections. Then REL-07 and the download-ID registration-window fix REL-09.

### 2026-11-03 — REL-06: serialized state and persistence

- Branch `fix/serialized-state`, based on `358c5fd`; version 0.2.4. Added `tests/serialization.test.cjs` and one isolated Chromium test.
- Demonstrated three failures before implementation: writes completed out of order; delayed reconciliation restored cancelled ownership; Resume overtook a pending Pause and left Chrome paused. All pass after the fix.
- All live state entry points now serialize through one mutation queue, sharing hydration and recovery. Internal state helpers avoid nested queue waits. Persisted snapshots are copied at call time and written in order; rejection does not poison either queue. Removed redundant separate-map writes and unused compatibility helpers.
- Queue slots are reserved and persisted before host lookup. Failed reservation writes restore slots without remote requests. Host fetches and Chrome download creation run outside the mutation queue; later commits validate durable file identity and generation. Late creation after cancellation cancels the new Chrome download instead of attaching it to the new state.
- Ten controlled concurrency regressions cover immutable writes, reconciliation/cancellation, Pause/Resume, completion/Pause, cancellation during host lookup, failed operations, simultaneous scans, reservation writes, and late creation callbacks. Existing lifecycle and security tests remain required.
- Validation: 150 unit/DOM tests, 10 Chromium tests, lint/manifest and coverage integrity checks pass. Coverage: 92.50% lines / 87.76% branches / 98.43% functions, above unchanged thresholds. Browser tests use local page fixtures and tiny text downloads, with no ads or archive downloads.
- Tradeoff: browser queries/controls and source extraction are awaited inside serialized operations, so slow browser callbacks can delay later controls. Network lookups do not block controls. API failure rollback and partial-success reporting remain REL-07; the early completion registration window remains REL-09. This change does not claim either task complete.
- Publication: runtime commit `037de32` pushed to `origin/fix/serialized-state`; all required Windows/Linux unit and Chromium jobs passed at https://github.com/AlexanderArmua/FitDownloader/actions/runs/41755416391 before fast-forwarding own main. This final checkpoint is documentation only.
- Next task: REL-07; first reproduce failed search versus missing download and partial Pause/Resume/Cancel failures.

### 2026-11-03 — REL-07: browser API rejection and partial controls

- Branch `fix/browser-operation-failures`, based on `b02194d`; extension/package/lockfile version 0.2.5. No new dependencies or production permissions.
- Demonstrated six background regressions before implementation: failed search lost an owned ID; Pause/Resume stopped after one failure; Cancel reported success before Chrome responded; failed automatic Pause was not persisted; failed late Cancel orphaned a created download. Six initial DOM regressions also demonstrated ignored control errors and missing retry/status feedback.
- Controls await every eligible Chrome operation, keep successful changes, preserve rejected files' last confirmed states/IDs, and persist per-file errors plus batch retry intent. Partial controls hold queued work. Failed Cancel invalidates old resolvers while remapping surviving Chrome downloads to the current generation; it does not rescan or clear failed ownership.
- Failed automatic Pause after creation still persists the actual Chrome ID. Failed cancellation of a late creation restores recoverable ownership, appending a separate item if the original file was restarted and restoring a detached batch if it was removed. Completion and recovery retain generation ownership without duplicate starts.
- Failed/malformed/thrown download searches preserve last confirmed state, report refresh errors and continue reconciling other files. Successful searches clear query errors and may confirm pending outcomes; a successful empty result still identifies a missing download.
- Popup controls use structured state, render partial results, expose Retry Pause/Resume/Cancel, report transport/backend errors, retain Retry failed after rejection, and ignore replies after switching to another batch. Control replies carry their resulting batch snapshot so Retry stays on the selected batch. Error content uses text nodes/tooltips.
- Validation: 172 unit/DOM tests, 63 named regressions, lint/manifest and coverage integrity checks pass; all 11 isolated Chromium tests pass, including a real Chrome Pause rejection with only status lookup stubbed. Coverage: 93.26% lines / 89.59% branches / 98.59% functions; thresholds unchanged. No ads or archive downloads.
- Limits: slow browser callbacks still serialize later controls. Chrome operations and storage writes are not a distributed transaction; storage failure recovery still queries Chrome. Automatic external download-manager updates remain REL-08; early terminal events before map registration remain REL-09.
- Publication: runtime commit `6fdac97` pushed to `origin/fix/browser-operation-failures`; all required Windows/Linux unit and Chromium jobs passed at https://github.com/AlexanderArmua/FitDownloader/actions/runs/41763729760 before fast-forwarding own main. This final checkpoint is documentation only.
- Next task: REL-09, then REL-08.

### Future work-log entry template

```text
YYYY-MM-DD — TASK-ID — short outcome
Branch / commit:
Files changed:
Regression demonstrated (for bug fixes):
Checks run and results:
Manual browser checks / verification gaps:
Decisions / tradeoffs:
Commit / push / PR status:
Remaining work and exact next task:
```

# Test guide

## Setup and commands

Use Node 24, at least 24.8.0. Runtime extension code has no npm dependency; the packages here are development tools only.

```text
npm ci --ignore-scripts
npm run check
npm run test:browser:install
npm run test:browser
```

| Command | Purpose |
| --- | --- |
| `npm test` | Passing Node unit/DOM suite, with no live network calls. |
| `npm run test:coverage` | Same suite, c8 application-only reports, thresholds and report-integrity validation. |
| `npm run lint` | Scoped correctness rules; not a complete formatting or type-check setup. |
| `npm run check:manifest` | Manifest/assets/version consistency and production-permission checks. |
| `npm run check` | Required local static/unit/coverage checks. |
| `npm run package` | Build runtime-only release ZIP and checksum from committed HEAD into ignored `dist/`. |
| `npm run test:browser:install` | Download pinned Playwright Chromium into `node_modules/.cache/ms-playwright`. |
| `npm run test:browser` | Real MV3 extension and popup tests in isolated temporary Chromium profiles. |
| `npm run test:regressions` | Passing REL-01..10 recovery, identity, migration, serialization, API failure, browser event and cancellation subset. |

On Linux, Chromium may also need system libraries: use Playwright's documented `npx playwright install-deps chromium` command. Windows sandbox restrictions can prevent browser startup; running the same tests with normal process permissions may be necessary. Do not change production extension permissions or browser-security settings to make tests pass.

## What is covered

- `background.test.cjs`: original host/security/queue tests, now using the shared background harness.
- `lifecycle.test.cjs`: message APIs, event-driven scheduling, persistence, rehydration, reconciliation, API errors and ownership tracking.
- `identities.test.cjs` / `migration.test.cjs`: durable batch/file ownership after tab reuse or reordering, legacy migration, failure preservation, partial old writes, cross-batch selection rejection, and idempotent snapshot reload.
- `serialization.test.cjs`: ordered immutable saves, reconciliation versus Cancel, overlapping Pause/Resume, completion during Pause, simultaneous scans, failed-operation recovery, reservation persistence, and late Chrome creation callbacks. Deferred APIs control interleavings without timing-based sleeps.
- `browser-failures.test.cjs`: search failure versus absence, partial controls and retries, persisted rejection state, failed automatic Pause, failed late Cancel, generation ownership, and recovery without overwriting restarted files. REL-07 DOM tests verify useful errors, matching retry actions, transport failures and ignoring replies for another batch.
- `download-events.test.cjs`: completion/interruption/erase before creation returns, failed registration queries, bounded early-event storage, persisted-ID recovery, external Pause/Resume/Erase, resume of interrupted historical attempts after worker restart, and isolation from newer retries.
- `cancellation.test.cjs`: real AbortSignals propagate Cancel through landing/POST fetch and body reads, affect only the target batch, release resolver ownership and keep timeout failures distinct from intentional aborts.
- `host-fixtures.test.cjs`: HTMX headers, errors, timeouts, body failures, large HTML, and actual DOM scanning fixtures. The large-body test characterizes parsing; a production response-size limit remains ARCH-06.
- `page-rendering.test.cjs`: JSDOM renders the real popup/options HTML and runs their real scripts, including selection/status, injection safety, settings and failures.
- `popup.test.cjs`: original settings and message-order tests retained.
- `manifest.test.cjs` / `coverage-report.test.cjs`: verify the repository checks reject invalid manifests and misleading/empty reports.
- `release.test.cjs`: independently reads ZIP entries, decompresses and checks CRCs, verifies the exact runtime allowlist/root manifest/checksum and deterministic packaging. Mocked GitHub API tests cover the tested-main gate, fork/PR rejection, published-version skips, conflicting tags/drafts, interrupted uploads, checksum checks and release ordering. These are tooling tests; application coverage excludes release scripts.
- `browser/extension.spec.cjs`: real isolated-world scanning, native mouse/keyboard/modifier selection, settings persistence, state rehydration across browser restart, and a tiny Chrome-managed text download.

The browser popup tests stub only the scan message response when rendering file selection, because opening the popup as a regular tab changes Chrome's active-tab selection. A separate browser test exercises real page scanning. The data-download test injects tracked state and reconciles the actual Chrome download; it is not an end-to-end test of the live host POST protocol.

No live host, real archive, advertising page, personal browser profile, account, or cookie is required. Unrecognized page requests are aborted by the browser fixture. One test uses an ephemeral loopback HTTP server serving a small text fixture with Range support so real Chrome Pause/Resume/Cancel/Erase can be exercised; it closes the server and connections in teardown. No test host was added to production permissions. Profiles and tiny download files stay under the project dependency cache and are removed after each browser test.

## Coverage accounting

Application scripts execute in named VM contexts. c8 uses `all: true`, includes root `*.js` and future `src/**/*.js`, and excludes tooling/tests/dependencies. An application script with no runtime tests must remain present at 0%, not disappear from the denominator.

`scripts/check-coverage.cjs` rejects the previous empty-report 100% result, missing application entries, zero source-line counts, and test/dependency entries. Thresholds currently gate overall application coverage at 85% lines, 75% branches, 95% functions. HTML, LCOV and JSON summaries are generated in ignored `coverage/`. Browser tests and known-failure specifications do not contribute to these percentages.

Current local measurement is recorded in the plan. Re-measure after changes; a high line count does not prove lifecycle correctness. Branch coverage is lower for standalone options error paths and should be improved when that duplicated UI is consolidated.

## Recovery regressions are required

The four original desired-behavior specifications were each demonstrated failing, then fixed and promoted into `lifecycle.test.cjs`:

1. REL-01: source-tab closure must preserve active batch ownership.
2. REL-03: orphaned `starting` jobs must be recoverable.
3. REL-04: reopening a failed batch must preserve its retry/result view.
4. REL-02: explicit scan after worker recreation must restart an eligible unpaused saved queue.

All now pass in the standard unit/coverage command. `npm run test:regressions` selects the focused recovery subset; it is not a second collection of skipped or expected failures. The separate red-spec file and non-blocking CI job have been removed.

Additional tests cover concurrent recovery without duplicate starts, a saved verification pause, live resolver ownership, full browser-start Resume behavior, detached batch controls, and explicit rescanning. Browser tests verify closed-source access and failed-result retention through the real popup.

REL-05 is now implemented: batches are keyed by opaque IDs, file IDs follow queue items, and source tab IDs are metadata only. The `ffBatchState` schema-2 snapshot stores batches and the download map together. Migration commits this snapshot before exposing migrated state or starting work, retaining old `ffSessions`/`ffDownloadMap` values untouched. A failed write or unsupported/ambiguous state stops hydration without deleting saved data. This is an upgrade path, not a guarantee that older extension versions can safely resume newer state.

Browser tests also cover legacy state across browser restart, distinguish a detached historical batch from a new scan of the same source tab, and verify simultaneous scans produce one durable batch. Unit tests demonstrate the three original identity bugs red/green.

REL-06 serializes live state operations and immutable snapshot writes. Host fetches and Chrome download creation release the mutation queue; their results recheck durable ownership before committing. Three controlled regressions demonstrated out-of-order writes, cancelled ownership resurrection and overlapping Pause/Resume before the fix. A failed operation does not poison either queue. Browser API queries/controls and source extraction are awaited inside state operations, so a slow browser callback can delay later controls.

REL-07 retains actual successful control results and last confirmed state for rejected operations. Partial controls persist per-file errors and batch retry intent while holding queued work. Failed Cancel keeps live IDs mapped to the current generation; failed cancellation of late creation restores ownership without overwriting a new run. Failed status searches retain ownership and expose a refresh error. Six background and six initial DOM regressions were demonstrated failing before the fixes. Chromium verifies a real Pause API rejection using a nonexistent download ID (only status lookup is stubbed), persistence and the reopened popup's Retry Pause action. Storage write failures do not become an atomic transaction with Chrome operations; recovery still queries Chrome for actual outcomes.

REL-08/09 synchronize Chrome events without reopening the popup and reconcile new IDs immediately. Up to 256 early event records are retained only during pending creation; status lookup supplies a fallback and persisted IDs are reconciled after recovery. The optional schema-2 `downloadHistory` records managed Chrome IDs with validated batch/file ownership, links, labels and last state. Interrupted attempts resumed in Chrome are restored without starting duplicate downloads or overwriting newer retries. Erasure removes the association, preserving finished batch results. Associations are retained until Chrome erasure; broader retention/clear-history UX remains DEV-08. Paused files count toward the batch limit; restoring a historical attempt holds queued work for user Resume.

REL-10 aborts only the cancelled batch's resolver requests and body reads, with normal request timeout errors still reported. Chrome creation is not abortable through the fetch signal; late IDs are cancelled or retained if Chrome rejects cancellation. Chromium verifies early completion using real tiny data downloads with controlled resolver/creation wrappers, live controls with a small loopback text download, and popup Cancel using native browser AbortSignals with a controlled fetch fixture. These tests do not assert current live-host compatibility or crash-safe atomicity across Chrome and extension storage.

## Dependency and CI notes

The lockfile pins the test stack. `minimatch` and `glob` overrides select patched releases for development tools; rerun all checks after changing them. No npm package is bundled into the production extension by this setup.

CI runs static/unit/coverage checks on Windows and Linux and browser checks on Linux, with no non-blocking exceptions. Actions are pinned to verified commit revisions and workflow permissions are read-only. Local passing results do not establish remote CI success until the branch has been pushed and GitHub checks have run.

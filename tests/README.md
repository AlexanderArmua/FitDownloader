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
| `npm run test:browser:install` | Download pinned Playwright Chromium into `node_modules/.cache/ms-playwright`. |
| `npm run test:browser` | Real MV3 extension and popup tests in isolated temporary Chromium profiles. |
| `npm run test:regressions` | Passing REL-01..04 recovery subset of the required lifecycle suite. |

On Linux, Chromium may also need system libraries: use Playwright's documented `npx playwright install-deps chromium` command. Windows sandbox restrictions can prevent browser startup; running the same tests with normal process permissions may be necessary. Do not change production extension permissions or browser-security settings to make tests pass.

## What is covered

- `background.test.cjs`: original host/security/queue tests, now using the shared background harness.
- `lifecycle.test.cjs`: message APIs, event-driven scheduling, persistence, rehydration, reconciliation, API errors and ownership tracking.
- `host-fixtures.test.cjs`: HTMX headers, errors, timeouts, body failures, large HTML, and actual DOM scanning fixtures. The large-body test characterizes parsing; a production response-size limit remains ARCH-06.
- `page-rendering.test.cjs`: JSDOM renders the real popup/options HTML and runs their real scripts, including selection/status, injection safety, settings and failures.
- `popup.test.cjs`: original settings and message-order tests retained.
- `manifest.test.cjs` / `coverage-report.test.cjs`: verify the repository checks reject invalid manifests and misleading/empty reports.
- `browser/extension.spec.cjs`: real isolated-world scanning, native mouse/keyboard/modifier selection, settings persistence, state rehydration across browser restart, and a tiny Chrome-managed text download.

The browser popup tests stub only the scan message response when rendering file selection, because opening the popup as a regular tab changes Chrome's active-tab selection. A separate browser test exercises real page scanning. The data-download test injects tracked state and reconciles the actual Chrome download; it is not an end-to-end test of the live host POST protocol.

No live host, real archive, advertising page, personal browser profile, account, or cookie is required. Unrecognized page requests are aborted by the browser fixture. Profiles and tiny download files stay under the project dependency cache and are removed after each browser test.

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

Additional tests cover concurrent recovery without duplicate starts, a saved verification pause, live resolver ownership, full browser-start Resume behavior, detached batch controls, and explicit rescanning. Browser tests verify closed-source access and failed-result retention through the real popup. Stable batch IDs and complete mutation serialization remain separate planned work (REL-05/REL-06).

## Dependency and CI notes

The lockfile pins the test stack. `minimatch` and `glob` overrides select patched releases for development tools; rerun all checks after changing them. No npm package is bundled into the production extension by this setup.

CI runs static/unit/coverage checks on Windows and Linux and browser checks on Linux, with no non-blocking exceptions. Actions are pinned to verified commit revisions and workflow permissions are read-only. Local passing results do not establish remote CI success until the branch has been pushed and GitHub checks have run.

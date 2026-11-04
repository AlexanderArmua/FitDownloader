# Working on FitDownloader

## Start here

1. Read `IMPROVEMENT_PLAN.md`, particularly **Resume checkpoint**, **Decisions and constraints**, and the current phase.
2. Inspect `git status --short`, the current branch, and recent commits before editing. Preserve unrelated user changes.
3. Check whether the recorded baseline still matches the checkout. Inspect the relevant source and tests; do not rely on a previous chat's claims.
4. Use the plan's next task as the starting point when the user asks to resume the plan. Follow newer user instructions if scope or priorities change.

## Project and scope

- Primary repository: `https://github.com/AlexanderArmua/FitDownloader` (`origin`).
- Original project: `https://github.com/axel-devs/FitDownloader` (`upstream`).
- Work in this repository for now, until the original creator starts accepting new pull requests. Coordinate any future upstream contribution with the user.
- Upstream contribution: `https://github.com/axel-devs/FitDownloader/pull/2`. This is context, not the default destination for new work.
- Work on the user's fork. Use a focused branch for implementation; do not rewrite existing history or change the upstream PR without current authorization.
- Do not infer permission to push, publish releases, create additional PRs, install the extension, or start large real downloads merely from this file. Follow the active user's request and existing session authorization.
- No sub-agent delegation is required by these instructions.

## Implementation order

- The user wants tests and reliable validation before production behavior changes.
- Start with truthful application coverage, realistic mocks, and characterization tests. Do not perform a broad architecture or UI rewrite first.
- For each recovery bug, reproduce it with a focused regression test, fix it, and show that the regression and existing suite pass.
- Keep default-branch CI green. Temporary failing tests belong in the local red/green cycle, not as an indefinitely failing default-branch suite. Do not conceal defects with unconditional skips or misleading coverage thresholds.
- Work in small reviewable steps. Establish a useful safety net, then fix recovery; do not delay important fixes until every possible test or a percentage target is complete.

## Behavior to preserve

- Resolve supported downloads without opening ad pages or executing remote scripts.
- Keep HTTPS enforcement, exact host checks, isolated page scanning, and narrow production permissions.
- Respect browser/host verification. Never disable browser security or automatically solve verification challenges.
- Keep concurrency configurable. It currently applies per batch; a global cap is a separate planned feature.
- Preserve manual file selection and standard Chrome download-manager behavior.
- Protect persisted download state and avoid starting duplicate downloads during recovery.

## Checks

- Use Node 24 (at least 24.8.0), then `npm ci --ignore-scripts` on a fresh checkout.
- Run `npm run check` for scoped lint, manifest validation, unit/DOM tests and application coverage. Run `npm run test:browser:install` once and `npm run test:browser` for real Chromium tests. See `tests/README.md` for scope and isolation details.
- `git diff --check` should pass before a handoff or commit.
- TEST-01 is implemented: use the c8-based `npm run test:coverage`, not the raw Node coverage command. All application files, including unexecuted scripts, must stay in the denominator; integrity checks reject empty/missing-file reports.
- REL-01 through REL-04 are fixed and their regression tests are required in the normal lifecycle suite. `npm run test:regressions` runs that passing recovery subset. There are no known-failure skips, TODO masks, or non-blocking CI exceptions.
- Browser startup pauses saved queues until explicit Resume; ordinary service-worker recovery reconciles and resumes eligible work. Closed-source batches remain accessible through the popup's Saved batches picker.
- REL-05 uses durable batch/file IDs. Sessions are keyed by batch ID; `sourceTabId` is metadata only. Messages, resolver ownership and download mappings must use batch/item IDs, never tab IDs or array positions. The `ffBatchState` schema-2 snapshot stores sessions and mappings together; legacy keys are retained unchanged during migration.
- REL-06 routes live state operations through `mutateState`. Internal `*State` helpers run inside that queue: never await a queued public wrapper from inside a mutation. Persist immutable snapshots in order; keep host fetches and Chrome download creation outside the mutation queue, then recheck file identity/generation when committing their results. Schedule queue pumps without awaiting them inside mutations.
- REL-07 awaits each Chrome control and retains per-file successes and rejected ownership. Failed Cancel remaps surviving downloads to the current generation; never clear their IDs or rescan as if cancellation succeeded. Partial controls hold queued work and persist retry intent/errors. A failed search preserves the last confirmed state; only a successful empty search means a missing download. Failed cancellation of late Chrome creation must retain recoverable ownership, even if the old file was restarted or the old batch removed.
- REL-08/09 track Chrome change/erase events and immediately reconcile newly registered IDs. Bounded early events exist only while creation is pending; never collect unbounded events for unrelated downloads. Paused files retain slots. The optional schema-2 `downloadHistory` associates previous Chrome attempts with batch/file identity across recovery; erasure removes associations, while finished results remain. A resumed old attempt must not overwrite a new retry; restore it separately and hold queued work for explicit Resume.
- REL-10 keeps per-resolver AbortControllers scoped to batch ownership. Cancel invalidates the generation and aborts that batch's landing/POST requests and body reads; intentional aborts do not mark failures or pump replacements. Chrome creation already underway still needs late-ID cancellation/reconciliation. Keep request timeouts distinct from intentional cancellation.
- Tests must not depend on live file-host uptime, advertising, challenge pages, or downloading archives. Use local fixtures and tiny test downloads for browser integration tests.
- After development commands and CI exist, use the actual repository commands and update this section if they replace the baseline.
- DEV-03 packages committed HEAD with `npm run package`; keep the explicit runtime allowlist and ZIP tests current when adding runtime assets. Once this release workflow is enabled, a new version on CI-passing own main automatically publishes a GitHub release. Bump manifest/package/lock versions together intentionally. Documentation-only changes with an already published version do not replace releases. See `RELEASING.md`; do not move published tags or overwrite public assets.

## Before ending work

Update `IMPROVEMENT_PLAN.md` in the same change as implementation:

- Check only tasks whose acceptance criteria are met.
- Set **Resume checkpoint** to the exact next task, current branch/commit, changed files, validation results, and blockers or pending decisions.
- Add a dated work-log entry describing the result and any tradeoffs.
- Distinguish automated tests, manual user confirmation, and unverified assumptions. Never describe mocked host responses as live compatibility evidence.
- Keep the task IDs stable; record deferred or superseded work rather than silently deleting it.

The plan is the durable source of progress. A future chat must be able to resume from the files alone.

## Final responses

Finish each final response with concrete suggestions for the next work, normally the next task from the plan and its purpose.

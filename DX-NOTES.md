# DX notes

Completed verification and development observations. The README owns setup
and the demonstration; this file records the evidence behind it.

## 2026-09-08 — Local implementation

With Node 22.19, authoring package 0.5.2, CLI 0.6.7 and Sentry SDK 10.73.0,
`npm run check` passes: 33 tests, typecheck, and authoring doctor with zero
errors. Doctor warns that the Sentry token has no local Development value;
the token is intended to be uploaded to the managed secret store.
The same checks passed on GitHub's Ubuntu runner in
[the initial CI run](https://github.com/diggerhq/opencomputer-example-oncall/actions/runs/34234930973).

Both incident commands execute the application code. The API returns a
captured 500 for a legacy record and 200 for the healthy control. The worker
makes four failed attempts on the same job while two healthy jobs remain
unattempted. Tests apply corrections only to disposable source copies:
the legacy API request succeeds without changing the healthy timezone,
and the worker retains a failed job while completing both healthy CSVs.

Hook tests exercise the published authoring package with a test-only hook
bridge. They verify domain selection and reject invalid locators; they do
not establish runtime filtering or capture the actual provider request.
The Sentry tests use a fake SDK/provider boundary, plus a repeatable test
of the actual SDK's serialized transport envelope. The latter preserves the
real worker exception's stack, release, snapshot and breadcrumbs without
network access. Neither is a live Sentry run.

The source release is a content digest of the canonical application files.
Packaging records that release in the agent workspace. The event reader
rejects different event IDs, services, releases, or malformed snapshots and
clears previously captured state before another read. Replay tools start
a new Node process so they see the agent's source edits.

CLI 0.6.7 still scans previous generated runtime modules during doctor.
The preparation script removes that generated runtime and stages the app
before each doctor/deploy. It preserves credentials and project bindings.

## 2026-09-08 — Development hook selection

Deployed to this example's new `oncall` Development project,
`prj_3bb9edd953db4a3e8536067691fc20c7`. Deployment
`oncall:a0bf975266601d715ab4077fa39f27db5a036fad29ff28ac730b39dd52dda6ee`
contains source release `oncall-reporting@3f204e56eb54`.

Two webhook probes used synthetic locators with the Sentry credential
deliberately absent. Both reached `read_sentry_event`, received the managed
credential error (HTTP 409), and stopped without substituting fixture data.
This verifies the loaded artifact, bundled release check, selected tool
invocation, and failure behavior. It is not a successful Sentry read or an
incident diagnosis.

| Service | Session | Domain tools in every persisted render |
|---|---|---|
| API | `6b7c3602-9108-4f56-9c38-8c881a546246` | `inspect_record`, `replay_request` |
| Worker | `3650344e-8f5b-4e83-a1c0-7e6ec152f795` | `inspect_queue`, `replay_worker` |

Both renders also selected `read_sentry_event`, `shell`, `read`, `write`,
`glob`, and `grep`. The deployment and model were identical. Each response
rendered twice, preserving its service selection after the tool result.
These are actual persisted runtime render records, not a full capture of
the provider's request. The probe runtimes were terminated after inspection.

Review caught a runtime-specific replay issue before deployment: a tool's
`process.execPath` points at the native engine executable, rather than Node.
Replay now invokes `node` from the runtime's PATH. Local replay tests exercise
the corrected path; a successful cloud replay still needs the live incidents.

Live Sentry ingestion, successful managed reads, and model-produced
corrections remain pending Sentry access. No Production deployment was made.

## 2026-09-08 — Sentry access and integration choice

Created `digger/opencomputer-oncall-demo` with default alert rules disabled.
Sentry's documented [organization project creation API](https://docs.sentry.io/api/projects/create-a-project-for-an-organization/)
supports members when member project creation is enabled, creating a personal
team for the new project. Creating under the existing shared team had been
denied; its permissions were not changed.

The agent retains the managed REST connection. Replay needs the complete
structured `contexts.oncall.snapshot`, validated against the original capture.
[Sentry MCP](https://github.com/getsentry/sentry-mcp) is useful for broader
issue exploration, but its event tool returns formatted context. Sentry's
[event formatting limits](https://github.com/getsentry/sentry/blob/master/src/sentry/issues/formatting/limits.py)
can truncate that context, so it is not a reliable exact snapshot transport.
The [Sentry CLI](https://cli.sentry.dev/) provides JSON event reads, but using
it inside this agent would add installation and authentication plumbing.
The current reader already supplies the one operation this example needs.

Local setup used Sentry CLI 0.44.1 device login and exported its OAuth access
token into the ignored `.env` and the managed Development secret. The agent
does not receive the token in its workspace. This exported value is a static
copy: [CLI refresh](https://github.com/getsentry/cli/blob/0.44.1/packages/cli/src/lib/db/auth.ts)
does not update the deployed secret, and [Sentry refresh rotates access tokens](https://github.com/getsentry/sentry/blob/master/src/sentry/models/apitoken.py).
Re-export and update the managed secret after refresh or expiry. Use a
dedicated read-scoped API token for a persistent deployment.

## 2026-09-08 — Both live investigations completed

Both commands completed against the real Sentry development project and the
same OpenComputer deployment recorded above. The local sender confirmed that
Sentry preserved the exact event ID, release and snapshot before dispatch.
Both agents then read those events through the managed connection and ran
the packaged application in their own workspaces. Neither run required a
code change to the example or platform.

| Incident | Sentry issue | OpenComputer session | Persisted renders |
|---|---|---|---|
| API | [7719416418](https://sentry.io/organizations/digger/issues/7719416418/) | `496854f8-f4a8-4dc9-ad29-958d3450bf20` | 7 |
| Worker | [7719418038](https://sentry.io/organizations/digger/issues/7719418038/) | `509074c7-c82d-4c2b-b417-ad621d2fd9b1` | 8 |

Every render retained its service's diagnostic pair and the shared tools;
all used `anthropic/claude-sonnet-5`. There were no failed tool calls or turns.

The API's replay tool returned 500 for `report-legacy` and 200 for
`report-current`. The agent added a UTC fallback in `app/api.mjs`. Subsequent
tool results showed the legacy request returning 200 with UTC and the healthy
London response unchanged.

The worker's first replay made four failed attempts on `job-101`, leaving
both healthy jobs pending. The agent added `job.status = "failed"` to the
catch block in `app/worker.mjs`. The next replay retained the bad job's error
and failed state, then completed `job-102` and `job-103` with their expected
CSV contents. This confirms queue progress without hiding the malformed job.

These conclusions were checked against replay tool results, not only the
agents' final reports. Both completed sessions were suspended for inspection.
The canonical source defects remain unchanged, so the commands can be run
again for recording. No video was recorded in this verification.

## 2026-09-08 — Recording exposes an incomplete on-call workflow

Igor's trial made the investigation look local to the laptop: the demo
command triggers the incident locally and streams the remote agent's report
into the same terminal. It prints tool names but omits completed tool results.
The correction and replays actually run in the OpenComputer cloud workspace.
Source is packaged at deployment, so no repository clone appears in the
session. The current example runs captured-state replays, not a repository
test suite, and does not produce a fix PR.

The expected on-call outcome is a reviewable repository correction: fetch
the Sentry evidence, check out the relevant source, reproduce the bug with a
regression test, make the fix, run tests, and open a PR with the evidence.
That workflow is not implemented by the successful replay runs above. Its
next scope belongs in the examples workstream.

Dashboard source at OpenComputer `c78110c` also corrects an earlier recording
instruction: [webhook sessions](https://github.com/diggerhq/opencomputer/blob/c78110c/web/src/managed-agents/Session.tsx)
offer Conversation and raw Events. The render inspector is available only
in [Playground](https://github.com/diggerhq/opencomputer/blob/c78110c/web/src/managed-agents/Detail.tsx).
There is no managed-session terminal, file browser, or patch viewer in that
UI. The README now points to recorded render and tool-result events rather
than promising a webhook-session inspector.

## 2026-09-08 — Cloud checkouts and fix PRs

The repository workflow is implemented at
[`04b1e334`](https://github.com/diggerhq/opencomputer-example-oncall/commit/04b1e334a737824d719341f674d7048afa69401c).
Both incidents ran against that source commit in the `oncall` Development
project, using deployment
`oncall:854ecc9072778a52bc23c5012f5615b70cbeefdd886358c6f32026b3f00c885f`
and `anthropic/claude-sonnet-5`. Application release:
`oncall-reporting@3f204e56eb54`.

The local command recorded the exception in Sentry, dispatched its locator,
printed the cloud session URL, and exited. Each cloud session then read its
Sentry event, cloned the public repository, checked out the recorded commit,
and authored a regression test. Shell results contain the actual clone,
checkout, failing test, correction, and passing test commands. Application
source is no longer packaged in the agent deployment.

| Incident | Cloud session | Fix PR | Original source with new regression | Corrected source |
|---|---|---|---|---|
| API | [750bb025](https://app.opencomputer.dev/projects/prj_3bb9edd953db4a3e8536067691fc20c7/sessions/750bb025-7fe2-4452-ae96-d076ff6ce7fa?agent=oncall&environment=development) | [#1](https://github.com/diggerhq/opencomputer-example-oncall/pull/1) | 8 tests: 7 pass, 1 fail | 8 pass |
| Worker | [15257883](https://app.opencomputer.dev/projects/prj_3bb9edd953db4a3e8536067691fc20c7/sessions/15257883-0578-493a-ba5c-6d7370741be6?agent=oncall&environment=development) | [#2](https://github.com/diggerhq/opencomputer-example-oncall/pull/2) | 7 tests: 6 pass, 1 fail | 7 pass |

The managed PR tool independently reproduced those before/after results
from the actual changed files and embedded the test output in each PR body.
Each diff changes one application line and adds one regression test; existing
tests, fixtures, and replay code remain unchanged. GitHub application CI is
green on both PRs. They remain open and unmerged. No fix was deployed or
marked resolved in Sentry.

The API session has 17 persisted renders; the worker has 22. Every API render selected
`inspect_record` and `replay_request`; every worker render selected
`inspect_queue` and `replay_worker`. Each also selected the shared Sentry,
shell, file, and PR tools. The model and deployment were identical throughout.
These are persisted render records, not a capture of provider requests.

The API session returned its PR URL, completed the turn, and was suspended.
The worker reached `open_fix_pull_request`, then recorded
`runtime.disconnected` at `2026-09-08T15:03:37.581Z` (event 161). GitHub
nevertheless received the commit and PR, and CI passed. The session recorded
neither the publication tool's result nor a final response; inspection showed
`waiting_runtime`, its turn queued, and `microvmState: running`. The public
disconnect event contained no reason. This establishes a lost runtime
connection and an external action completed without a recorded result; it
does not establish a VM crash or its cause. No publication was retried.

A complete event read also contains GitHub requests after the disconnect,
including `POST /pulls` returning 201 at `15:03:54.794Z`, followed by five
more renders. Those requests and renders continued to be recorded even while
tool-result and turn-completion delivery was absent. The disconnected worker
session was subsequently suspended, preserving the evidence. Its turn remains
unfinished; suspension is not recovery. The terminal follower now describes
connection loss and directs the operator to check the PR before retrying,
rather than implying that execution and external actions necessarily stopped.

Local validation before deployment passed 81 tests, typecheck, and authoring
doctor. Doctor's two missing-local-secret warnings were expected: both
credentials were configured as managed Development secrets. Main's demo
harness and application CI passed. No platform code change or Production
deployment was made, and no video was recorded in this verification.

## 2026-09-08 — Use the product's inspection commands

The walkthrough now follows an operator through the Sentry issue, the
deployed agent's investigation, and its GitHub PR. It uses the installed
OpenComputer CLI 0.6.7 directly: scoped `logs` finds the session making the
Sentry read; `session attach` displays messages and tool progress;
`sessions tail --json` exposes tool results and rendered tool selection.
Read-only calls against the existing Development sessions verified these
surfaces. `logs --limit 10` selects recent entries and supports `--follow`.
`session list` is account-wide and has no agent/environment filter.

The example-specific `follow` helper is no longer the documented recording
path. It polls events, formats output, writes local JSONL, and suspends on
completion. The native viewers neither drive execution nor suspend it;
Ctrl-C only detaches. Their remaining presentation gap is real: `attach`
omits command output, while `tail` and dashboard Events expose raw JSON.

Alert delivery is still simulated by `scripts/demo.mjs`: the app captures
a real exception in Sentry, then the script separately invokes OpenComputer.
A fully automatic operator story needs Sentry itself to make that invocation.
[Sentry's issue-alert webhook](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
has a provider-specific body; OpenComputer currently requires `text` or
`payload` at the top level. A translator would bridge those formats. Current
[Sentry custom integrations support webhook headers](https://docs.sentry.io/api/integration/update-an-existing-custom-integration/),
so accepting raw webhook bodies in OpenComputer is another possible product
path. Neither integration path was implemented or live-validated here.

## 2026-09-08 — Direct Sentry delivery, pending the integration

OpenComputer now accepts provider webhooks directly (CLI 0.6.8): the
webhook URL carries its credential, any JSON body is admitted as the
agent's payload, and a per-webhook identity source deduplicates provider
retries. This example therefore drops its own delivery:

- `scripts/demo.mjs` records the incident in Sentry and waits for the
  alert to reach the agent, found through the webhook's request ledger
  (`GET .../webhooks/<id>/requests`) as a request created after the
  incident with an announced session. It no longer posts to OpenComputer.
- `lib/incident.ts` derives the locator from Sentry's issue-alert body:
  `data.event.event_id` and `release`, plus the `oncall` context the demo
  app stamps on every capture. Sentry names the project by id only, so the
  organization and project slugs are pinned in `lib/target.ts`; `setup`
  refuses a mismatch with `.env`.
- `scripts/sentry.mjs` gives every run its own fingerprint, so an alert
  rule on "a new issue is created" fires per run. Demo grouping only.
- `setup` creates or updates the webhook with `--identity
  body:/data/event/event_id` and prints the delivery URL and the two Sentry
  steps.

Verified locally: 77 example tests and 6 application tests pass, doctor
clean; deployed as `oncall:f69464e5…` to Development; the identity source is
set on webhook `wh_2bc70d2a…`. A Sentry-shaped body posted to the URL form
by hand during the platform release was acknowledged in 0.39 s and ran a
session.

Not yet verified: the live chain. Creating the internal integration needs
an organization Manager or Admin; the token in `.env` gets HTTP 403 from
`POST /api/0/sentry-apps/`, as the handover recorded. Until the integration
and its alert rule exist, `npm run demo` records the incident and times out
waiting for a delivery, with a message saying so.

## 2026-09-08 — Review confirms the direct-delivery API run

Reviewed source `b664e07` and the existing live Development run through
read-only session/event and GitHub API calls. No new incident, deployment,
or publication was triggered by this review.

The configured project is now `opencomputer/opencomputer-oncall-demo`.
The local `lib/target.ts` organization override matches `.env` and the
deployed agent; it remains an uncommitted local customization.

The [Sentry issue](https://sentry.io/organizations/opencomputer/issues/7720368878/)
corresponds to event `534c46058a104e65978bd5830c1084ae` and
[session dd2cfe96](https://app.opencomputer.dev/projects/prj_3bb9edd953db4a3e8536067691fc20c7/sessions/dd2cfe96-e88a-7d27-cc61-4aa710d728d3?agent=oncall&environment=development).
Its persisted render input has `source: webhook`, a Sentry `action: triggered`
body, and the exact event ID saved by the demo command. The webhook ledger
records acceptance on attempt 1. This verifies the incident-to-session
correlation for this run, independently of the demo command's output.

The session recorded 170 events and a completed turn. Its 15 renders all
selected API diagnostics (`inspect_record`, `replay_request`) and the
shared Sentry/coding/PR tools. Recorded command results show:

- `git clone` and detached checkout of the published incident commit;
- the new regression failing on the original source: 6 pass, 1 fail;
- the one-line timezone correction and the suite passing all 7 tests;
- successful publication of [PR #3](https://github.com/diggerhq/opencomputer-example-oncall/pull/3),
  changing only `app/api.mjs` and its new regression test. GitHub application
  CI passed. The PR remains open and unmerged.

This closes the earlier API integration gate. A worker run through the
new direct Sentry integration was not verified; the earlier worker evidence
above used the old dispatch path. No video was recorded by this review.

Two example issues remain:

1. `scripts/demo.mjs:awaitDelivery` selects the newest request after the
   trigger time without matching the captured event or checking its
   outcome. An isolated test of the actual function selected an unrelated
   worker session during an API run, and returned a failed request as a
   successful delivery. Pass the captured event ID into correlation and
   distinguish pending, accepted, and failed admission. The public request
   view currently omits `idempotencyKey`; do not assume that field is
   available when fixing this. For recording before correction, run one
   incident at a time and confirm its event ID in the session's render input.
2. `test/agent.test.ts` hardcodes the `digger` organization instead of using
   the configured target. The documented organization customization makes
   that assertion fail. Local checks passed 76 of 77 example tests; all
   6 application tests and typecheck passed. Doctor passed with its two
   expected missing-local-secret warnings (live managed reads and PR
   publication prove the deployed credentials work).

Use the README's native inspection commands for recording. `session attach`
shows messages and tool progress; command output and hook tool selection
are in dashboard Events or `sessions tail --json`. Setup is already complete
on this checkout; avoid displaying its credential-bearing URL in a recording.

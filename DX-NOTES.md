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

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

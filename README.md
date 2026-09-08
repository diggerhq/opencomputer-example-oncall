# An on-call agent that opens fix PRs

Send this agent a Sentry error. It clones the repository in OpenComputer,
reproduces the bug with a failing test, fixes it, and opens a GitHub PR.

The demo app has two bugs: a request crashes on a missing timezone, and a bad
job blocks the queue. API incidents need record inspection and request replay;
worker incidents need queue inspection and worker replay. **Each service's
tools and instructions live together in an OpenComputer hook.** The same agent
handles both by selecting the hook for the incoming alert.

## Walk through an incident

Complete the [setup](#setup) once, then run from the current published `main`.

A customer opens an older report and gets a 500. Trigger that request:

```sh
npm run demo -- api
```

Open the printed **Sentry issue**. The exception is
`TypeError: Cannot read properties of null (reading 'trim')` on
`GET /reports/report-legacy`. The event includes the source release and the
report data needed to reproduce it.

The demo command records the error in Sentry and waits. Sentry's alert rule
delivers the issue to the agent's webhook; the command prints the session
that OpenComputer started for it and exits. The investigation continues in
OpenComputer after the command returns.

Check what the on-call agent is doing using the OpenComputer CLI:

```sh
npx opencomputer logs --agent oncall --environment development --limit 10 --follow
```

The Sentry request in the logs identifies the session reading the incident.
Copy its ID, press Ctrl-C to stop watching the logs, then attach to that session:

```sh
npx opencomputer session attach <session-id>
```

The agent reads the Sentry event, clones the repository at the failing commit,
compares the broken report with a healthy one, and writes a regression test.
It observes the failure, corrects the code, and runs the tests again. `attach`
shows the agent's messages and tool progress; Ctrl-C detaches the viewer.

For the recorded commands, test results, and selected diagnostic tools, use
the session's **Events** tab in the dashboard or the native event stream:

```sh
npx opencomputer sessions tail <session-id> --json
```

These views expose raw events: `tool.completed` holds the command results,
and `agent.rendered` holds the instructions and available tools. Add
`--no-follow` to read the existing events and exit.

Open the **PR linked in the agent's response**. It contains the code change,
a new regression test, and output showing that test failing before the fix
and passing afterward. The publisher independently checks the changed files;
GitHub CI runs the application tests again. The
[API fix from a completed run](https://github.com/diggerhq/opencomputer-example-oncall/pull/1)
shows the resulting patch. Leave it unmerged so the incident stays reproducible.
Once finished inspecting, end the session with
`npx opencomputer session end <session-id>`.

Now a different incident: report jobs stop completing. Trigger it with
`npm run demo -- worker`, open its Sentry issue, and inspect the new session
the same way. The agent gets queue inspection and worker replay tools for
this investigation. It isolates the bad job so healthy jobs can finish;
[the worker PR](https://github.com/diggerhq/opencomputer-example-oncall/pull/2)
shows that correction. The deployment and model are the same in both cases.

Each demo command creates a new Sentry issue and a new fix branch: the demo
gives every run its own fingerprint so the "new issue" alert fires each
time, where a real application would keep Sentry's grouping. A Sentry retry
of the same alert never starts a second investigation; the webhook takes
its delivery identity from the event id in the alert body. If the runtime
disconnects, check GitHub before retrying: publication may have succeeded
before its result reached the session. The worker run above encountered
this; [DX-NOTES](DX-NOTES.md#2026-09-08--cloud-checkouts-and-fix-prs) records it.
No fix is deployed or marked resolved in Sentry.

## How the agent gets its tools

OpenComputer calls your agent function before each model step. A
[hook](https://docs.opencomputer.dev/agents/hooks) can register tools for that
step and return instructions for using them. The
[API hook](opencomputer/agents/oncall/hooks/api.ts), abridged:

```ts
export function useApiDiagnostics() {
  useTool(inspectRecord);
  useTool(replayRequest);

  return "Compare the failing request with a healthy report, " +
    "then repeat both checks after your correction.";
}
```

[`agent.ts`](opencomputer/agents/oncall/agent.ts) selects the hook from the
alert's service and includes its instructions (abridged):

```ts
const runbook = incident.service === "api"
  ? useApiDiagnostics()
  : useWorkerDiagnostics();

return `Investigate this Sentry incident, verify a fix, and open a PR.
${runbook}`;
```

Only the selected hook's diagnostic tools enter the model call. Both services
share the Sentry reader, coding tools, and PR publisher.

## Setup

Requires Node 22.19+.

```sh
git clone https://github.com/diggerhq/opencomputer-example-oncall.git
cd opencomputer-example-oncall
npm ci
```

Create a Sentry Node.js development project and a
[read token](https://docs.sentry.io/api/guides/create-auth-token/)
with **Project: Read** and **Issue & Event: Read**. Copy `.env.example` to
`.env` and fill in the project's DSN, token, organization slug and project slug.
The agent pins the same organization and project slugs in
`opencomputer/agents/oncall/lib/target.ts`; edit them for your project.
Set `GITHUB_TOKEN` with **Contents: Write** and **Pull requests: Write** on
this repository. The configured GitHub target is `diggerhq/opencomputer-example-oncall`;
the live demo requires permission to open branches and PRs there.

```sh
npx opencomputer login
npm run setup
```

`setup` creates an `oncall` project or reuses the local binding, uploads both
tokens, deploys to **Development**, creates the agent's webhook with the
Sentry event id as its delivery identity, and prints the webhook URL. Managed
connections attach credentials to Sentry and GitHub requests; neither token
enters the agent's checkout.

Then connect Sentry to the agent, once:

1. In Sentry, **Settings → Developer Settings → Custom Integrations → Create
   Internal Integration**. Set the webhook URL to the one `setup` printed;
   it carries the webhook's credential, so treat it as one. Enable **Alert
   Rule Action**. Delivery needs no permissions.
2. **Alerts → Create Alert → Issues** on the project: when **a new issue is
   created**, **send a notification via** the integration.

Sentry posts its issue-alert body to the agent as is; the agent reads the
event id, release, and the application's `oncall` context from it.

To exercise the failures without accounts, use `npm run incident -- api`
or `npm run incident -- worker`. `npm run test:app` runs the application
suite; `npm run check` also checks the demo machinery and intentional faults.
After changing agent source, redeploy with `npm run setup`.

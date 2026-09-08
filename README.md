# An on-call agent that opens fix PRs

Send this agent a Sentry error. It clones the repository in OpenComputer,
reproduces the bug with a failing test, fixes it, and opens a GitHub PR.

The demo app has two bugs: a request crashes on a missing timezone, and a bad
job blocks the queue. API incidents need record inspection and request replay;
worker incidents need queue inspection and worker replay. **Each service's
tools and instructions live together in an OpenComputer hook.** The same agent
handles both by selecting the hook for the incoming alert.

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

## Run the failures

Requires Node 22.19+.

```sh
git clone https://github.com/diggerhq/opencomputer-example-oncall.git
cd opencomputer-example-oncall
npm ci
npm run incident -- api
npm run incident -- worker
```

The API returns 500 for the legacy report and 200 for the current report.
The worker makes four attempts on `job-101`; `job-102` and `job-103` remain
pending with zero attempts. These commands run locally without accounts.

## Send them to the agent

Create a Sentry Node.js development project and a
[read token](https://docs.sentry.io/api/guides/create-auth-token/)
with **Project: Read** and **Issue & Event: Read**. Copy `.env.example` to
`.env` and fill in the project's DSN, token, organization slug and project slug.
Set `GITHUB_TOKEN` with **Contents: Write** and **Pull requests: Write** on
this repository. The configured GitHub target is `diggerhq/opencomputer-example-oncall`;
the live demo requires permission to open branches and PRs there.

```sh
npx opencomputer login
npm run setup
npm run demo -- api
npm run demo -- worker
```

`setup` creates an `oncall` project or reuses the local binding, uploads both
tokens, deploys to **Development**, and saves a webhook credential locally.
Managed connections attach credentials to Sentry and GitHub requests;
neither token enters the agent's checkout.

Run from the current published `main` commit. Each command triggers the
exception on your laptop, records it in Sentry with its source commit and a
small diagnostic snapshot, then forwards the locator to OpenComputer. This
script supplies alert delivery. It prints the cloud session URL and exits;
the agent continues independently.

## Follow the fix

Open the session URL. The agent reads Sentry, clones this public repository,
checks out the incident's commit, and investigates `app/`. It adds a regression
test under `app/test/`, shows it failing, edits the affected service, and runs
the application tests again. The final response links the fix PR.

For readable commands, diffs, and test results in a terminal:

```sh
npm run follow -- api
# Or trigger and follow a new incident together:
npm run demo -- worker --follow
```

These commands display events from the cloud session. Following a completed
session suspends it while retaining its workspace.
If the runtime disconnects, check GitHub before retrying: a PR can have been
created even when its tool result never reached the session. The worker run
behind PR #2 encountered this; [DX-NOTES](DX-NOTES.md#2026-09-08--cloud-checkouts-and-fix-prs)
records the interruption.

Compare the two **Tools** lines. In the dashboard session's **Events** tab,
`agent.rendered` contains the instructions and selected tools;
`tool.completed` contains the recorded results. These webhook sessions show
raw event JSON rather than the Playground's render inspector.

The PR tool reads the actual changed files and independently tests them
against the original and corrected source before publishing. The same new
test must fail before and pass after; existing application tests must pass.
Only the affected service and its new regression test enter the PR. GitHub
CI runs the application suite again.
See the agent's [API fix](https://github.com/diggerhq/opencomputer-example-oncall/pull/1)
and [worker fix](https://github.com/diggerhq/opencomputer-example-oncall/pull/2)
for the actual patches and before/after test output.

Leave demo PRs unmerged so the incidents remain reproducible. Every demo
command creates a new event and fix branch; retrying publication for the
same event reuses its PR. No fix is deployed or marked resolved in Sentry.

`npm run test:app` runs the application suite. `npm run check` also checks the
demo machinery, which intentionally verifies the two faults on `main`.
After changing source, `npm run setup` redeploys it. See [DX-NOTES.md](DX-NOTES.md)
for verification.

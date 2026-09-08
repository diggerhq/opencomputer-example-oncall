# On call: tools and runbooks as code

API failures and stuck workers need different investigation procedures.
This example pairs each service's runbook with its diagnostic tools and
selects which set the model receives from a Sentry alert. One coding agent
investigates both kinds of incident in OpenComputer: it clones the repository,
writes a failing regression test, fixes the code, and opens a pull request.

With [OpenComputer Serverless Agents](https://docs.opencomputer.dev/agents/hooks),
**a TypeScript function defines the instructions and tool catalog for each
model step.** OpenComputer calls it before the model runs, executes the tools
the model chooses, then calls it again for the next step. Your code controls
the context; the model decides how to investigate.

The reporting app has two deliberately introduced defects:

| Sentry incident | Context supplied to the model | Fix to review |
|---|---|---|
| One report request returns 500; another works | API runbook, `inspect_record`, `replay_request` | A timezone fallback fixes the failing request and preserves the healthy response |
| One job keeps failing; healthy jobs never start | Worker runbook, `inspect_queue`, `replay_worker` | Isolating the bad job lets both healthy jobs complete |

Both get Sentry, shell, file-editing, and PR tools. The deployment and model
are identical; the worker runbook and diagnostic tool definitions are absent
from the API investigation's model calls, and vice versa.

## A hook owns the tools and how to use them

The [API hook](opencomputer/agents/oncall/hooks/api.ts), with its instructions
shortened:

```ts
export function useApiDiagnostics() {
  useTool(inspectRecord);
  useTool(replayRequest);

  return "Compare the failing request with a healthy report, " +
    "then repeat both checks after your correction.";
}
```

Calling it adds the two tool definitions to the next model call and returns
the guidance that goes with them. [`agent.ts`](opencomputer/agents/oncall/agent.ts)
selects the hook and includes that guidance in its instructions (abridged):

```ts
const runbook = incident.service === "api"
  ? useApiDiagnostics()
  : useWorkerDiagnostics();

return `Investigate this Sentry incident, verify a fix, and open a PR.
${runbook}`;
```

Another service can bring its own tools and runbook in another hook while
sharing the source checkout, testing, and PR workflow.
Here, the alert's service stays fixed throughout the investigation.

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

Compare the two **Tools** lines. In the dashboard session's **Events** tab,
`agent.rendered` contains the instructions and selected tools;
`tool.completed` contains the recorded results. These webhook sessions show
raw event JSON rather than the Playground's render inspector.

The PR tool reads the actual changed files and independently tests them
against the original and corrected source before publishing. The same new
test must fail before and pass after; existing application tests must pass.
Only the affected service and its new regression test enter the PR. GitHub
CI runs the application suite again.

Leave demo PRs unmerged so the incidents remain reproducible. Every demo
command creates a new event and fix branch; retrying publication for the
same event reuses its PR. No fix is deployed or marked resolved in Sentry.

`npm run test:app` runs the application suite. `npm run check` also checks the
demo machinery, which intentionally verifies the two faults on `main`.
After changing source, `npm run setup` redeploys it. See [DX-NOTES.md](DX-NOTES.md)
for verification.

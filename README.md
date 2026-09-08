# On call: tools and runbooks as code

API failures and stuck workers need different investigation procedures.
This example pairs each service's runbook with its diagnostic tools and
selects which set the model receives from a Sentry alert. One coding agent
investigates both kinds of incident in OpenComputer cloud sessions.

With [OpenComputer Serverless Agents](https://docs.opencomputer.dev/agents/hooks),
**a TypeScript function defines the instructions and tool catalog for each
model step.** OpenComputer calls it before the model runs, executes the tools
the model chooses, then calls it again for the next step. Your code controls
the context; the model decides how to investigate.

The reporting app has two deliberately introduced defects:

| Sentry incident | Context supplied to the model | What the agent verifies |
|---|---|---|
| One report request returns 500; another works | API runbook, `inspect_record`, `replay_request` | A timezone fallback fixes the failing request and preserves the healthy response |
| One job keeps failing; healthy jobs never start | Worker runbook, `inspect_queue`, `replay_worker` | Isolating the bad job lets both healthy jobs complete |

Both also get Sentry and source-editing tools. They read the event, reproduce
the failure, edit the app in their cloud workspace, and replay it to check the fix.
The deployment and model are identical; the worker runbook and diagnostic
tool definitions are absent from the API investigation's model calls, and
vice versa.

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

return `Investigate this Sentry incident and verify a local correction.
${runbook}`;
```

Another service can bring its own tools and runbook in another hook while
sharing the Sentry reader, source-editing tools, and investigation loop.
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

```sh
npx opencomputer login
npm run setup
npm run demo -- api
npm run demo -- worker
```

`setup` creates an `oncall` project or reuses the local binding, uploads the
Sentry token, deploys to **Development**, and saves a webhook credential
locally. A managed connection attaches the Sentry token to the agent's GET
requests; the token stays outside its workspace.

Each demo command triggers the exception, waits for its Sentry event, and
forwards the event ID and service to the OpenComputer webhook. The script
supplies alert delivery and follows the investigation in the terminal.
The completed session is suspended for inspection.

The app source is packaged with the deployment; each cloud session starts
with its own copy. There is no repository checkout during investigation.
Sentry carries a small synthetic snapshot with a matching release. Replays
execute the agent's current edits in a fresh process inside that session.
Sentry is the only external integration.

Compare the two **Tools** lines. In the dashboard session's **Events** tab,
`agent.rendered` contains the instructions and selected tools;
`tool.completed` contains the recorded results. These webhook sessions show
raw event JSON rather than the Playground's render inspector.

Repeat either command for a new incident and cloud workspace. The correction
stays there. The agent verifies it with replays; it does not run the repository's
test suite or open a pull request. It does not deploy the correction or mark
the Sentry issue resolved. The repository's defects remain for the next run.

`npm run check` runs the fixture/tool tests, typecheck and authoring doctor.
After changing source, `npm run setup` redeploys it. See [DX-NOTES.md](DX-NOTES.md)
for verification.

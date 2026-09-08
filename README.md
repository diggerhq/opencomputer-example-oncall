# On call

One [OpenComputer](https://docs.opencomputer.dev/agents/hooks) agent investigates
two kinds of Sentry incident. The service in the alert selects its diagnostic
tools and runbook.

The application is small and deliberately broken:

| Incident | What the agent can inspect and replay |
|---|---|
| One report request returns 500; another works | Report records and HTTP requests |
| One report job keeps failing; healthy jobs never start | Queue state and worker attempts |

The agent reads the Sentry event, reproduces the failure against the captured
state, edits a local copy of the application, and checks its correction. Both
incidents use the same deployment and model.

[`agent.ts`](opencomputer/agents/oncall/agent.ts) chooses the runbook:

```ts
const runbook = incident.service === "api"
  ? useApiDiagnostics()
  : useWorkerDiagnostics();
```

Each hook attaches its tools and returns its instructions. OpenComputer runs
the agent function before each model step. The API investigation gets
`inspect_record` and `replay_request`; the worker investigation gets
`inspect_queue` and `replay_worker`. Both have Sentry and source-editing tools.
The demo prints the actual tool selection from the session's render events.

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

`setup` creates an OpenComputer project named `oncall`, uploads the Sentry
token, deploys to **Development**, and saves a webhook credential locally.
It reuses the local project binding on subsequent runs. The Sentry token is
attached by a managed connection when the agent makes a GET request; it is
not included in the agent's workspace.

Each demo command triggers the real exception, waits for its Sentry event,
then forwards the event ID and service to the OpenComputer webhook. This
script supplies alert delivery; a native Sentry alert integration is not
required. The terminal follows the investigation and prints its report.
The completed session is suspended for inspection.

The deployed bundle includes the app source. Sentry carries a small synthetic
snapshot; a release check prevents replaying it against different source.
Each replay starts a fresh process and runs the agent's current edits.
Sentry is the only external integration.

For a recording, compare the two **Tools** lines and open the hook branch
above. The dashboard's session inspector shows the instructions and tools
for each model step. Repeat either command for a new incident and workspace.
The correction stays in that workspace; it is not deployed or marked resolved
in Sentry. The repository's two defects remain available for the next run.

`npm run check` runs the fixture/tool tests, typecheck and authoring doctor.
After changing source, `npm run setup` redeploys it. See [DX-NOTES.md](DX-NOTES.md)
for verification.

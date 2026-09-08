# Reporting app

`api.mjs` handles `GET /reports/:id` and formats a report's creation time.
`worker.mjs` processes pending report jobs and produces CSV contents.

`replay.mjs` runs either entry point against a captured JSON snapshot on stdin.
Each replay starts from a fresh copy of that state and prints the response or
job attempts and outputs. No dependencies or external services are required.

`release.json` is generated when this source is packaged for an agent. The
incident's Sentry release must match that source before investigation begins.

# Reporting app

`api.mjs` handles `GET /reports/:id` and formats a report's creation time.
`worker.mjs` processes pending report jobs and produces CSV contents.

`replay.mjs` runs either entry point against a captured JSON snapshot on stdin.
Each replay starts from a fresh copy of that state and prints the response or
job attempts and outputs. No dependencies or external services are required.

`test/` contains ordinary application tests. Run them from the repository root
with `node --test app/test/*.test.mjs`. A fix PR adds a regression test here.

`release.mjs` identifies the source captured by Sentry. An incident also records
the Git commit so the cloud agent can clone and check out that exact source.

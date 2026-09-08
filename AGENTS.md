# On-call example

This repository owns one OpenComputer Serverless Agent and a deliberately
faulty reporting app. Sentry is the only external application integration.

- `README.md` owns the runnable demonstration and setup.
- `DX-NOTES.md` owns dated verification and product friction.
- `app/` owns the canonical API/worker source, fixtures, and local replay.
- `opencomputer/` owns the agent, diagnostic hooks, and managed Sentry reads.
- `scripts/` owns incident generation, packaging, and demo orchestration.
- `test/` verifies real fixture behavior, tool selection, and integration edges.
- Cross-example decisions live in the sibling knowledge repository at
  `serverless-agents-ws/.agents/work/021-examples-workstream.md`.

Keep the two intentional defects reproducible on main. Corrections made by
the agent belong in its disposable replay workspace. Diagnostic tools must
execute the same application code as the incident generator, never return a
prewritten diagnosis. Distinguish captured-state replay from live monitoring
and local checks from live Sentry/OpenComputer evidence.

Never commit or print credentials, local bindings, generated workspaces, or
raw session/event captures. Never source environment files or force-push.
Use only this example's explicitly named `oncall` Development project for
live validation; do not deploy to Production. No automatic recurrence.
Run fixture/tool tests, typecheck, and authoring doctor before deployment.
Keep the README short: concrete execution, the relevant hook, runnable setup.

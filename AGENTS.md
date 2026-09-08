# On-call example

This repository owns one OpenComputer Serverless Agent and a deliberately
faulty reporting app. Sentry supplies incident evidence; GitHub supplies the
source and the resulting fix PR.

- `README.md` owns the runnable demonstration and setup.
- `DX-NOTES.md` owns dated verification and product friction.
- `app/` owns the canonical API/worker source, fixtures, and local replay.
- `opencomputer/` owns the agent, diagnostic hooks, and managed Sentry reads.
- `scripts/` owns incident generation, packaging, and demo orchestration.
- `test/` verifies real fixture behavior, tool selection, and integration edges.
- Cross-example decisions live in the sibling knowledge repository at
  `serverless-agents-ws/.agents/work/021-examples-workstream.md`.

Keep the two intentional defects reproducible on main. Corrections made by
the agent belong in its cloud checkout and a fix PR; never merge the demo
fixes or push them to main. Diagnostic tools must
execute the same application code as the incident generator, never return a
prewritten diagnosis. Distinguish captured-state replay from live monitoring
and local checks from live Sentry/OpenComputer evidence. Sentry delivers alerts to the agent's
webhook directly; the demo script records the incident and waits for that
delivery, it never calls OpenComputer itself.

For incident fix sessions, clone the pinned commit into `repository/`, edit
only the affected `app/api.mjs` or `app/worker.mjs`, and add its regression
test at `app/test/api.regression.test.mjs` or
`app/test/worker.regression.test.mjs`. Run `node --test app/test/*.test.mjs`
from the checkout. Preserve existing tests, fixtures, and replay code.
Publish through the managed PR tool after its independent verification;
credentials must never enter the checkout. Leave fix PRs open for review.

`app/test/` is the application's ordinary test suite and runs on fix PRs.
Root `test/` verifies the demo machinery, including the intentional faults;
its CI runs on main and on PRs changing the demo machinery.

Never commit or print credentials, local bindings, generated workspaces, or
raw session/event captures. Never source environment files or force-push.
Use only this example's explicitly named `oncall` Development project for
live validation; do not deploy to Production. No automatic recurrence.
Run fixture/tool tests, typecheck, and authoring doctor before deployment.
Keep the README short: concrete execution, the relevant hook, runnable setup.

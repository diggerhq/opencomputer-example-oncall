// This example reads and proposes changes to one public repository.
export const repository = "diggerhq/opencomputer-example-oncall";
export const base = "main";
export const checkoutDirectory = "repository";

// The Sentry project whose alerts reach this agent. Sentry's issue-alert
// body names the project by id only, so the slugs the event reader needs
// are pinned here, with the deployment. `npm run setup` checks they match
// SENTRY_ORG and SENTRY_PROJECT in .env.
export const sentryOrganization = "digger";
export const sentryProject = "opencomputer-oncall-demo";

// Agent SDK sidecar — CLI plan-save redirect (pure, unit-testable).
//
// WHY THIS EXISTS (bug: duplicate top-level sidebar rows): the bundled Claude Code
// CLI saves ITS OWN copy of every plan-mode plan (on ExitPlanMode) into its plans
// directory — by default `~/.claude/plans/` — named from the session's first user
// message plus a random word pair (e.g. `we-are-running-the-vast-pebble.md`,
// `confirmed-intent-from-clarification-ticklish-hamming.md`), with NO app
// frontmatter. That duplicate lands next to the app's canonical, frontmatter-tagged
// `write_agent_plan` copy; lacking a tree_id marker, `arrange_plans` classifies it
// STANDALONE, so the sidebar shows the just-drafted sub-plan as a separate
// top-level entry that never nests under its master row.
//
// THE FIX: redirect the CLI's internal plan saves into the run's `.plan-tree/`
// scratch area via the `plansDirectory` setting, passed on the SDK's `settings`
// option (the "flag settings" tier — highest user-controlled priority, so a
// user/project settings.json can never re-point the sidecar's saves back at
// `~/.claude/plans`). The CLI validates that `plansDirectory` resolves INSIDE the
// project root, so the value MUST stay a relative path with no `..` segments.

export const CLI_PLANS_SUBDIR = ".plan-tree/cli-plans";

// The flag-settings object for every sidecar session. A function (not a bare
// constant) so each call site gets a fresh object the SDK can own.
//
// ORDERING DEPENDENCY (non-obvious): the bundled CLI creates `plansDirectory`
// with a NON-recursive mkdirSync, so this nested path only works because the
// orchestrator's START dispatch (resetPlanTreeDir + persist) creates
// `<cwd>/.plan-tree/` BEFORE startSession opens the SDK session. If a future
// change ever opens a plan-mode session before any `.plan-tree/` write, the
// CLI's plan save would silently fail (it logs the error, doesn't throw).
export function cliPlanRedirectSettings(): { plansDirectory: string } {
  return { plansDirectory: CLI_PLANS_SUBDIR };
}

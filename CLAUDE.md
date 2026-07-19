# CLAUDE.md

@GUIDELINES_NEST_CACHE.md

The imported guidelines are binding. Three always-on rules:
- Full-mode infra (`infra:up` + `test:full`) and Stryker mutation testing are local-only — never wire them into CI.
- Mutation testing is an **occasional, targeted audit — not a per-PR gate**. Scope with `STRYKER_MUTATE` to the file you reworked, `--concurrency 2`, verify kills by hand-applying the mutation + running the plain suite.
- Plans and milestones live in the gitignored `.plan/` folder — read `.plan/00-overview.md` first when resuming work here.

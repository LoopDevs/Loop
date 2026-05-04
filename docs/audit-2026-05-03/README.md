# 2026-05-03 Cold Audit

This directory is the execution cockpit for the 2026-05-03 cold audit of Loop.

Isolation rule:

This is Codex's independent audit workspace. Ignore `docs/audit-2026-05-03-claude/**` entirely during execution: do not read it for evidence, do not use its findings, do not compare against its tracker, and do not include it in file-disposition coverage. If both audits discover the same issue, capture independent evidence in this directory.

Cold audit means the team must derive evidence from the current repository and runtime behavior. Prior audit documents may be used only as structure and historical artifacts. Prior findings, remediations, and sign-offs are not valid evidence for this audit unless independently rediscovered and re-proven from current code.

Baseline:

- Planning date: 2026-05-03
- Baseline commit: `13522bb4ee8279336fb143c5c0f33bbbf6ef205b`
- Baseline worktree: clean at scaffold start
- In-scope tracked files at scaffold start: 1,226
- Workspace file inventory after scaffold refresh, excluding dependency/build output and Claude audit workspace: 1,266
- Audit scaffold files requiring self-review: 69

Primary documents:

- [plan.md](./plan.md): full audit plan, scope, phases, lanes, completeness gates
- [checklist.md](./checklist.md): granular phase checklist
- [tracker.md](./tracker.md): live execution tracker and phase status
- [inventory/](./inventory/): tracked file inventory, phase map, file disposition register
- [protocol/](./protocol/): execution rules, evidence rules, file-disposition rules, pass gates
- [journeys/](./journeys/): user, admin, operational, data, and adversarial journey maps
- [findings/](./findings/): severity model, finding template, live findings register
- [evidence/](./evidence/): phase evidence notes and artifacts

Execution rule:

No phase can be marked complete until its file disposition, cross-file interactions, evidence references, route or workflow inventory where applicable, and second-pass review are complete. The whole audit cannot close until the third-pass synthesis confirms that every tracked file has a disposition and every system interaction has an owner.

Additional pass rule:

The audit must also reconcile planned features against the current feature set. Roadmap, ADR, known-limitation, TODO, deferred-control, and future-phase claims must be mapped to code reality so the final report can distinguish implemented features, partially implemented features, planned-but-absent features, and stale plans.

Plan self-review rule:

The audit scaffold itself is subject to review. Use [inventory/scaffold-disposition.tsv](./inventory/scaffold-disposition.tsv) during Phase 25 to confirm the plan, tracker, checklist, protocol, journeys, findings templates, evidence templates, and inventories are internally consistent and cover code logic, code quality, documentation accuracy, documentation coverage, test coverage, test accuracy, operations, security, and planned-feature gaps.

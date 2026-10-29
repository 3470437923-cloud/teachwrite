# DeepCompose Full Audit and Bug Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task. Every bug fix requires a reproduction test, a root cause note, a focused verification run, and an atomic commit.

**Goal:** Reproduce and repair every confirmed defect found in the existing DeepCompose ledgers and in a second full repository audit, then verify the TypeScript, Vitest, Rust, tooling, and runtime gates before delivery.

**Architecture:** Treat `S:\deepcompose` as one Tauri 2 application with a TypeScript/React policy layer, a Rust file/SSE/window bridge, and Python/PowerShell verification tools. Preserve the frozen disk names and safety contracts. Separate read-only audit work from code changes; group fixes by independent subsystem and serialize edits to shared files.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Vitest 5, Tauri 2, Rust 2021, Python audit tools, Windows PowerShell 5.1.

**Spec:** `README.md`, `AGENTS.md`, `PRODUCT.md`, `docs/KNOWN-LIMITS.md`, `docs/FIX-LEDGER-2026-10-02.md`, `docs/DECISIONS.md`, and `docs/DEVELOPMENT.md`.

## Global Constraints

- Preserve all frozen disk names: `writerd_*`, `.openwrite_*`, `recycle_manifest.json`, `flutter.*`, and `%APPDATA%\\com.writerd\\writerD`.
- Do not delete, stop, or kill unrelated background processes; process scripts may only target their own executable path.
- API keys must never enter source, tests, logs, screenshots, commits, or audit evidence.
- Any disk mutation must keep the write-before-snapshot and user-text-authority contracts.
- Candidate chapters must never update facts, summaries, or tracking documents before adoption.
- Cold-read sessions must retain zero tools, project context, and skills.
- Use `tsc --noEmit`, `vitest run`, and `cargo test --lib`; never use `cargo test --release --lib`.
- Use repository file tools for UTF-8 source edits; do not use Windows PowerShell to write Chinese source.
- A ledger item is closed only after a focused reproduction/regression test and fresh verification output.

---

### Task 1: Establish the audit baseline and issue index

**Files:**
- Read: `AGENTS.md`, `README.md`, `PRODUCT.md`, `docs/KNOWN-LIMITS.md`, `docs/FIX-LEDGER-2026-10-02.md`, `docs/AUDIT-2026-10-02-external.md`, `docs/DECISIONS.md`, `docs/DEVELOPMENT.md`
- Create: `docs/superpowers/plans/2026-10-03-full-audit-fix.md`
- Update: `docs/FIX-LEDGER-2026-10-02.md` only when a confirmed item is repaired

**Interfaces:**
- Consumes: existing ledger IDs and repository test/build commands.
- Produces: a confirmed list of open, retained, and newly discovered issues with evidence links and the relevant source/test files.

- [ ] Run `git status --short`, record the clean baseline, and confirm the branch is `fix/full-audit-2026-10-03`.
- [ ] Run `tsc --noEmit`, `vitest run`, and `cargo test --lib` before changing code.
- [ ] Classify each `保留` entry as intentional boundary, unverified risk, or actionable defect; do not change code for intentional boundaries without evidence.
- [ ] Run the adversarial bug-hunt pipeline over `src`, `src-tauri/src`, `tests`, `tools`, `assets/builtin-skills`, and the maintenance docs.
- [ ] Reconcile the Hunter/Skeptic/Arbiter result with current source and tests before opening a fix task.

### Task 2: Reproduce and close each confirmed legacy ledger item

**Files:**
- Modify only the source and test files named by each confirmed issue.
- Update: `docs/FIX-LEDGER-2026-10-02.md` and, when the issue belongs to the older ledger, `docs/KNOWN-LIMITS.md`.

**Interfaces:**
- Consumes: Task 1 issue index, existing pure-core helpers, and current test conventions.
- Produces: one regression test and one focused fix per confirmed legacy issue, with the ledger status changed from open/partial to a commit reference.

- [ ] For each issue, write the smallest failing test that reproduces the reported behavior.
- [ ] Run that focused test and preserve the failing result as the root-cause evidence.
- [ ] Trace the input from its boundary to the incorrect output and identify the root cause before editing implementation code.
- [ ] Implement one minimal fix, preserving existing contracts and avoiding unrelated refactors.
- [ ] Run the focused test, the affected test file, and the TypeScript/Rust check relevant to the change.
- [ ] Update the ledger row with the exact fix commit and test evidence.
- [ ] Commit each independent repair with a descriptive `fix:` or `test:` message.

### Task 3: Repair newly confirmed core AI/store/tool defects

**Files:**
- Potential source areas: `src/core/ai/*.ts`, `src/core/store/*.ts`, `src/core/tools/*.ts`, `src/core/*.ts`.
- Potential tests: matching files under `tests/ai`, `tests/store`, `tests/tools`, and `tests/core`.

**Interfaces:**
- Consumes: verified bug reports from Task 1 and the existing tool/path/snapshot/session contracts.
- Produces: regression guarded fixes for confirmed AI protocol, persistence, path safety, document format, and project lifecycle defects.

- [ ] Partition reports by non-overlapping subsystem before parallel implementation.
- [ ] Keep shared files such as `exec.ts`, `project.ts`, `session.ts`, and `MainWorkbench.tsx` in one serialized workstream.
- [ ] Use real implementations or the project’s in-memory filesystem test double; avoid interaction-only mocks.
- [ ] Verify cancellation, partial stream retention, malformed external data, path boundaries, concurrent writes, and user-authored document preservation.
- [ ] Commit each coherent subsystem increment after its focused and affected tests pass.

### Task 4: Repair newly confirmed UI/runtime/tooling defects

**Files:**
- Potential source areas: `src/ui/*.tsx`, `src/screens/SettingsScreen.tsx`, `src/styles/*.css`, `src/preview/*.ts*`, `tools/*.py`, `tools/*.ps1`.
- Potential tests: matching unit tests and browser/preview audit scripts.

**Interfaces:**
- Consumes: confirmed runtime issues and the UI contracts in `PRODUCT.md` and `DESIGN.md`.
- Produces: accessible, runtime-verified UI/tooling behavior with no stale selectors, false-green audit exits, unsafe process termination, or leaked configuration.

- [ ] Reproduce browser issues in the preview or real runtime and capture console/network/DOM evidence where available.
- [ ] Add or extend behavior tests for state transitions before changing UI code.
- [ ] Keep keyboard focus, Escape handling, reduced-motion, theme, and long-text behavior covered.
- [ ] Run each affected audit script with its documented prerequisites and treat exit code 2 as indeterminate.
- [ ] Verify every process script filters by exact executable path and never terminates unrelated processes.
- [ ] Commit each independent repair after focused runtime and static verification.

### Task 5: Second full adversarial review after fixes

**Files:**
- Read: all tracked source, tests, tools, assets, and maintenance docs.
- Update: issue ledgers only for confirmed findings and their dispositions.

**Interfaces:**
- Consumes: all repair commits from Tasks 2–4.
- Produces: a fresh Hunter/Skeptic/Arbiter report and either additional repair tasks or evidence that no confirmed actionable bugs remain within the stated scope.

- [ ] Re-run the adversarial bug-hunt pipeline against the post-fix tree.
- [ ] Review all newly reported items with root-cause evidence, not just static suspicion.
- [ ] Add a regression test for every confirmed new defect, fix it, and update the relevant ledger row.
- [ ] Repeat the review until the full pass produces no confirmed actionable defects or an explicit external/environmental limit is documented.

### Task 6: Full verification, code review, and delivery record

**Files:**
- Update: `docs/FIX-LEDGER-2026-10-02.md`, `docs/KNOWN-LIMITS.md`, and a dated delivery/audit note if new findings or test counts require it.

**Interfaces:**
- Consumes: final source tree and all repair commits.
- Produces: fresh verification evidence, a five-axis code review, clean Git state, and a concise delivery report.

- [ ] Run `tsc --noEmit` and record exit code 0.
- [ ] Run `vitest run` and record the exact passing file/test counts.
- [ ] Run `cargo test --lib` and record the exact passing count.
- [ ] Run relevant preview, accessibility, contrast, style, CSS coverage, and packaging checks; report any unavailable prerequisite as indeterminate.
- [ ] Review the final diff for correctness, simplicity, architecture, security, performance, secrets, and unintended file changes.
- [ ] Confirm no unrelated process was stopped and no backend program was deleted.
- [ ] Commit documentation updates only after all verification commands are fresh and passing.

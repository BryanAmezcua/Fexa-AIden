# Spec mode — draft a planning doc from a Jira ticket

> **NOT YET IMPLEMENTED.** This file preserves conventions for the future `spec` mode so they don't decay. If a user invokes `/Fexa-AIden spec <TICKET-KEY>` today, the dispatcher should surface the "not implemented yet" message and stop. Do NOT attempt to fulfill the request by ad-libbing the pipeline below.

## What spec mode WILL do (when implemented)

Take a Jira ticket key, derive a structured planning doc from its description + AC + comments + Fexy-Zamo memory-bank context, write it to `specs/<TICKET-KEY>.md` at the Fexa-AIden repo root, and **stop**. The spec sheet is a planning artifact — it does not write code, branch, or test.

## Conventions to preserve

### Output path

- **Location**: `specs/<TICKET-KEY>.md` at the Fexa-AIden repo root (NOT inside the Fexy-Zamo repo — this is a deliberate change from the original Jira-Ticket skill, which wrote to `<Fexy-Zamo>/.claude-specs/`).
- **Filename**: exact ticket key as the user typed it — `TANGO-9.md`, `FIFI-12.md`, `FUN-3.md`.
- **Gitignored**: the `specs/` directory is in `.gitignore`. Spec sheets stay local on the operator's machine and are never committed to the Fexa-AIden GitHub repo.
- **Overwrite policy**: if `specs/<TICKET-KEY>.md` already exists, do NOT silently overwrite. Surface to the user that a prior spec exists and ask whether to overwrite, append a timestamped section, or abort.

### Memory bank required

Spec mode requires the Fexy-Zamo memory bank to be loaded BEFORE drafting:

- `projectbrief.md` — what Fexy-Zamo is, scope, what's active vs not active
- `productContext.md` — domain glossary, user roles, navigation, core flows, integrations
- `systemPatterns.md` — architecture, conventions, anti-patterns
- `techContext.md` — stack versions, gems, commands, CI/deploy, gotchas

Locations:

- **From Windows-side Claude Code** (Read tool): `\\wsl.localhost\Ubuntu-24.04\home\<user>\work\Fexy-Zamo\memory-bank\<file>.md`
- **From WSL Bash tool**: `~/work/Fexy-Zamo/memory-bank/<file>.md`

**If any file is missing or empty, stop.** Surface to the user that the bank needs to be regenerated before spec mode can run. Do not draft a spec from incomplete context.

The bank is used silently — synthesize from it, but don't quote files back to the user unless asked.

### Branch convention (referenced in the generated spec's "Suggested next steps")

When the generated spec sheet recommends how to start work, it should encode:

- **Branch name**: `<TICKET-KEY>` (e.g. `TANGO-9`, `FIFI-12`, `FUN-3`) — the ticket key itself, no prefix transformation
- **PR target**: `develop` (not `main`)

This convention also applies to `modes/qa.md`'s `branch:` metadata field.

### Trakref disambiguation

The product domain is **Fexy-Zamo** (enterprise facilities management). "Trakref" was a previous HVAC-specific repo at this company; in *this* codebase it appears only as one external integration. Don't apply HVAC-only assumptions to Fexy-Zamo tickets.

## Spec sheet structure (target shape)

The generated `specs/<TICKET-KEY>.md` should follow this section structure at minimum. Adjust based on ticket type (story vs bug vs spike), but cover all relevant sections.

```markdown
# <TICKET-KEY>: <summary>

- **Status**: <status>
- **Type**: <type>
- **Priority**: <priority>
- **Assignee**: <assignee>
- **Parent**: <parent key + summary, if any>
- **Source**: https://facilitiesexchange.atlassian.net/browse/<TICKET-KEY>

## Context

<2-3 sentences synthesizing what the ticket is fundamentally asking for, drawing on description + comments + memory-bank pattern knowledge. NOT a copy of the description — a summary in domain language.>

## Acceptance Criteria

<Verbatim text from the ticket, grouped by section heading (e.g. "Calculation", "Display", "Edge Cases"). Preserve the section + numeric ref. NO paraphrasing.>

## Open questions

<Gaps, ambiguities, conflicts with established Fexy-Zamo patterns. Flag anything in the AC that:
- Conflicts with systemPatterns.md or productContext.md
- Has ambiguous wording the implementer will need to resolve
- Depends on undocumented behavior elsewhere in the codebase
- Was clarified in comments — link the clarification>

## Approach

<Proposed implementation sketch:
- Files likely to be modified (model paths, Ext xtype files)
- Models / concerns / services involved
- Migration needs, if any
- State machine touches (if applicable — Fexy-Zamo uses the pattern heavily)
- Multi-tenancy considerations (Fexy-Zamo has deployment-level multi-tenancy)
- Integration points with existing patterns from systemPatterns.md>

## Test plan

<What scenarios need to be covered for `/Fexa-AIden qa <TICKET-KEY>` to verify the implementation:
- One row per AC clause + edges, mapping each to its AC ref
- Personas affected (admin / vendor / facility-manager)
- Seed needs (existing fixtures vs new ones)
- Specific Ext xtypes / screens to exercise>

## Suggested next steps

1. Create branch: `<TICKET-KEY>` (off `develop`)
2. <First concrete file or task to tackle, based on Approach>
3. <Second>
4. <…>
5. When code is ready, run `/Fexa-AIden qa <TICKET-KEY>` to generate the test suite + report
6. Open PR against `develop`
```

## Pipeline (target, when implemented)

1. **Load Fexy-Zamo memory bank** (all four files). Stop if any are missing.
2. **Fetch the ticket** via `scripts/jira-fetch.sh <TICKET>` (same path `brief` mode uses). Parse the JSON.
3. **Fetch attachments** if the AC references screenshots or specs (use `scripts/jira-attachments.sh` and `scripts/jira-download-attachment.sh`).
4. **Synthesize** the spec sheet per the structure above. Use the memory bank silently to translate ticket terms into domain language, identify pattern conflicts, and suggest realistic files to modify.
5. **Check for existing spec**. If `specs/<TICKET-KEY>.md` exists, ask the user how to proceed (overwrite / append-with-timestamp / abort).
6. **Write to `specs/<TICKET-KEY>.md`**.
7. **Report** to the user: path written + 3-bullet summary of what's in the spec + the count of open questions raised.
8. **STOP.** Don't auto-branch, auto-code, or auto-test. Wait for the user's next instruction.

## Hard rules

- **Memory bank required** — refuse to draft if any of the four files are missing or empty.
- **Memory bank silent** — used to inform spec content, not quoted verbatim back to the user.
- **Verbatim AC preserved** — no paraphrasing the acceptance criteria.
- **Wait for user instruction after writing** — never auto-code, auto-branch, or auto-test. The spec is a planning artifact; the user decides when and how to act on it.
- **Never overwrite an existing spec silently** — always surface and ask.
- **Never commit the spec file** — it's gitignored at the repo level, but also don't `git add` it under any circumstances.
- **Never print the Jira token** in any user-facing output.

## Implementation notes (for whoever builds this mode)

- Reuse `scripts/jira-fetch.sh` for the ticket fetch — identical to `brief` mode's call.
- The memory-bank loading logic is the same in `brief` mode — consider extracting to a shared helper (e.g. `scripts/load-memory-bank.sh`) when both modes are mature.
- The "verbatim AC" rule overlaps with `qa.md`'s AC constants — consider sharing a parsing helper that produces both the spec's Acceptance Criteria section and qa mode's `AC` constants from the same source.
- Deliberate divergence from the original Jira-Ticket skill: specs land in `Fexa-AIden/specs/`, not `Fexy-Zamo/.claude-specs/`. Rationale: specs travel with the skill, not the codebase being tested.
- `.gitignore` already includes `specs/` — don't need to add it at implementation time.

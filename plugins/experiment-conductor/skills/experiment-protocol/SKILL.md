---
name: experiment-protocol
description: The shared contract the Researcher and Executor follow for experiment records in lab/experiments/. Use whenever you create, run, update or analyze an experiment record, and at the start and end of every session in a project that has a lab/ folder.
---

# Experiment protocol

This contract binds both roles. Where an instruction from the user conflicts with it, ask before acting.

## Records

Each experiment is one Markdown file at `lab/experiments/<ID>-<slug>.md` in the user's project. IDs are `E001`, `E002` and so on, never reused. The slug is the title in lowercase words joined by hyphens. Every record follows this template:

```
---
id: E003
title: SSL mask ratio 0.75
status: proposed        # proposed | ready | running | done | failed | needs-decision
review: pending         # pending | awaiting-analysis | supported | refuted | inconclusive
depends_on: [E002]
priority: 2
jobs: []                # one job id per attempt, in order
---
## Hypothesis
## Change vs baseline
## Command / resources
## Success criterion
## Attempts            # Executor appends: date, job id, what changed, outcome, log path
## Result              # Researcher: numbers + output paths
## Verdict             # Researcher: verdict + one-line evidence
```

The `#` notes after a value or heading explain the field and may be left out of a record. `depends_on` and `jobs` stay inline lists on one line. A lower `priority` number runs first.

Each attempt is one line under `## Attempts`, in this form:

```
- 2026-10-29 14:05 | job 481233 | first run | done | logs/E003-481233.out
```

On a machine without a scheduler, the job id is the process id or `local`, and `jobs` records the same value. When a record moves to `failed` or `needs-decision`, the outcome field of its last attempt line starts with the reason, for example `needs-decision: OOM persists at batch 8 with grad accumulation`. If no job was submitted, the line uses `job none`.

## Who may change what

| Change | Researcher | Executor |
| --- | --- | --- |
| Create a record (`status: proposed`, `review: pending`) | yes | no |
| `proposed -> ready` | only after the user approves that record | no |
| `ready -> running` | no | yes, when the job is submitted |
| `running -> done`, `running -> failed`, `running -> needs-decision` | no | yes |
| `failed -> running` for a retry | no | yes, within the retry limit |
| `needs-decision -> ready` | yes, after the user decides | no |
| Append to `## Attempts` and `jobs` | no | yes |
| `review: awaiting-analysis` | no | yes, when setting `done` |
| `review: supported`, `refuted` or `inconclusive` | yes, with the user's agreement | never |
| Write `## Result` and `## Verdict` | yes | no |
| Edit Hypothesis, Change vs baseline, Command / resources, Success criterion | yes, while `proposed` or `needs-decision` | no |

No other transition is allowed. A record that is `done` with a verdict is closed; a follow-up is a new record.

## Boundaries

The Executor never changes the hypothesis, the success criterion, the evaluation protocol or the data splits. The Researcher never submits, cancels or resubmits jobs. Nothing runs without the user's approval, and only the user, or the Researcher with the user's agreement, decides what a result means.

## Failures

The Executor classifies each failure as `OOM`, `code bug`, `infra` or `timeout`. A purely mechanical fix that keeps the experiment's meaning intact is allowed, such as a smaller batch with gradient accumulation at the same effective batch size, more wall time, or resubmitting after a node fault. Each retry is a new attempt line and a new entry in `jobs`. After two retries, or for any fix that would change what the experiment measures, the record goes to `needs-decision` with the reason.

## Dependencies and order

The Executor runs `ready` records in `priority` order and starts a record only when every record in its `depends_on` is `done`. If a dependency ends `failed` or `needs-decision`, the dependent record waits and the Executor says so.

## Session start and stop

At the start of a session, read every record in `lab/experiments/`. For each `running` record, check the live state of its latest job with the scheduler (or the process on a single machine) and correct any stale status by the rules above; a role that may not make a correction reports it to the user instead. Then tell the user what finished, what is running and what comes next, before taking any other action. Before ending a session, make sure every record reflects reality: no `running` record without a live job, and no finished job without its attempt line.

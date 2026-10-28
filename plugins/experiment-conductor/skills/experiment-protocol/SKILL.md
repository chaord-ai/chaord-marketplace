---
name: experiment-protocol
description: The shared contract the Researcher and Executor follow for experiment batches and records under lab/, and for the git rules around them. Use whenever you create, run, update or analyze an experiment record or batch, and at the start and end of every session in a project that has a lab/ folder.
---

# Experiment protocol

This contract binds both roles. Where an instruction from the user conflicts with it, ask before acting.

## Batches

One batch is one folder and one branch. The folder is `lab/<YYYY-MM-DD>-<batch-slug>/` in the user's project, and the branch is `exp/<YYYY-MM-DD>-<batch-slug>` with the same date and slug. The date is the day of the proposal, and the slug is a few lowercase words joined by hyphens.

The Researcher creates the batch at proposal time. From an up-to-date `main`, the Researcher creates the branch (`git switch -c exp/<YYYY-MM-DD>-<batch-slug> main`), then writes the folder with its `README.md` and one record per experiment, and commits them on that branch. Both roles then work only on the batch branch. The Executor switches to it before running anything.

The batch `README.md` starts as the plan. At proposal it holds the decision the batch serves, the experiments with their dependencies and priorities, and the resources they need. After analysis the Researcher completes the same file as the report, with these sections in order: TL;DR, What was tested, Results (a table of each experiment against its success criterion), Verdicts with evidence, Surprises and defects, Open questions, Next experiments. There is no other report folder.

## Records

Each experiment is one Markdown file `E<NNN>-<slug>.md` in its batch folder. IDs are `E001`, `E002` and so on, numbered across all batches and never reused. To pick the next ID, scan every batch folder under `lab/`, and the `lab/` folder of every unmerged `exp/` branch (`git ls-tree -r --name-only <branch> lab/`), for the highest ID. A follow-up to an earlier batch is a new record in the new batch and names the earlier ID in `depends_on` or in its hypothesis. The slug is the title in lowercase words joined by hyphens. Every record follows this template:

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
## Attempts            # Executor appends one line per attempt
## Result              # Researcher: numbers + output paths
## Verdict             # Researcher: verdict + one-line evidence
```

The `#` notes after a value or heading explain the field and may be left out of a record. Write `depends_on` and `jobs` as inline lists on one line. A lower `priority` number runs first.

Each attempt is one line under `## Attempts`, in this form:

```
- 2026-10-29 14:05 | commit 3f2a1bc | job 481233 | run runs/E003/2 | provenance runs/E003/2/provenance.json | batch 8 with grad accumulation 4 | done | logs/E003-481233.out
```

The fields are the date and time, the commit SHA the job ran, the job id, the run directory, the path to the run's provenance file, what changed from the previous attempt (`first run` for the first), the outcome, and the log path. On a machine without a scheduler, the job id is the process id or `local`, and `jobs` records the same value. When a record moves to `failed` or `needs-decision`, the outcome starts with the reason, for example `needs-decision: OOM persists at batch 8 with grad accumulation`. If no job was submitted, the line uses `job none`.

Every run has a provenance file. When the project writes its own, the attempt line points to it. Otherwise the Executor writes `provenance.json` in the run directory, holding the commit SHA, whether the working tree had uncommitted changes, `submit_host`, `node`, the job id, the command and the start time. The Executor writes `submit_host` at submission, and it names the machine the job was submitted from. The Executor fills in `node` from the scheduler when it records the attempt's outcome, since only the scheduler knows which node ran the job. The job id is stored as the bare id the scheduler accepts back, never the message the submit command prints. Where run outputs live, and whether they are committed, is the project's choice; the record only names their paths.

## Git

The project must be a git repository, and the batch folders under `lab/` are committed. Agents commit only on the batch branch and never commit, push or merge on `main`. A hook in this plugin blocks those commands on `main` and any push that targets `main`. Merging a batch into `main` is the user's action; the Researcher may propose a merge in the report and does nothing more.

Before submitting a job, the Executor commits the code and configs the job uses, and the attempt line records the SHA of that commit. With uncommitted changes in the working tree the Executor refuses to run unless the user explicitly allows it. In that case the Executor saves `git diff HEAD` as `uncommitted.diff` in the run directory and writes the commit field as `commit 3f2a1bc + runs/E003/2/uncommitted.diff`.

Commit messages start with `[exp] <ID> propose`, `[exp] <ID> attempt N` or `[exp] <ID> verdict: <verdict>`. A proposal of several records names the range, as in `[exp] E003-E006 propose`, and the batch report uses `[exp] <YYYY-MM-DD>-<batch-slug> report`. A message that records a result or a verdict states what was tested, the key numbers and the interpretation, including negative results and confounds.

## Who may change what

| Change | Researcher | Executor |
| --- | --- | --- |
| Create a batch (branch, folder, `README.md`) and its records (`status: proposed`, `review: pending`) | yes | no |
| `proposed -> ready` | only after the user approves that record | no |
| `ready -> running` | no | yes, when the job is submitted |
| `running -> done`, `running -> failed`, `running -> needs-decision` | no | yes |
| `failed -> running` for a retry | no | yes, within the retry limit |
| `needs-decision -> ready`, `needs-decision -> done` or `needs-decision -> failed` | yes, after the user decides, writing the decision and its reason under `## Verdict`, and for `done` or `failed` setting `review` to `supported`, `refuted` or `inconclusive` | no |
| Append to `## Attempts` and `jobs` | no | yes |
| `review: awaiting-analysis` | no | yes, when setting `done` |
| `review: supported`, `refuted` or `inconclusive` | yes, with the user's agreement | never |
| Write `## Result`, `## Verdict` and the report in `README.md` | yes | no |
| Edit Hypothesis, Change vs baseline, Command / resources, Success criterion | yes, while `proposed` or `needs-decision` | no |

No other transition is allowed. A record is closed when its `review` holds a verdict and its status is `done`, or `failed` after the user decided to stop it through `needs-decision -> failed`. A `failed` record without a verdict is still open, since the Executor either retries it or moves it to `needs-decision`. A follow-up to a closed record is a new record.

## Boundaries

The Executor never changes the hypothesis, the success criterion, the evaluation protocol or the data splits. The Researcher never submits, cancels or resubmits jobs. Nothing runs without the user's approval, and only the user, or the Researcher with the user's agreement, decides what a result means.

Both roles stay inside the project directory and the scheduler's own logs. Never search the filesystem outside them, for example with `find /`, since a cluster login node is shared with other users.

## Failures

The Executor classifies each failure as `OOM`, `code bug`, `infra` or `timeout`. A purely mechanical fix that keeps the experiment's meaning intact is allowed, such as a smaller batch with gradient accumulation at the same effective batch size, more wall time, or resubmitting after a node fault. Each retry is a new attempt line and a new entry in `jobs`. After two retries, or for any fix that would change what the experiment measures, the record goes to `needs-decision` with the reason.

Shared filesystems such as NFS can show a job's outputs a few seconds after the scheduler reports it finished. If expected outputs are missing right after a job ends, recheck three times over about 30 seconds before classifying it as a failure.

## Dependencies and order

The Executor runs `ready` records in `priority` order and starts a record only when every record in its `depends_on` is `done`. If a dependency ends `failed` or `needs-decision`, the dependent record waits and the Executor says so. The Executor handles each job the moment it ends, without waiting for the rest of the batch. It updates that record, retries a mechanical failure, and submits every record whose dependencies have just become `done`.

## Session start and stop

At the start of a session, follow these steps in order.

1. Switch to the batch branch you are working on. If the session starts on `main` while `exp/*` branches exist, the session-start summary names them.
2. Read every record under `lab/`, and for each `running` record check the live state of its latest job with the scheduler (or the process on a single machine). Change nothing yet.
3. Make your first message to the user the status report: what finished, what is running, what comes next, and every stale status you found with the correction you will make.
4. Only then correct stale statuses by the rules above and continue. A role that may not make a correction leaves it to the user.

Before ending a session, make sure every record reflects reality, with no `running` record without a live job and no finished job without its attempt line, and commit the records.

At the end of each session or batch, the Executor reports in the conversation what finished, what failed and why, what is still running, and what needs a decision. After analysis, the Researcher completes the batch `README.md` as the report, commits it, and gives the user the TL;DR in the conversation.

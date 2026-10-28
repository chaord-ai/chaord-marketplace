# experiment-conductor

experiment-conductor splits experimentation into two roles. The Researcher discusses direction with you, designs experiments with clear hypotheses and success criteria, and analyzes results. The Executor runs approved experiments on your cluster and records every attempt. Both follow one shared protocol and keep one Markdown file per experiment in your project. Any new session can see what finished, what is running and what comes next, and a pane shows you the same state at a glance. Nothing to install beyond the plugin: no database, no daemon.

## Install

At the prompt of a Claude Code session, add the marketplace and install the plugin:

```
/plugin marketplace add chaord-ai/chaord-marketplace
/plugin install experiment-conductor@chaord-marketplace
```

From a shell, the same two steps are:

```
claude plugin marketplace add chaord-ai/chaord-marketplace
claude plugin install experiment-conductor@chaord-marketplace
```

## Start each role

Run each role in its own session, from the root of your project:

```
claude --agent experiment-conductor:researcher
claude --agent experiment-conductor:executor
```

A typical loop starts with the Researcher, who proposes a batch of experiments and waits for your approval. Once you approve, the records become `ready`, and the Executor session submits them, monitors the jobs and records each attempt. When jobs finish, the Researcher analyzes them against their success criteria and writes verdicts with your agreement. Either session can end at any time, because the next one starts from the records and the live job state rather than from conversation history.

The protocol works the same on a single GPU machine without a scheduler. In that case the Executor runs plain processes and records their process ids as job ids.

## Records

Each experiment is one file at `lab/experiments/<ID>-<slug>.md` in your project, with IDs `E001`, `E002` and so on:

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

The `experiment-protocol` skill defines who may change each field, how failures and retries are handled, and how sessions start and end. Because the records are plain Markdown, you can read and edit them yourself and keep them in git with the rest of the project.

When a session starts in a project that has `lab/experiments/`, the plugin adds a short summary to the session's context with the count of records per status, the running records with their job ids, the records awaiting analysis and the records that need a decision.

## The pane

The experiments pane lists every record with its ID, title, status, review, attempt count, latest job id and, for failed or `needs-decision` records, the reason. Records that need you are marked with `!` and highlighted. The pane rereads `lab/experiments/` every 15 seconds and opens by itself when the terminal is wide enough. Type `/experiments` to open it at any width.

The `showPane` option, on by default, controls the pane. Turn it off in `/config`, or at install time with `claude plugin install experiment-conductor@chaord-marketplace --config showPane=false`. The session-start summary stays on either way.

## Limits

experiment-conductor is not autonomous research. Nothing runs without your approval, and only you, or the Researcher with your agreement, decide what a result means. The plugin is not a job scheduler either: the Executor uses the scheduler you already have, such as SLURM, or plain processes on one machine. The pane shows the status written in the records, and live job state is checked by the Executor at the start of each session.

## License

This plugin is licensed under the [MIT License](./LICENSE).

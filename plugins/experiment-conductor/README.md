# Experiment Conductor

Experiment Conductor splits experimentation into two roles. The Researcher discusses direction with you, designs experiments with clear hypotheses and success criteria, and analyzes results. The Executor runs approved experiments on your cluster and records every attempt. Both follow one shared protocol and keep one Markdown file per experiment in your project, grouped in batches that each live on their own git branch. Any new session can see what finished, what is running and what comes next, and a pane shows you the same state at a glance. Nothing needs installing beyond the plugin, with no database and no daemon.

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

A typical loop starts with the Researcher, who creates a batch branch from `main`, writes the batch plan and its records, and waits for your approval. Once you approve, the records become `ready`, and the Executor session switches to the batch branch, commits the code each job uses, submits the jobs, monitors them and records each attempt. When jobs finish, the Researcher analyzes them against their success criteria, writes verdicts with your agreement, and completes the batch report. You decide whether to merge the batch into `main`. Either session can end at any time, because the next one starts from the records and the live job state rather than from conversation history.

The protocol works the same on a single GPU machine without a scheduler. In that case the Executor runs plain processes and records their process ids as job ids.

## Batches and records

Each batch is a folder `lab/<YYYY-MM-DD>-<batch-slug>/` in your project, worked on in the branch `exp/<YYYY-MM-DD>-<batch-slug>`. The folder holds a `README.md` that starts as the batch plan and ends as its report, and one record per experiment. Experiment IDs run `E001`, `E002` and so on across all batches, so a follow-up in a later batch can name an earlier experiment. Each record looks like this:

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

Every attempt line names the commit SHA the job ran, the job id, the run directory and the run's provenance file, so any finished result can be traced back to the code that produced it. The `experiment-protocol` skill defines the attempt line, who may change each field, how failures and retries are handled, and how sessions start and end. Because the records are plain Markdown, you can read and edit them yourself.

When a session starts in a project that has `lab/`, the plugin adds a short summary to the session's context. The summary counts records per status and, for each batch with its branch, lists the running records with their job ids, the records awaiting analysis, the failed records and the records that need a decision. Records whose front matter cannot be read are named so you can fix them. When the session is on `main` and local `exp/*` branches exist, the summary also names them so the agent switches to its batch branch first.

## Git rules

The project must be a git repository, and the batch folders are committed with the rest of the project. The Executor commits code and configs before each submission and will not run with uncommitted changes unless you allow it, in which case it saves the diff next to the run. Commit messages start with `[exp] <ID> propose`, `[exp] <ID> attempt N` or `[exp] <ID> verdict: <verdict>`, and messages that record results state what was tested, the key numbers and their interpretation.

Agents never commit, push or merge on `main`. A hook enforces this rule in the Researcher and Executor sessions and in subagents of those types. The hook blocks `git commit`, `git merge` and `git push` while the repository is on `main` or `master`, and any `git push` that targets `main` or `master` from any branch, and tells the agent to switch to the batch branch. The guard also covers branch switches to `main` or `master`, the other commands that write `main` (`cherry-pick`, `rebase`, `am`, `revert`, `reset`, `pull`, `update-ref` and `branch -f`), and commands chained with `&&`, `;`, backticks or `$(`. It is a guardrail on the agents' shell commands rather than a security boundary. Sessions started without either agent are not affected, so you can still merge a batch yourself. The hook runs in POSIX sh and awk on the machine where Claude Code runs, including a cluster login node.

## The pane

The experiments pane lists the records grouped by batch, with each batch's branch. For every record the pane shows its ID, title, status, review, attempt count, latest job id and, for failed or `needs-decision` records, the reason. Records that need you are marked with `!` and highlighted, as are records whose front matter cannot be read. The pane rereads `lab/` every 15 seconds and opens by itself when the terminal is wide enough. Type `/experiments` to open it at any width.

The `showPane` option, on by default, controls the pane. Turn it off in `/config`, or at install time with `claude plugin install experiment-conductor@chaord-marketplace --config showPane=false`. The session-start summary and the branch hook stay on either way.

## Demo

The script `demo/run-demo.sh` shows both roles working together without any typing. Run it with the name of a SLURM partition, from any directory. Before the talk, trust the base folder once by starting `claude` in `~/ec-demo` and accepting the trust dialog. Every scratch repository is created inside that folder, so the sessions start without a dialog.

```
sh demo/run-demo.sh <partition>
sh demo/run-demo.sh -l /path/to/chaord-marketplace/plugins/experiment-conductor <partition>
sh demo/run-demo.sh -b /path/to/base -m auto <partition>
```

The first form uses the plugin installed from the marketplace. The second loads a local checkout through `--plugin-dir`. The script creates a fresh scratch git repository under the base folder with one commit on `main`, so each run is independent and no existing project is touched. It then opens a tmux session in that repository with two panes stacked vertically, the Researcher on top and the Executor below. Each pane runs `claude --name <name> --agent experiment-conductor:<role>` with its first prompt already submitted. The `-b BASE` option replaces the default base folder `~/ec-demo`, and its path and the `-l` path must not contain a double quote, a dollar sign or a backtick. The `-m MODE` option passes `--permission-mode MODE` to both sessions, and without it no such flag is passed. The `-d` option creates the session without attaching to it.

Auto permission mode suits the demo, because the sessions need to send messages, run git and use the scheduler, and the cluster tests of the plugin ran in that mode. In other modes the presenter may need to approve tool prompts during the talk.

The Researcher prompt asks for a dry-run batch of 5 dummy experiments on your partition, with E003 depending on E002 and E004 failing every time. The prompt also states that you approve every record in this batch, so the Researcher can mark each one ready. The two sessions are named after the run, and each prompt gives the name of the other session. The Researcher writes the batch, marks the records ready and messages the Executor session. The Executor runs the jobs and messages the Researcher session each time an experiment is ready for analysis and when the batch is finished. The Researcher analyzes each experiment and writes the batch report. These messages use Claude Code's [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md), which needs Claude Code v2.1.224 or later.

In the experiments pane, the audience sees the five records move from `proposed` to `ready`, then through `running` and `done`, with the review field passing `awaiting-analysis` before a verdict. E003 waits for E002, and E004 shows the failure path with its reason. Messages between the sessions appear as one-line previews in each pane. The tmux session needs a terminal wide enough for the experiments pane to open by itself, and `/experiments` opens it at any width.

## Limits

Experiment Conductor is not autonomous research. Nothing runs without your approval, and only you, or the Researcher with your agreement, decide what a result means. The plugin is not a job scheduler either, because the Executor uses the scheduler you already have, such as SLURM, or plain processes on one machine. The pane shows the status written in the records, and live job state is checked by the Executor at the start of each session. Merging a batch into `main` is always your action.

## License

This plugin is licensed under the [MIT License](./LICENSE).

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

## Limits

Experiment Conductor is not autonomous research. Nothing runs without your approval, and only you, or the Researcher with your agreement, decide what a result means. The plugin is not a job scheduler either, because the Executor uses the scheduler you already have, such as SLURM, or plain processes on one machine. The pane shows the status written in the records, and live job state is checked by the Executor at the start of each session. Merging a batch into `main` is always your action.

## Acceptance run

The script `tests/acceptance/run.sh` runs both roles headless through one fixed batch in a new scratch git repository and checks the result. The Researcher proposes and approves the batch, an Executor runs it and is stopped mid-batch, a second Executor resumes, and the Researcher writes the report. The batch holds a dependency, a job that fails by design and a job that times out once. An agent is then asked to commit on `main`. The script checks the attempt lines, `jobs`, the dependency order, the retry, the report sections and the branch guard, prints a pass or fail table, and exits non-zero when any check fails. The scratch repository and the agent transcripts stay in place for inspection.

Run it from a shell where `claude` is logged in, on a SLURM login node with a partition or on any machine with `--local`:

```
sh tests/acceptance/run.sh --partition gpu --model sonnet
sh tests/acceptance/run.sh --local --model sonnet
```

A local run with Sonnet takes about four minutes. On SLURM the run also waits for the queue, and the work directory must be on a filesystem the compute nodes can read.

## License

This plugin is licensed under the [MIT License](./LICENSE).

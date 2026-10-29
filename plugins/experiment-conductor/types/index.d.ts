// One line under `## Attempts`, split into its fields, each without its
// leading word (`job`, `commit`, `run`, `provenance`).
export type Attempt = {
  date: string
  time: string
  commit: string
  job: string
  run: string
  provenance: string
  change: string
  outcome: string
  log: string
}

export type ExperimentRow = {
  id: string
  title: string
  status: string
  review: string
  attempts: number
  latestJob: string
  reason: string
  // False when the front matter is missing, unclosed or has no id or status.
  isValid: boolean
  // The text under each heading, its lines joined with spaces.
  hypothesis: string
  success: string
  verdict: string
  attemptList: Attempt[]
}

// One folder lab/<batch>/ on branch exp/<batch>.
export type Batch = { name: string; branch: string; rows: ExperimentRow[] }

export type LabView = { hasLab: boolean; batches: Batch[] }

// What the scheduler (`sacct`) or, on a single machine, the process table
// last said about one job: the state in upper case (`RUNNING`, `COMPLETED`,
// `FAILED`, or `ENDED` for a process that is gone) and, from `sacct`, the
// exit code as `code:signal`.
export type JobState = { source: 'slurm' | 'process'; state: string; exitCode: string }

// Job id to its last known state. Jobs no query has answered are absent.
export type JobStates = Record<string, JobState>

declare module 'claude-code' {
  interface PluginState {
    'experiment-conductor': {
      lab: Shaped<LabView>
      jobs: Shaped<JobStates>
      // The rows shown expanded, as `<batch>/<id>`: this session's view only.
      expanded: Shaped<string[]>
    }
  }
}

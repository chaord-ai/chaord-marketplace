import type { ExperimentRow, JobState, JobStates, LabView } from '../types'
import { needsAttention } from './parse'

// The text of every pane line. Change this file to show other fields: each
// function takes a parsed record (hooks/parse.ts) and the scheduler's job
// states (hooks/scheduler.ts) and returns plain strings.

const VERDICTS = ['supported', 'refuted', 'inconclusive']

// SLURM states in which a job has certainly finished. Any other state, or
// none, leaves the row unflagged.
const TERMINAL = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'OUT_OF_MEMORY',
  'NODE_FAIL',
  'PREEMPTED',
  'BOOT_FAIL',
  'DEADLINE',
])

const NAME_WIDTH = 30
const STATUS_WIDTH = 10
const LABEL_WIDTH = 13
const INDENT = '    '

function hasVerdict(row: ExperimentRow): boolean {
  return VERDICTS.includes(row.review)
}

function latestState(row: ExperimentRow, jobs: JobStates): JobState | undefined {
  return row.latestJob === '' ? undefined : jobs[row.latestJob]
}

// A running record whose latest job the scheduler reports finished.
export function isStale(row: ExperimentRow, jobs: JobStates): boolean {
  const state = latestState(row, jobs)
  if (row.status !== 'running' || state === undefined) return false
  return state.source === 'process' ? state.state === 'ENDED' : TERMINAL.has(state.state)
}

function schedulerState(state: JobState): string {
  if (state.source === 'slurm') return `SLURM ${state.state}`
  return state.state === 'RUNNING' ? 'process running' : 'process ended'
}

// The outcome of one finished or running job, as `FAILED 1:0`.
function jobOutcome(state: JobState): string {
  if (state.source === 'process') return schedulerState(state)
  return state.exitCode === '' ? state.state : `${state.state} ${state.exitCode}`
}

// The reason an attempt outcome gives, without its leading status.
function reasonText(outcome: string): string {
  return outcome.replace(/^(failed|needs-decision)\s*:\s*/, '')
}

// The one plain-language fact a collapsed row shows after its status.
export function nextFact(row: ExperimentRow, jobs: JobStates): string {
  if (!row.isValid) return 'front matter unreadable'
  const state = latestState(row, jobs)
  switch (row.status) {
    case 'proposed':
      return 'awaiting your approval'
    case 'ready':
      return 'waiting to run'
    case 'running': {
      const job = row.latestJob === '' ? 'no job recorded' : `job ${row.latestJob}`
      if (state === undefined) return job
      if (isStale(row, jobs)) return `${schedulerState(state)} · record not updated`
      return `${schedulerState(state)} · ${job}`
    }
    case 'done':
      if (hasVerdict(row)) return row.review
      return row.review === 'awaiting-analysis' ? 'awaiting analysis' : `review ${row.review}`
    case 'failed':
    case 'needs-decision': {
      if (hasVerdict(row)) return row.review
      const reason = reasonText(row.reason)
      const kind = reason.split(',')[0]?.trim() ?? ''
      const exit = state?.exitCode.split(':')[0] ?? ''
      if (exit !== '' && exit !== '0' && kind !== '') return `exit ${exit} (${kind})`
      return reason === '' ? 'no reason recorded' : reason
    }
    default:
      return ''
  }
}

function statusWord(row: ExperimentRow): string {
  return row.isValid ? row.status.replace(/-/g, ' ') : 'unreadable'
}

function name(row: ExperimentRow): string {
  const text = `${row.id} ${row.title}`
  return text.length > NAME_WIDTH - 2 ? `${text.slice(0, NAME_WIDTH - 5)}...` : text
}

// One experiment's line: attention mark, expand marker, ID and title, status
// and, while collapsed, the next fact.
export function rowLine(row: ExperimentRow, jobs: JobStates, isOpen: boolean): string {
  const mark = needsAttention(row) ? '!' : ' '
  const arrow = isOpen ? '▾' : '▸'
  const status = statusWord(row)
  const fact = isOpen ? '' : nextFact(row, jobs)
  let tail = status
  if (fact !== '') {
    tail = status.length < STATUS_WIDTH ? status.padEnd(STATUS_WIDTH) + fact : `${status} · ${fact}`
  }
  return `${mark} ${arrow} ${name(row).padEnd(NAME_WIDTH)}${tail}`.trimEnd()
}

export function waitingOn(row: ExperimentRow, jobs: JobStates): string {
  if (!row.isValid) return 'a fix to its front matter'
  switch (row.status) {
    case 'proposed':
      return 'your approval (the Researcher then marks it ready)'
    case 'ready':
      return 'the Executor to submit it'
    case 'running':
      return isStale(row, jobs) ? 'the Executor to record the outcome' : 'the job to finish'
    case 'done':
      if (hasVerdict(row)) return 'nothing, the experiment is closed'
      return 'analysis (the Researcher, with your agreement)'
    case 'failed':
      if (hasVerdict(row)) return 'nothing, the experiment is closed'
      return 'the Executor to retry it or ask for your decision'
    case 'needs-decision':
      return 'your decision (Researcher can close it as done or failed)'
    default:
      return 'nothing known'
  }
}

// The lines under an expanded row, each labelled in a fixed column.
export function detailLines(row: ExperimentRow, jobs: JobStates): string[] {
  const line = (label: string, value: string) => `${INDENT}${label.padEnd(LABEL_WIDTH)}${value}`
  const under = ' '.repeat(INDENT.length + LABEL_WIDTH + 4)
  const lines = [
    line('Hypothesis', row.hypothesis === '' ? 'not written' : row.hypothesis),
    line('Success', row.success === '' ? 'not written' : row.success),
  ]
  if (row.attemptList.length === 0) lines.push(line('Attempts', 'none yet'))
  row.attemptList.forEach((attempt, i) => {
    const state = attempt.job === '' ? undefined : jobs[attempt.job]
    const parts = [
      `#${i + 1}`,
      attempt.time,
      `job ${attempt.job}`,
      `commit ${attempt.commit}`,
      state === undefined ? '' : jobOutcome(state),
    ].filter(part => part !== '' && part !== 'job ' && part !== 'commit ')
    const text = parts.join('  ')
    lines.push(i === 0 ? line('Attempts', text) : `${INDENT}${' '.repeat(LABEL_WIDTH)}${text}`)
    if (attempt.outcome !== '') lines.push(`${under}${attempt.outcome}`)
  })
  const latest = row.attemptList[row.attemptList.length - 1]
  if (latest !== undefined && (latest.run !== '' || latest.log !== '')) {
    const run = [latest.run, latest.log === '' ? '' : `log ${latest.log}`].filter(p => p !== '')
    lines.push(line('Run', run.join('   ')))
  }
  if (hasVerdict(row) || row.verdict !== '') {
    const verdict = [hasVerdict(row) ? row.review : '', row.verdict].filter(p => p !== '')
    lines.push(line('Verdict', verdict.join(' · ')))
  }
  lines.push(line('Waiting on', waitingOn(row, jobs)))
  return lines
}

// The header: the count, how many need the user and, for a single batch, its
// branch at the right edge. Several batches each get a branch line instead.
export function headerLine(view: LabView, columns: number): string {
  const rows = view.batches.flatMap(batch => batch.rows)
  const waiting = rows.filter(needsAttention).length
  const count = `${rows.length} ${rows.length === 1 ? 'experiment' : 'experiments'}`
  const left = `${count} · ${waiting} need${waiting === 1 ? 's' : ''} you`
  const only = view.batches.length === 1 ? view.batches[0] : undefined
  if (only === undefined) return left
  const gap = Math.max(2, columns - left.length - only.branch.length)
  return `${left}${' '.repeat(gap)}${only.branch}`
}

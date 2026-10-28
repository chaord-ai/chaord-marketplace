import type { EngineInterface } from 'claude-code'

import type { JobStates, LabView } from '../types'

const QUERY_TIMEOUT_MS = 10000

// A SLURM job id (`62940`, an array task `62940_3`) or a process id. The
// placeholders `local` and `none` name no job to ask about.
function isJobId(job: string): boolean {
  return /^\d+(_\d+)?$/.test(job)
}

// The jobs worth asking about: the latest job of every running record and of
// every open failed or needs-decision record (its exit code gives the row its
// reason), and every attempt's job of the rows shown expanded (`<batch>/<id>`).
export function jobsToQuery(view: LabView, expanded: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const batch of view.batches) {
    for (const row of batch.rows) {
      const isOpenFailure =
        (row.status === 'failed' || row.status === 'needs-decision') &&
        !['supported', 'refuted', 'inconclusive'].includes(row.review)
      if ((row.status === 'running' || isOpenFailure) && isJobId(row.latestJob)) {
        ids.add(row.latestJob)
      }
      if (expanded.includes(`${batch.name}/${row.id}`)) {
        for (const attempt of row.attemptList) if (isJobId(attempt.job)) ids.add(attempt.job)
      }
    }
  }
  return [...ids].sort()
}

// Asks SLURM's accounting (`sacct`) about the jobs, read-only. One line per
// job: `62940|RUNNING|0:0`. A state such as `CANCELLED by 1000` keeps its
// first word. Undefined when sacct is missing or fails.
async function askSlurm($: EngineInterface, ids: string[]): Promise<JobStates | undefined> {
  try {
    const result = await $.process.run(
      ['sacct', '-X', '-n', '-P', '-o', 'JobID,State,ExitCode', '-j', ids.join(',')],
      { timeoutMs: QUERY_TIMEOUT_MS },
    )
    if (result.exitCode !== 0) return undefined
    const states: JobStates = {}
    for (const line of result.stdout.split('\n')) {
      const [id = '', state = '', exitCode = ''] = line.trim().split('|')
      if (id === '' || !ids.includes(id)) continue
      states[id] = {
        source: 'slurm',
        state: (state.split(/\s+/)[0] ?? '').toUpperCase(),
        exitCode: exitCode.trim(),
      }
    }
    return states
  } catch {
    return undefined
  }
}

// On a single machine the job id is the process id: `ps` lists the ones
// still alive. Undefined when ps cannot run.
async function askProcesses($: EngineInterface, ids: string[]): Promise<JobStates | undefined> {
  const pids = ids.filter(id => /^\d+$/.test(id))
  if (pids.length === 0) return undefined
  try {
    const result = await $.process.run(['ps', '-o', 'pid=', '-p', pids.join(',')], {
      timeoutMs: QUERY_TIMEOUT_MS,
    })
    // ps exits 1 when none of the processes is alive, and 0 when some are.
    if (result.exitCode > 1) return undefined
    const alive = new Set(result.stdout.split(/\s+/).filter(pid => pid !== ''))
    const states: JobStates = {}
    for (const pid of pids) {
      states[pid] = { source: 'process', state: alive.has(pid) ? 'RUNNING' : 'ENDED', exitCode: '' }
    }
    return states
  } catch {
    return undefined
  }
}

// The live state of each job: from sacct where SLURM answers, else from the
// process table. An empty result means the pane shows the records' status
// alone. Never throws and never writes anything.
export async function queryJobs($: EngineInterface, ids: string[]): Promise<JobStates> {
  if (ids.length === 0) return {}
  return (await askSlurm($, ids)) ?? (await askProcesses($, ids)) ?? {}
}

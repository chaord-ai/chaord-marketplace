import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Batch, ExperimentRow, JobStates, LabView } from '../types'
import { needsAttention, parseRecord } from './parse'
import { detailLines, headerLine, isStale, rowLine } from './rows'
import { jobsToQuery, queryJobs } from './scheduler'

const PANE = 'experiments'
const TITLE = 'Experiments'
const LAB = 'lab'
const REFRESH_MS = 15000
const SCHEDULER_MS = 60000

// Change the tag when LabView's fields change: an older stored value is then
// read as the initial value instead of a wrong shape.
const lab = atom(
  { plugin: 'experiment-conductor', key: 'lab' } as const,
  { hasLab: false, batches: [] } as LabView,
  { shape: 'lab-3' },
)

// What sacct or the process table last said about each job worth asking
// about. Empty when neither answers: the rows then show the records alone.
const jobs = atom(
  { plugin: 'experiment-conductor', key: 'jobs' } as const,
  {} as JobStates,
  { shape: 'jobs-1' },
)

// The rows shown expanded, as `<batch>/<id>`. Session view state only.
const expanded = atom(
  { plugin: 'experiment-conductor', key: 'expanded' } as const,
  [] as string[],
  { shape: 'expanded-1' },
)

// Each folder lab/<batch>/ is one batch on branch exp/<batch>; every Markdown
// file in it except README.md is a record.
async function scan($: EngineInterface): Promise<LabView> {
  if (!(await $.fs.exists(LAB))) return { hasLab: false, batches: [] }
  const folders = (await $.fs.list(LAB))
    .filter(entry => entry.kind === 'dir')
    .map(entry => entry.name)
    .sort()
  const batches: Batch[] = []
  for (const name of folders) {
    const dir = `${LAB}/${name}`
    const files = (await $.fs.list(dir).catch(() => []))
      .filter(
        entry =>
          entry.kind === 'file' && entry.name.endsWith('.md') && entry.name !== 'README.md',
      )
      .map(entry => entry.name)
      .sort()
    const rows: ExperimentRow[] = []
    for (const file of files) {
      try {
        rows.push(parseRecord(file, await $.fs.read(`${dir}/${file}`)))
      } catch {
        // A record removed or unreadable mid-scan is shown at the next refresh.
      }
    }
    if (rows.length > 0) batches.push({ name, branch: `exp/${name}`, rows })
  }
  return { hasLab: true, batches }
}

// Module state starts over on a reload, which only costs one redundant write
// or query.
let last = ''
let lastJobs = ''
let isOpened = false
let isQuerying = false
let isFollowUp = false

async function refresh($: EngineInterface): Promise<void> {
  const view = await scan($).catch((): LabView => ({ hasLab: false, batches: [] }))
  const text = JSON.stringify(view)
  if (text !== last) {
    last = text
    await update($, lab, () => view)
  }
  if (view.hasLab && !isOpened) {
    isOpened = true
    void $.ui.open({ id: PANE, title: TITLE })
  }
}

// Asks the scheduler, read-only, about the jobs the pane shows. One query at
// a time; a failure leaves the rows with the records' status alone. A row
// expanded during a query queues one more query for when this one ends.
async function refreshJobs($: EngineInterface, isRequested = false): Promise<void> {
  if (isQuerying) {
    if (isRequested) isFollowUp = true
    return
  }
  isQuerying = true
  try {
    const ids = jobsToQuery(await read($, lab), await read($, expanded))
    const states = await queryJobs($, ids).catch((): JobStates => ({}))
    const text = JSON.stringify(states)
    if (text !== lastJobs) {
      lastJobs = text
      await update($, jobs, () => states)
    }
  } finally {
    isQuerying = false
  }
  if (isFollowUp) {
    isFollowUp = false
    await refreshJobs($)
  }
}

async function toggle($: EngineInterface, key: string): Promise<void> {
  await update($, expanded, list =>
    list.includes(key) ? list.filter(one => one !== key) : [...list, key],
  )
  await refreshJobs($, true)
}

export const register: Register = (on, options) => {
  if (options.showPane === false) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'experiments',
      description: 'Show the experiments in lab/ in a pane, grouped by batch',
    })
    await refresh($)
    await refreshJobs($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    $.clock.every(SCHEDULER_MS, () => void refreshJobs($))
    return result
  })

  on('command.run', { command: 'experiments' }, async $ => {
    await refresh($)
    await refreshJobs($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Experiments pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, lab)
    if (!view.hasLab) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No lab/ folder in this project.</Text>
        </Box>
      )
    }
    const states = await read($, jobs)
    const open = await read($, expanded)
    const isSeveral = view.batches.length > 1
    const color = (row: ExperimentRow) => {
      if (!row.isValid || row.status === 'failed' || row.status === 'needs-decision') {
        return 'error'
      }
      return needsAttention(row) || isStale(row, states) ? 'warning' : undefined
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{headerLine(view, e.props.bodyColumns)}</Text>
        {view.batches.map((batch: Batch) => (
          <Box flexDirection="column">
            {isSeveral && <Text weight="bold">{batch.branch}</Text>}
            {batch.rows.map(row => {
              const key = `${batch.name}/${row.id}`
              const isOpen = open.includes(key)
              return (
                <Box flexDirection="column">
                  <Button key={key} plain onPress={() => void toggle($, key)}>
                    <Text color={color(row)} weight={needsAttention(row) ? 'bold' : undefined}>
                      {rowLine(row, states, isOpen)}
                    </Text>
                  </Button>
                  {isOpen &&
                    detailLines(row, states).map(line => <Text dimColor>{line}</Text>)}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}

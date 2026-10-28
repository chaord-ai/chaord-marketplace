import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ExperimentRow, LabView } from '../types'
import { needsAttention, parseRecord } from './parse'

const PANE = 'experiments'
const TITLE = 'Experiments'
const DIR = 'lab/experiments'
const REFRESH_MS = 15000

// Change the tag when LabView's fields change: an older stored value is then
// read as the initial value instead of a wrong shape.
const lab = atom(
  { plugin: 'experiment-conductor', key: 'lab' } as const,
  { hasLab: false, rows: [] } as LabView,
  { shape: 'lab-1' },
)

async function scan($: EngineInterface): Promise<LabView> {
  if (!(await $.fs.exists(DIR))) return { hasLab: false, rows: [] }
  const entries = await $.fs.list(DIR)
  const names = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .map(entry => entry.name)
    .sort()
  const rows: ExperimentRow[] = []
  for (const name of names) {
    try {
      rows.push(parseRecord(name, await $.fs.read(`${DIR}/${name}`)))
    } catch {
      // A record removed or unreadable mid-scan is shown at the next refresh.
    }
  }
  return { hasLab: true, rows }
}

// Module state starts over on a reload, which only costs one redundant write.
let last = ''
let isOpened = false

async function refresh($: EngineInterface): Promise<void> {
  const view = await scan($).catch(() => ({ hasLab: false, rows: [] }))
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

export const register: Register = (on, options) => {
  if (options.showPane === false) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'experiments',
      description: 'Show the experiments in lab/experiments/ in a pane',
    })
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return result
  })

  on('command.run', { command: 'experiments' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Experiments pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, lab)
    if (!view.hasLab) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No lab/experiments/ folder in this project.</Text>
        </Box>
      )
    }
    const waiting = view.rows.filter(needsAttention).length
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {view.rows.length} experiments, {waiting} need you
        </Text>
        {view.rows.map(row => {
          const flagged = needsAttention(row)
          const isBad = row.status === 'failed' || row.status === 'needs-decision'
          const job = row.latestJob === '' ? 'no job' : `job ${row.latestJob}`
          return (
            <Box flexDirection="column">
              <Text
                color={isBad ? 'error' : flagged ? 'warning' : undefined}
                weight={flagged ? "bold" : undefined}
              >
                {flagged ? '! ' : '  '}
                {row.id} {row.title}
              </Text>
              <Text dimColor>
                {'    '}
                {row.status} | {row.review} | {row.attempts} attempts | {job}
              </Text>
              {isBad && row.reason !== '' && (
                <Text color="error">
                  {'    '}
                  {row.reason}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}

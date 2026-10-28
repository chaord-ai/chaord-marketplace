import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Batch, ExperimentRow, LabView } from '../types'
import { needsAttention, parseRecord } from './parse'

const PANE = 'experiments'
const TITLE = 'Experiments'
const LAB = 'lab'
const REFRESH_MS = 15000

// Change the tag when LabView's fields change: an older stored value is then
// read as the initial value instead of a wrong shape.
const lab = atom(
  { plugin: 'experiment-conductor', key: 'lab' } as const,
  { hasLab: false, batches: [] } as LabView,
  { shape: 'lab-2' },
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

// Module state starts over on a reload, which only costs one redundant write.
let last = ''
let isOpened = false

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

export const register: Register = (on, options) => {
  if (options.showPane === false) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'experiments',
      description: 'Show the experiments in lab/ in a pane, grouped by batch',
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
          <Text dimColor>No lab/ folder in this project.</Text>
        </Box>
      )
    }
    const rows = view.batches.flatMap(batch => batch.rows)
    const waiting = rows.filter(needsAttention).length
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {rows.length} experiments in {view.batches.length}{' '}
          {view.batches.length === 1 ? 'batch' : 'batches'}, {waiting} need you
        </Text>
        {view.batches.map(batch => (
          <Box flexDirection="column">
            <Text weight="bold">
              {batch.name} on {batch.branch}
            </Text>
            {batch.rows.map(row => {
              const flagged = needsAttention(row)
              const isBad =
                !row.isValid || row.status === 'failed' || row.status === 'needs-decision'
              const job = row.latestJob === '' ? 'no job' : `job ${row.latestJob}`
              const detail = row.isValid
                ? `${row.status} | ${row.review} | ${row.attempts} attempts | ${job}`
                : 'missing or malformed front matter'
              return (
                <Box flexDirection="column">
                  <Text
                    color={isBad ? 'error' : flagged ? 'warning' : undefined}
                    weight={flagged ? 'bold' : undefined}
                  >
                    {flagged ? '! ' : '  '}
                    {row.id} {row.title}
                  </Text>
                  <Text dimColor>
                    {'    '}
                    {detail}
                  </Text>
                  {row.isValid && isBad && row.reason !== '' && (
                    <Text color="error">
                      {'    '}
                      {row.reason}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}

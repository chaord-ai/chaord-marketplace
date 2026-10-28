import { expect, mock, test } from 'claude-code/testing'

import { needsAttention, parseRecord } from '../hooks/parse'

const PANE = {
  plugin: 'experiment-conductor',
  component: 'Pane',
  requestId: 'experiments',
  props: {
    title: 'Experiments',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const DECISION = `---
id: E005
title: Broken data loader
status: needs-decision  # proposed | ready | running | done | failed | needs-decision
review: pending
depends_on: []
priority: 2
jobs: [481202, 481210]
---
## Hypothesis
## Attempts            # Executor appends: date, job id, what changed, outcome, log path
- 2026-10-29 10:02 | job 481202 | first run | failed: code bug | logs/a.out
- 2026-10-29 10:04 | job 481210 | none | needs-decision: KeyError in loader | logs/b.out
## Result
## Verdict
`

const DONE = `---
id: E001
title: Baseline
status: done
review: awaiting-analysis
depends_on: []
priority: 1
jobs: [481200]
---
## Attempts
- 2026-10-29 10:00 | job 481200 | first run | done | logs/c.out
`

const RUNNING = `---
id: E002
title: Mask ratio 0.75
status: running
review: pending
depends_on: [E001]
priority: 2
jobs: [481201]
---
## Attempts
- 2026-10-29 10:01 | job 481201 | first run | submitted | logs/d.out
`

test('a record is parsed into its pane row', () => {
  const row = parseRecord('E005-broken-data-loader.md', DECISION)
  expect(row).toEqual({
    id: 'E005',
    title: 'Broken data loader',
    status: 'needs-decision',
    review: 'pending',
    attempts: 2,
    latestJob: '481210',
    reason: 'needs-decision: KeyError in loader',
  })
  expect(needsAttention(row)).toBe(true)
  expect(needsAttention(parseRecord('E002.md', RUNNING))).toBe(false)
})

test('the pane lists records and flags the ones that need the user', async ($, on) => {
  const rows = [
    parseRecord('E001-baseline.md', DONE),
    parseRecord('E002-mask.md', RUNNING),
    parseRecord('E005-broken-data-loader.md', DECISION),
  ]
  // Stands for what the module stored at its last scan of lab/experiments/.
  on('state.get', () => ({
    value: { value: { shape: 'lab-1', value: { hasLab: true, rows } }, version: 1 },
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /experiments,/ }))?.text).toBe(
      '3 experiments, 2 need you',
    )
    expect((await ui.find({ type: 'Text', text: /E002/ }))?.text).toBe(
      '  E002 Mask ratio 0.75',
    )
    expect((await ui.find({ type: 'Text', text: /E005/ }))?.text).toBe(
      '! E005 Broken data loader',
    )
    expect((await ui.find({ type: 'Text', text: /481201/ }))?.text).toBe(
      '    running | pending | 1 attempts | job 481201',
    )
    expect((await ui.find({ type: 'Text', text: /KeyError/ }))?.text).toBe(
      '    needs-decision: KeyError in loader',
    )
    await ui.unmount()
  }
})

test('without lab/experiments/ the pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe(
    'No lab/experiments/ folder in this project.',
  )
  await ui.unmount()
})

test('showPane false leaves the pane to the engine', { options: { showPane: false } }, async ($, on) => {
  // Nothing draws beneath the plugin: this hook stands for the engine.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('at session start the module scans lab/experiments/ and opens the pane', async ($, on) => {
  const files: Record<string, string> = {
    'lab/experiments/E001-baseline.md': DONE,
    'lab/experiments/E002-mask.md': RUNNING,
  }
  const opened: string[] = []
  // Each hook stands for the engine: a call on `$` is answered `{ value }`.
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({
    value: [
      { name: 'E002-mask.md', kind: 'file', size: 1, mtimeMs: 1, isLink: false },
      { name: 'E001-baseline.md', kind: 'file', size: 1, mtimeMs: 1, isLink: false },
      { name: 'notes', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  const reads: string[] = []
  on('fs.read', (_, e) => {
    // The engine hands the hook the path resolved against the working directory.
    const path = String(e.path).replace(/^.*\/(lab\/experiments\/)/, '$1')
    reads.push(path)
    return { value: files[path] ?? '' }
  })
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'experiments' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['experiments'])
  expect(reads).toEqual([
    'lab/experiments/E001-baseline.md',
    'lab/experiments/E002-mask.md',
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /experiments,/ }))?.text).toBe(
    '2 experiments, 1 need you',
  )
  expect((await ui.find({ type: 'Text', text: /E001/ }))?.text).toBe('! E001 Baseline')
  await ui.unmount()
})

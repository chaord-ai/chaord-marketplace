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
## Attempts            # Executor appends one line per attempt
- 2026-10-29 10:02 | commit 3f2a1bc | job 481202 | run runs/E005/1 | provenance runs/E005/1/provenance.json | first run | failed: code bug | logs/a.out
- 2026-10-29 10:04 | commit 3f2a1bc | job 481210 | run runs/E005/2 | provenance runs/E005/2/provenance.json | none | needs-decision: KeyError in loader | logs/b.out
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
- 2026-10-29 10:00 | commit 3f2a1bc | job 481200 | run runs/E001/1 | provenance runs/E001/1/prov.json | first run | done | logs/c.out
`

const RUNNING = `---
id: E002
title: Mask ratio 0.75
status: running
review: pending
depends_on: [E001]
priority: 2
jobs:
  - 481201
  - "481207"   # retry
---
## Attempts
- 2026-10-29 10:01 | commit 3f2a1bc | job 481201 | run runs/E002/1 | provenance runs/E002/1/provenance.json | first run | failed: infra | logs/d.out
- 2026-10-29 10:30 | commit 3f2a1bc | job 481207 | run runs/E002/2 | provenance runs/E002/2/provenance.json | resubmit | submitted | logs/e.out
`

const MALFORMED = `id: E009
title: No fence
status: ready
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
    isValid: true,
  })
  expect(needsAttention(row)).toBe(true)
})

test('a block list of jobs gives the latest job, and a record without front matter is invalid', () => {
  const running = parseRecord('E002-mask.md', RUNNING)
  expect(running.latestJob).toBe('481207')
  expect(running.attempts).toBe(2)
  expect(needsAttention(running)).toBe(false)

  const broken = parseRecord('E009-no-fence.md', MALFORMED)
  expect(broken.isValid).toBe(false)
  expect(broken.id).toBe('E009-no-fence')
  expect(needsAttention(broken)).toBe(true)
})

test('a failed record needs the user until it is closed with a verdict', () => {
  const open = parseRecord('E004-fail.md', '---\nid: E004\ntitle: Fail\nstatus: failed\nreview: pending\njobs: [7]\n---\n')
  expect(needsAttention(open)).toBe(true)
  const closed = parseRecord('E004-fail.md', '---\nid: E004\ntitle: Fail\nstatus: failed\nreview: inconclusive\njobs: [7]\n---\n')
  expect(needsAttention(closed)).toBe(false)
})

test('the pane groups records by batch, shows each branch and flags what needs the user', async ($, on) => {
  const batches = [
    {
      name: '2026-10-28-ssl',
      branch: 'exp/2026-10-28-ssl',
      rows: [parseRecord('E001-baseline.md', DONE), parseRecord('E002-mask.md', RUNNING)],
    },
    {
      name: '2026-10-29-loader',
      branch: 'exp/2026-10-29-loader',
      rows: [
        parseRecord('E005-broken-data-loader.md', DECISION),
        parseRecord('E009-no-fence.md', MALFORMED),
      ],
    },
  ]
  // Stands for what the module stored at its last scan of lab/.
  on('state.get', () => ({
    value: { value: { shape: 'lab-2', value: { hasLab: true, batches } }, version: 1 },
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /experiments in/ }))?.text).toBe(
      '4 experiments in 2 batches, 3 need you',
    )
    expect((await ui.find({ type: 'Text', text: /^2026-10-29/ }))?.text).toBe(
      '2026-10-29-loader on exp/2026-10-29-loader',
    )
    expect((await ui.find({ type: 'Text', text: /E002/ }))?.text).toBe(
      '  E002 Mask ratio 0.75',
    )
    expect((await ui.find({ type: 'Text', text: /481207/ }))?.text).toBe(
      '    running | pending | 2 attempts | job 481207',
    )
    expect((await ui.find({ type: 'Text', text: /KeyError/ }))?.text).toBe(
      '    needs-decision: KeyError in loader',
    )
    expect((await ui.find({ type: 'Text', text: /malformed/ }))?.text).toBe(
      '    missing or malformed front matter',
    )
    await ui.unmount()
  }
})

test('without lab/ the pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No lab/ folder in this project.')
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

test('at session start the module scans the batch folders and opens the pane', async ($, on) => {
  const files: Record<string, string> = {
    'lab/2026-10-28-ssl/E001-baseline.md': DONE,
    'lab/2026-10-28-ssl/E002-mask.md': RUNNING,
    'lab/2026-10-28-ssl/README.md': '# plan',
  }
  const entry = (name: string, kind: 'file' | 'dir') => ({
    name,
    kind,
    size: 1,
    mtimeMs: 1,
    isLink: false,
  })
  const opened: string[] = []
  // Each hook stands for the engine: a call on `$` is answered `{ value }`.
  // The engine hands the hooks paths resolved against the working directory.
  const rel = (path: unknown) => String(path).replace(/^.*?\/?(lab(\/|$))/, '$1')
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => {
    const dir = rel(e.path).replace(/\/$/, '')
    if (dir === 'lab') {
      return { value: [entry('2026-10-28-ssl', 'dir'), entry('notes.md', 'file')] }
    }
    if (dir === 'lab/2026-10-28-ssl') {
      return {
        value: [entry('README.md', 'file'), entry('E002-mask.md', 'file'), entry('E001-baseline.md', 'file')],
      }
    }
    return { value: [] }
  })
  const reads: string[] = []
  on('fs.read', (_, e) => {
    const path = rel(e.path)
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
  expect(reads).toEqual(['lab/2026-10-28-ssl/E001-baseline.md', 'lab/2026-10-28-ssl/E002-mask.md'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /experiments in/ }))?.text).toBe(
    '2 experiments in 1 batch, 1 need you',
  )
  expect((await ui.find({ type: 'Text', text: /on exp\// }))?.text).toBe(
    '2026-10-28-ssl on exp/2026-10-28-ssl',
  )
  expect((await ui.find({ type: 'Text', text: /E001/ }))?.text).toBe('! E001 Baseline')
  await ui.unmount()
})

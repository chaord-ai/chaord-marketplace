import type { On, OpEventResult } from 'claude-code'
import type { Mounted } from 'claude-code/testing'
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

// The pane's lines as drawn, top to bottom: each Button's text and each Text
// outside a Button (a row's Text inside its Button repeats the Button's).
async function lines(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  const out: string[] = []
  let button = ''
  for (const found of await ui.findAll({})) {
    if (found.type === 'Button') {
      button = found.text
      out.push(found.text)
    } else if (found.type === 'Text') {
      if (found.text === button) button = ''
      else out.push(found.text)
    }
  }
  return out
}

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
    hypothesis: '',
    success: '',
    verdict: '',
    attemptList: [
      {
        date: '2026-10-29',
        time: '10:02',
        commit: '3f2a1bc',
        job: '481202',
        run: 'runs/E005/1',
        provenance: 'runs/E005/1/provenance.json',
        change: 'first run',
        outcome: 'failed: code bug',
        log: 'logs/a.out',
      },
      {
        date: '2026-10-29',
        time: '10:04',
        commit: '3f2a1bc',
        job: '481210',
        run: 'runs/E005/2',
        provenance: 'runs/E005/2/provenance.json',
        change: 'none',
        outcome: 'needs-decision: KeyError in loader',
        log: 'logs/b.out',
      },
    ],
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

test('only a proposal, a decision or an unreadable record needs the user', () => {
  const proposed = parseRecord('E006-new.md', '---\nid: E006\ntitle: New\nstatus: proposed\nreview: pending\njobs: []\n---\n')
  expect(needsAttention(proposed)).toBe(true)
  const analysis = parseRecord('E001-done.md', '---\nid: E001\ntitle: Done\nstatus: done\nreview: awaiting-analysis\njobs: [5]\n---\n')
  expect(needsAttention(analysis)).toBe(false)
  const open = parseRecord('E004-fail.md', '---\nid: E004\ntitle: Fail\nstatus: failed\nreview: pending\njobs: [7]\n---\n')
  expect(needsAttention(open)).toBe(false)
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
  // Stands for what the module stored at its last scan of lab/. The other
  // values carry other shape tags, so they read as their initial values.
  on('state.get', () => ({
    value: { value: { shape: 'lab-3', value: { hasLab: true, batches } }, version: 1 },
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await lines(ui)).toEqual([
      '4 experiments · 2 need you',
      'exp/2026-10-28-ssl',
      '  ▸ E001 Baseline                 done      awaiting analysis',
      '  ▸ E002 Mask ratio 0.75          running   job 481207',
      'exp/2026-10-29-loader',
      '! ▸ E005 Broken data loader       needs decision · KeyError in loader',
      '! ▸ E009-no-fence                 unreadable · front matter unreadable',
    ])
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
  // No scheduler on this machine: sacct and ps cannot start.
  on('process.run', () => ({ deny: 'not found' }))
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
  expect(await lines(ui)).toEqual([
    '2 experiments · 0 need you' + ' '.repeat(16) + 'exp/2026-10-28-ssl',
    '  ▸ E001 Baseline                 done      awaiting analysis',
    '  ▸ E002 Mask ratio 0.75          running   job 481207',
  ])
  await ui.unmount()
})

// The batch from the layout the user approved, as the records stand while
// SLURM already has E005's job finished and the Executor has not written it.
const DRY_RUN: Record<string, string> = {
  'E001-dummy-baseline.md': `---
id: E001
title: Dummy baseline
status: done
review: awaiting-analysis
jobs: [62936]
---
## Attempts
- 2026-10-29 02:05 | commit 3f2a1bc | job 62936 | run runs/E001/1 | provenance runs/E001/1/provenance.json | first run | done | logs/E001-62936.out
`,
  'E002-dummy-variant-a.md': `---
id: E002
title: Dummy variant A
status: done
review: awaiting-analysis
jobs: [62937]
---
## Attempts
- 2026-10-29 02:06 | commit 3f2a1bc | job 62937 | run runs/E002/1 | provenance runs/E002/1/provenance.json | first run | done | logs/E002-62937.out
`,
  'E003-follow-up-on-e002.md': `---
id: E003
title: Follow-up on E002
status: running
review: pending
depends_on: [E002]
jobs: [62940]
---
## Attempts
- 2026-10-29 02:20 | commit 3f2a1bc | job 62940 | run runs/E003/1 | provenance runs/E003/1/provenance.json | first run | submitted | logs/E003-62940.out
`,
  'E004-forced-failure.md': `---
id: E004
title: Forced failure
status: needs-decision
review: pending
jobs: [62938]
---
## Hypothesis
A job that exits 1 is recorded and stopped, not retried
## Change vs baseline
## Command / resources
## Success criterion
status needs-decision with a reason
## Attempts
- 2026-10-29 02:07 | commit 3f2a1bc | job 62938 | run runs/E004/1 | provenance runs/E004/1/provenance.json | first run | needs-decision: code bug, exits 1 by design | logs/E004-62938.out
## Result
## Verdict
`,
  'E005-variant-b-worse.md': `---
id: E005
title: Variant B (worse)
status: running
review: pending
jobs: [62939]
---
## Attempts
- 2026-10-29 02:08 | commit 3f2a1bc | job 62939 | run runs/E005/1 | provenance runs/E005/1/provenance.json | first run | submitted | logs/E005-62939.out
`,
}

// What a stub sacct on PATH would print for each job: the pane asks with
// `sacct -X -n -P -o JobID,State,ExitCode -j <ids>`.
const SACCT: Record<string, string> = {
  '62936': '62936|COMPLETED|0:0',
  '62937': '62937|COMPLETED|0:0',
  '62938': '62938|FAILED|1:0',
  '62939': '62939|COMPLETED|0:0',
  '62940': '62940|RUNNING|0:0',
}

const DRY_PANE = { ...PANE, props: { ...PANE.props, bodyColumns: 69 } }

type Host = { queries: string[][]; writes: string[] }

// Stands for the engine beneath the plugin: a project with one batch folder,
// the clock, and a host where `scheduler` answers process runs. Every write
// is recorded so a test can check that the pane made none.
function project(on: On, scheduler: (argv: readonly string[]) => OpEventResult<'process.run'>): Host {
  const host: Host = { queries: [], writes: [] }
  const entry = (name: string, kind: 'file' | 'dir') => ({
    name,
    kind,
    size: 1,
    mtimeMs: 1,
    isLink: false,
  })
  const rel = (path: unknown) => String(path).replace(/^.*?\/?(lab(\/|$))/, '$1')
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => {
    const dir = rel(e.path).replace(/\/$/, '')
    if (dir === 'lab') return { value: [entry('2026-10-29-workflow-dry-run', 'dir')] }
    if (dir === 'lab/2026-10-29-workflow-dry-run') {
      return { value: Object.keys(DRY_RUN).map(name => entry(name, 'file')) }
    }
    return { value: [] }
  })
  on('fs.read', (_, e) => ({ value: DRY_RUN[rel(e.path).split('/').pop() ?? ''] ?? '' }))
  on('fs.write', (_, e) => {
    host.writes.push(String(e.path))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    host.queries.push([...e.argv])
    return scheduler(e.argv)
  })
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'experiments' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return host
}

// A stub sacct: prints the line of each job asked for.
function stubSacct(argv: readonly string[]): OpEventResult<'process.run'> {
  if (argv[0] !== 'sacct') return { deny: 'not found' }
  const ids = (argv[argv.indexOf('-j') + 1] ?? '').split(',')
  const stdout = ids.map(id => SACCT[id]).filter(line => line !== undefined).join('\n')
  return {
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }
}

const COLLAPSED = [
  '5 experiments · 1 needs you' + ' '.repeat(11) + 'exp/2026-10-29-workflow-dry-run',
  '  ▸ E001 Dummy baseline           done      awaiting analysis',
  '  ▸ E002 Dummy variant A          done      awaiting analysis',
  '  ▸ E003 Follow-up on E002        running   SLURM RUNNING · job 62940',
  '! ▸ E004 Forced failure           needs decision · exit 1 (code bug)',
  '  ▸ E005 Variant B (worse)        running   SLURM COMPLETED · record not updated',
]

test('a running record whose job SLURM reports finished is flagged record not updated', async ($, on) => {
  const host = project(on, stubSacct)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Only the latest job of each running or open failed record is asked about.
  expect(host.queries).toEqual([
    ['sacct', '-X', '-n', '-P', '-S', 'now-7days', '-o', 'JobID,State,ExitCode', '-j', '62938,62939,62940'],
  ])
  const ui = await $.ui.mount({ ...DRY_PANE, surface: 'terminal' })
  expect(await lines(ui)).toEqual(COLLAPSED)
  expect(host.writes).toEqual([])
  await ui.unmount()
})

test('without a scheduler or a process to query, rows show the record status alone', async ($, on) => {
  const host = project(on, () => ({ deny: 'not found' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // sacct cannot start, so the process table is asked, and ps cannot either.
  expect(host.queries.map(argv => argv[0])).toEqual(['sacct', 'ps'])
  const ui = await $.ui.mount({ ...DRY_PANE, surface: 'terminal' })
  const drawn = await lines(ui)
  expect(drawn[3]).toBe('  ▸ E003 Follow-up on E002        running   job 62940')
  expect(drawn[4]).toBe('! ▸ E004 Forced failure           needs decision · code bug, exits 1 by design')
  expect(drawn[5]).toBe('  ▸ E005 Variant B (worse)        running   job 62939')
  expect(host.writes).toEqual([])
  await ui.unmount()
})

test('on a single machine the process table says whether each job is alive', async ($, on) => {
  project(on, argv => {
    if (argv[0] !== 'ps') return { deny: 'not found' }
    return {
      value: { exitCode: 0, stdout: '62940\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...DRY_PANE, surface: 'terminal' })
  const drawn = await lines(ui)
  expect(drawn[3]).toBe('  ▸ E003 Follow-up on E002        running   process running · job 62940')
  expect(drawn[5]).toBe('  ▸ E005 Variant B (worse)        running   process ended · record not updated')
  await ui.unmount()
})

const OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

test('sacct that exits non-zero asks no ps and flags no row', async ($, on) => {
  const host = project(on, () => ({ value: { ...OK, exitCode: 1, stdout: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(host.queries.map(argv => argv[0])).toEqual(['sacct'])
  const ui = await $.ui.mount({ ...DRY_PANE, surface: 'terminal' })
  const drawn = await lines(ui)
  expect(drawn[3]).toBe('  ▸ E003 Follow-up on E002        running   job 62940')
  expect(drawn[5]).toBe('  ▸ E005 Variant B (worse)        running   job 62939')
  await ui.unmount()
})

test('an empty sacct state for a running job does not flag the row', async ($, on) => {
  project(on, argv =>
    argv[0] === 'sacct'
      ? { value: { ...OK, stdout: '62939||0:0\n62940|RUNNING|0:0' } }
      : { deny: 'not found' },
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...DRY_PANE, surface: 'terminal' })
  const drawn = await lines(ui)
  expect(drawn[5]).not.toContain('record not updated')
  await ui.unmount()
})

test('without sacct the ps fallback is used', async ($, on) => {
  const host = project(on, argv =>
    argv[0] === 'ps' ? { value: { ...OK, stdout: '62940\n' } } : { deny: 'not found' },
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(host.queries.map(argv => argv[0])).toEqual(['sacct', 'ps'])
})

test('pressing a row expands it in place and pressing it again collapses it', async ($, on) => {
  const host = project(on, stubSacct)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...DRY_PANE, surface })
    await ui.press({ key: '2026-10-29-workflow-dry-run/E004' })
    expect(await lines(ui)).toEqual([
      ...COLLAPSED.slice(0, 4),
      '! ▾ E004 Forced failure           needs decision',
      '    Hypothesis   A job that exits 1 is recorded and stopped, not retried',
      '    Success      status needs-decision with a reason',
      '    Attempts     #1  02:07  job 62938  commit 3f2a1bc  FAILED 1:0',
      '                     needs-decision: code bug, exits 1 by design',
      '    Run          runs/E004/1   log logs/E004-62938.out',
      '    Waiting on   your decision (Researcher can close it as done or failed)',
      COLLAPSED[5],
    ])
    // Expanding asks about every attempt's job of the expanded row too.
    expect(host.queries[host.queries.length - 1]).toEqual([
      'sacct', '-X', '-n', '-P', '-S', 'now-7days', '-o', 'JobID,State,ExitCode', '-j', '62938,62939,62940',
    ])
    await ui.press({ key: '2026-10-29-workflow-dry-run/E004' })
    expect(await lines(ui)).toEqual(COLLAPSED)
    await ui.unmount()
  }
  expect(host.writes).toEqual([])
})

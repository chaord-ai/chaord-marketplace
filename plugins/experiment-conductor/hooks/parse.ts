import type { Attempt, ExperimentRow } from '../types'

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

// Drops a field's leading word, as `job` in `job 481233`.
function after(field: string, word: string): string {
  return field.startsWith(`${word} `) ? field.slice(word.length + 1).trim() : field
}

// One attempt line, in the form skills/experiment-protocol/SKILL.md defines:
// `- date time | commit | job | run | provenance | change | outcome | log`.
// A line with fewer fields keeps its outcome and log as its last two.
export function parseAttempt(line: string): Attempt {
  const fields = line
    .replace(/^-\s*/, '')
    .split('|')
    .map(f => f.trim())
  const at = (i: number) => fields[i] ?? ''
  const [date = '', time = ''] = at(0).split(/\s+/)
  const isFull = fields.length >= 8
  return {
    date,
    time,
    commit: after(at(1), 'commit'),
    job: after(at(2), 'job'),
    run: isFull ? after(at(3), 'run') : '',
    provenance: isFull ? after(at(4), 'provenance') : '',
    change: isFull ? at(5) : '',
    outcome: fields.length >= 3 ? at(fields.length - 2) : '',
    log: fields.length >= 3 ? at(fields.length - 1) : '',
  }
}

// Reads one record the way hooks/session-start.sh does: front matter fields,
// the last entry of `jobs` (inline `[a, b]` or a block list of `- a` lines),
// the number of attempt lines, and the outcome of the last attempt line (its
// second to last field) as the reason. For the expanded row it also reads the
// text under Hypothesis, Success criterion and Verdict, and every attempt.
export function parseRecord(fileName: string, text: string): ExperimentRow {
  const row: ExperimentRow = {
    id: '',
    title: '',
    status: '',
    review: '',
    attempts: 0,
    latestJob: '',
    reason: '',
    isValid: false,
    hypothesis: '',
    success: '',
    verdict: '',
    attemptList: [],
  }
  const prose = new Map<string, string[]>([
    ['Hypothesis', []],
    ['Success criterion', []],
    ['Verdict', []],
  ])
  const lines = text.split('\n').map(raw => raw.replace(/\r$/, ''))
  let fence = /^---\s*$/.test(lines[0] ?? '') ? 0 : -1
  let section = ''
  let inJobs = false
  for (const line of lines) {
    if (fence === -1) break
    if (fence < 2 && /^---\s*$/.test(line)) {
      fence++
      continue
    }
    if (fence === 1) {
      if (inJobs && /^\s*-/.test(line)) {
        const job = unquote(line.replace(/^\s*-\s*/, '').replace(/\s+#.*$/, ''))
        if (job !== '') row.latestJob = job
        continue
      }
      inJobs = false
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
      if (!m) continue
      const value = (m[2] ?? '').replace(/\s+#.*$/, '').trim()
      if (m[1] === 'id') row.id = value
      else if (m[1] === 'title') row.title = value
      else if (m[1] === 'status') row.status = value
      else if (m[1] === 'review') row.review = value
      else if (m[1] === 'jobs') {
        if (value === '') inJobs = true
        else {
          const jobs = value
            .replace(/[[\]]/g, '')
            .split(',')
            .map(unquote)
            .filter(j => j !== '')
          row.latestJob = jobs[jobs.length - 1] ?? ''
        }
      }
      continue
    }
    if (line.startsWith('## ')) {
      section = line.slice(3).replace(/\s+#.*$/, '').trim()
      continue
    }
    if (section === 'Attempts' && line.startsWith('- ')) {
      row.attempts++
      const attempt = parseAttempt(line)
      row.attemptList.push(attempt)
      row.reason = attempt.outcome
      continue
    }
    const kept = prose.get(section)
    if (kept && line.trim() !== '') kept.push(line.trim())
  }
  row.hypothesis = (prose.get('Hypothesis') ?? []).join(' ')
  row.success = (prose.get('Success criterion') ?? []).join(' ')
  row.verdict = (prose.get('Verdict') ?? []).join(' ')
  row.isValid = fence === 2 && row.id !== '' && row.status !== ''
  if (row.id === '') row.id = fileName.replace(/\.md$/, '')
  return row
}

// Whether a record waits on the user, so nothing moves until they act: a
// proposal waiting for approval, a decision, or a record that cannot be read.
// Failures and analyses are the agents' turn first.
export function needsAttention(row: ExperimentRow): boolean {
  return !row.isValid || row.status === 'needs-decision' || row.status === 'proposed'
}

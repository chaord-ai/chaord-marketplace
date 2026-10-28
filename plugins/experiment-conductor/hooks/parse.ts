import type { ExperimentRow } from '../types'

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

// Reads one record the way hooks/session-start.sh does: front matter fields,
// the last entry of `jobs` (inline `[a, b]` or a block list of `- a` lines),
// the number of attempt lines, and the outcome of the last attempt line (its
// second to last field) as the reason.
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
  }
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
      const fields = line.split('|').map(f => f.trim())
      row.reason = fields.length >= 3 ? (fields[fields.length - 2] ?? '') : ''
    }
  }
  row.isValid = fence === 2 && row.id !== '' && row.status !== ''
  if (row.id === '') row.id = fileName.replace(/\.md$/, '')
  return row
}

// Whether a record needs the user: a decision, a failure not yet closed with a
// verdict, an analysis to agree on, a proposal waiting for approval, or a
// record that cannot be read.
export function needsAttention(row: ExperimentRow): boolean {
  const hasVerdict = ['supported', 'refuted', 'inconclusive'].includes(row.review)
  return (
    !row.isValid ||
    row.status === 'needs-decision' ||
    (row.status === 'failed' && !hasVerdict) ||
    row.status === 'proposed' ||
    row.review === 'awaiting-analysis'
  )
}

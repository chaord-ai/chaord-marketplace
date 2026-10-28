import type { ExperimentRow } from '../types'

// Reads one record of lab/experiments/ the way hooks/session-start.sh does:
// front matter fields, the last entry of `jobs`, the number of attempt lines,
// and the outcome of the last attempt line as the reason.
export function parseRecord(fileName: string, text: string): ExperimentRow {
  const row: ExperimentRow = {
    id: fileName.replace(/\.md$/, ''),
    title: '',
    status: '',
    review: '',
    attempts: 0,
    latestJob: '',
    reason: '',
  }
  let fence = 0
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (fence < 2 && /^---\s*$/.test(line)) {
      fence++
      continue
    }
    if (fence === 1) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
      if (!m) continue
      const value = (m[2] ?? '').replace(/\s+#.*$/, '').trim()
      if (m[1] === 'id' && value) row.id = value
      else if (m[1] === 'title') row.title = value
      else if (m[1] === 'status') row.status = value
      else if (m[1] === 'review') row.review = value
      else if (m[1] === 'jobs') {
        const jobs = value
          .replace(/[[\]]/g, '')
          .split(',')
          .map(j => j.trim())
          .filter(j => j !== '')
        row.latestJob = jobs[jobs.length - 1] ?? ''
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
      row.reason = fields[3] ?? ''
    }
  }
  return row
}

// Whether a record needs the user: a decision, a failure, an analysis to
// agree on, or a proposal waiting for approval.
export function needsAttention(row: ExperimentRow): boolean {
  return (
    row.status === 'needs-decision' ||
    row.status === 'failed' ||
    row.status === 'proposed' ||
    row.review === 'awaiting-analysis'
  )
}

export type ExperimentRow = {
  id: string
  title: string
  status: string
  review: string
  attempts: number
  latestJob: string
  reason: string
  // False when the front matter is missing, unclosed or has no id or status.
  isValid: boolean
}

// One folder lab/<batch>/ on branch exp/<batch>.
export type Batch = { name: string; branch: string; rows: ExperimentRow[] }

export type LabView = { hasLab: boolean; batches: Batch[] }

declare module 'claude-code' {
  interface PluginState {
    'experiment-conductor': { lab: Shaped<LabView> }
  }
}

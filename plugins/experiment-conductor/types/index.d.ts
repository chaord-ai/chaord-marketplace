export type ExperimentRow = {
  id: string
  title: string
  status: string
  review: string
  attempts: number
  latestJob: string
  reason: string
}

export type LabView = { hasLab: boolean; rows: ExperimentRow[] }

declare module 'claude-code' {
  interface PluginState {
    'experiment-conductor': { lab: Shaped<LabView> }
  }
}

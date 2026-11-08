/**
 * <ComputingReadout/>: kept for the current app composition, which mounts it for phase 'computing'
 * and <ResultsView/> for 'results'. The readout now lives INSIDE the one results panel (decision #10,
 * R1): ResultsView renders the computing state itself. Once the app mounts ResultsView for both
 * phases (core K5), this wrapper is unused.
 */
import { ResultsView } from './ResultsView'

export function ComputingReadout({ onCancel }: { onCancel?: () => void }) {
  return <ResultsView onBack={onCancel} />
}

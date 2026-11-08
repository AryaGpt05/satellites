/**
 * ui-results: progress readout, results panel, timeline, pass list + detail, pushbroom reveal.
 * Contract (docs/ARCHITECTURE.md): <ResultsView/> for phase 'computing' AND 'results' (one persistent panel,
 * decision #10). <ComputingReadout/> remains as a thin wrapper for compositions that still mount it.
 */
export { ComputingReadout } from './ComputingReadout'
export { ResultsView, type ResultsViewProps } from './ResultsView'
export { PushbroomReveal } from './PushbroomReveal'
export { Timeline } from './Timeline'
export { PassPlan } from './PassPlan'
export { focusPass, clearPass, startReplay, togglePlay } from './actions'
export { pickBestLook, bestLookImageUrl, isClouded, type BestLook } from './bestLook'
/** The one verdict vocabulary (DESIGN §7): About and the share renderers import it from here. */
export { VERDICT_META, VERDICTS, verdictUnit, type Verdict, type VerdictWords } from './lib/meta'

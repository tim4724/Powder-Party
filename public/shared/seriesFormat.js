// Series header tag — "Run X of N" mid-series, "Final standings · N runs" once the
// series is decided. Shared by the big screen (display/main.js showResults) and the
// phone board (controller/ui.js renderResultsBoard) so the two copies can't drift.
// Each caller keeps its own "is there a series yet?" guard (the display gates on the
// run index, the phone on the run total); this only owns the wording.
export function runTag(runIndex, runTotal, seriesOver) {
  return seriesOver ? `Final standings · ${runTotal} runs` : `Run ${runIndex} of ${runTotal}`;
}

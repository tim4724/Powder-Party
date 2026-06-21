// SeriesTally — the cumulative scoring across a SERIES of runs, lifted out of
// display/main.js so the trickiest run-to-run state lives in one testable unit.
//
// A session is `runsTotal` head-to-head runs with points accumulating to an overall
// champion. This owns: the current run index (1-based; 0 in the lobby), the series
// length, the over-flag, the per-player banked scores, and the points/folding/row
// derivation. It does NOT touch the DOM, the net, or the engine — main.js keeps that
// lifecycle/IO (the intermission timer, broadcasts, rendering). `seriesPoints` is
// injected (the pure place-→points rule from shared/protocol.js) so this module is
// dependency-free / THREE-free and the Node tests (tests/seriesTally.test.js) load
// it directly — the same discipline the SkiEngine follows.
//
// Scores are keyed by playerId so a player leaving/reconnecting (and CPU-id reuse)
// doesn't drop their tally; the LIVE run's points are layered on top of the banked
// totals by buildRows each render, so the final run is never double-counted (it is
// folded only at advance time, and the final run isn't folded at all).
export class SeriesTally {
  constructor(seriesPoints, runsTotal) {
    this._seriesPoints = seriesPoints;
    this.runsTotal = runsTotal;     // series length (host's lobby pick; survives reset)
    this.runIndex = 0;              // current run, 1-based; 0 in the lobby
    this.seriesOver = false;        // the final run is in the books → overall board
    this.scores = new Map();        // playerId -> { name, colorIndex, ai, points } through COMPLETED runs
  }

  // Wipe the tally for a fresh series (keeps the host's runsTotal pick).
  reset() {
    this.scores = new Map();
    this.runIndex = 0;
    this.seriesOver = false;
  }

  // Step into the next run.
  startNextRun() { this.runIndex += 1; }

  // Mark the just-ended run: the series is over once the final run is in the books.
  // Returns the new seriesOver so the caller can branch on it.
  endCurrentRun() {
    this.seriesOver = this.runIndex >= this.runsTotal;
    return this.seriesOver;
  }

  // Host's lobby pick for the series length.
  setRunsTotal(n) { this.runsTotal = n; }

  // Cross-device reconnect: carry a player's banked points onto their new slot.
  rekey(oldId, newId) {
    if (this.scores.has(oldId)) {
      this.scores.set(newId, this.scores.get(oldId));
      this.scores.delete(oldId);
    }
  }

  // This run's series points for every finisher, keyed by playerId. `res` is the
  // engine getResults() `results` array (1-based rank, finished flag).
  _pointsFor(res) {
    const m = new Map();
    for (const r of res) m.set(r.playerId, this._seriesPoints(r.rank, res.length, r.finished));
    return m;
  }

  // Bank the just-finished run's points into the cumulative tally. Called BEFORE the
  // run's session is torn down (it reads the live field + results). Not called for the
  // final run — the overall board derives totals as banked(prior runs) + final-run
  // points, so the last run is never double-counted.
  fold(field, resultsObj) {
    const pts = this._pointsFor((resultsObj && resultsObj.results) || []);
    for (const p of field) {
      const cur = this.scores.get(p.peerIndex) || { points: 0 };
      this.scores.set(p.peerIndex, {
        name: p.name, colorIndex: p.colorIndex, ai: !!p.ai,
        points: cur.points + (pts.get(p.peerIndex) || 0),
      });
    }
  }

  // The ordered standings rows for the CURRENT run, each carrying this-run `points`
  // and the cumulative `score` (banked total through prior runs + this run's points).
  // Shared by the phone broadcast and the big-screen board so they can't drift. Per
  // run the rows stay in finish order; once the series is over they're sorted by total
  // score (the overall ranking), `place` renumbered, and the leader(s) flagged
  // champion. `resultsObj` is the engine's getResults() output; `field` names/colours
  // the rows (both passed in so a no-relay TestHarness with its own session drives
  // this exact path).
  buildRows(resultsObj, field) {
    const res = (resultsObj && resultsObj.results) || [];
    const byId = new Map(field.map((p) => [p.peerIndex, p]));
    const pts = this._pointsFor(res);
    const rows = res.map((r) => {
      const p = byId.get(r.playerId) || {};
      const point = pts.get(r.playerId) || 0;
      const prior = (this.scores.get(r.playerId) || { points: 0 }).points;
      return {
        playerId: r.playerId, name: p.name || 'Skier',
        colorIndex: p.colorIndex || 0, ai: !!p.ai,
        finished: r.finished, time: r.time, dnf: !!r.dnf,
        place: r.rank, points: point, score: prior + point,
      };
    });
    if (this.seriesOver) {
      // Overall ranking: most points first, this run's finish order breaks ties.
      rows.sort((a, b) => b.score - a.score || a.place - b.place);
      const top = rows.length ? rows[0].score : 0;
      rows.forEach((row, i) => { row.place = i + 1; row.champion = top > 0 && row.score === top; });
    }
    return rows;
  }

  // Stage series state for a no-relay preview (the gallery 'results' scenario) so the
  // live render path shows a mid-series or final board. Never used in live play.
  stagePreview({ index = 1, total = this.runsTotal, over = false, scores = null } = {}) {
    this.runIndex = index;
    this.runsTotal = total;
    this.seriesOver = over;
    if (scores) this.scores = new Map(Object.entries(scores).map(([id, points]) => [id, { points }]));
  }
}

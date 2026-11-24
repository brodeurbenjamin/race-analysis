/**
 * analysis — line up a Garmin .fit recording with official HYROX splits.
 *
 * Pure functions, no network: the page reads the file in the browser and
 * nothing is uploaded or stored.
 *
 * What the watch gets wrong indoors (from the DC Pro 2026 data, Forerunner 970):
 * distance is off by a different amount on every run (1,044-1,444 m for 1 km
 * runs), and Garmin running power and step length are worked out from that
 * speed, so raw watts can't be compared between runs or races. Each run is
 * 1 km, so the official time gives the true speed; power is scaled by true
 * speed / watch speed and step length is true speed / cadence. Heart rate and
 * cadence are measured directly and are the trustworthy channels. Wrist heart
 * rate is unreliable on SkiErg, sled push, burpee broad jumps and lunges.
 *
 * Every HYROX run is 1 km. Comparisons between races also use relative
 * measures (run fade R2 -> R7, each run vs the race's own R2-R7 average).
 */

export const STATIONS = ['SkiErg', 'Sled Push', 'Sled Pull', 'Burpee Broad Jumps', 'Row', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls'];
// Wrist HR during these stations shows smooth decay / cadence lock, not real HR.
export const WRIST_HR_UNRELIABLE = new Set(['SkiErg', 'Sled Push', 'Burpee Broad Jumps', 'Sandbag Lunges']);

const ALIASES = [
  [/^ski/i, 'SkiErg'], [/sled\s*push/i, 'Sled Push'], [/sled\s*pull/i, 'Sled Pull'],
  [/burpee|bbj/i, 'Burpee Broad Jumps'], [/^row/i, 'Row'], [/farmer/i, 'Farmers Carry'],
  [/lunge/i, 'Sandbag Lunges'], [/wall\s*ball/i, 'Wall Balls'], [/rox\s*zone/i, 'Roxzone'],
];

// "3:39" -> 219, "1:02:03" -> 3723, "00:03:39" -> 219; null if not a time.
export function toSeconds(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return null;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

export const clock = (s) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

// A time read from a screenshot can have letter-for-digit slips ("O4:43",
// "04:4l"); fix those in anything shaped like a time before reading it.
const fixDigits = (tok) => (/^[\dOoIl|]{1,2}:[\dOoIl|]{2}(:[\dOoIl|]{2})?$/.test(tok) ? tok.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1') : tok);

// Official splits from pasted text, a CSV like "Run 1,run,3:39,219", lines
// copied from a results page ("Run 1  3:39", "SkiErg 00:04:35") or text read
// from screenshots ("Run 1 PB 03:44 451": the rank after the time is ignored).
// Takes the first time on each line whose name is a run, a station, Roxzone or
// the overall time ("Overall", "Total", "Finish"). Lines like "Avg Run" are
// skipped. Repeated lines (overlapping screenshots) just agree.
// Returns { runs: [8 seconds|null], stations: { name: seconds }, roxzone, overall }.
export function parseSplits(text) {
  const out = { runs: Array(8).fill(null), stations: {}, roxzone: null, overall: null };
  for (const line of String(text).split(/\r?\n/)) {
    const time = line.split(/[\s,;\t]+/).map(fixDigits).map(toSeconds).find((x) => x != null);
    if (time == null) continue;
    if (/^\s*(overall|total|finish)/i.test(line)) {
      out.overall = time;
      continue;
    }
    const run = line.match(/\brun\s*([1-8])\b/i);
    if (run) {
      out.runs[+run[1] - 1] = time;
      continue;
    }
    const alias = ALIASES.find(([re]) => re.test(line.trim()));
    if (!alias) continue;
    if (alias[1] === 'Roxzone') out.roxzone = time;
    else out.stations[alias[1]] = time;
  }
  return out;
}

// Records and laps from the Garmin FIT SDK's decoded messages, in seconds
// from the start of the recording. Cadence is per leg in the file; spm = 2x.
export function fromFitMessages(m) {
  const recs = m.recordMesgs || [];
  if (!recs.length) throw new Error('No second-by-second records in this file.');
  const t0 = +new Date(recs[0].timestamp);
  const records = recs.map((r) => ({
    t: (+new Date(r.timestamp) - t0) / 1000,
    hr: r.heartRate ?? null,
    power: r.power ?? null,
    spm: r.cadence != null ? (r.cadence + (r.fractionalCadence || 0)) * 2 : null,
  }));
  const laps = (m.lapMesgs || []).map((l, i) => ({
    i,
    start: (+new Date(l.startTime) - t0) / 1000,
    dur: l.totalElapsedTime,
    dist: l.totalDistance ?? null,
    cadence: l.avgRunningCadence ?? l.avgCadence ?? 0,
  }));
  const device = (m.deviceInfoMesgs || []).map((d) => d.garminProduct || d.productName).find(Boolean) || null;
  return { records, laps, device, start: new Date(recs[0].timestamp) };
}

// Run laps: long (> 150 s) with running cadence (>= 75 per leg). Each station
// is the longest lap between two runs (after Run 8: the longest lap after it).
// A lap press can split a segment (Boston 2026: sled push over two laps, Run 8
// plus a "final stretch" lap), so when official times are given a segment
// that's clearly short takes in its neighbouring laps of the same kind: a run
// over 20 s short the next laps at running cadence, a station over 60 s short
// (less is normal lap-button slop) the laps either side below running cadence
// (each at least 30 s). Matched segments are contiguous:
// { i (first lap), laps: [indexes], start, dur, dist }.
const RUNNING = 75;
const seg = (list) => ({
  i: list[0].i, laps: list.map((l) => l.i), start: list[0].start,
  dur: list.reduce((s, l) => s + l.dur, 0),
  dist: list.every((l) => l.dist != null) ? list.reduce((s, l) => s + l.dist, 0) : null,
});

export function matchLaps(laps, official = {}) {
  const runLaps = laps.filter((l) => l.dur > 150 && l.cadence >= RUNNING).slice(0, 8);
  const ends = runLaps.map((r, k) => (k + 1 < runLaps.length ? runLaps[k + 1].i : laps.length));
  const stationLaps = runLaps.map((r, k) => {
    const between = laps.filter((l) => l.i > r.i && l.i < ends[k]);
    return between.length ? between.reduce((a, b) => (b.dur > a.dur ? b : a)) : null;
  });
  const runs = runLaps.map((r, k) => {
    const list = [r];
    const want = official.runs?.[k];
    const stop = stationLaps[k] ? stationLaps[k].i : ends[k];
    while (want && seg(list).dur < want - 20) {
      const next = laps[list[list.length - 1].i + 1];
      if (!next || next.i >= stop || next.cadence < RUNNING) break;
      list.push(next);
    }
    return seg(list);
  });
  const stations = stationLaps.map((s, k) => {
    if (!s) return null;
    const list = [s];
    const want = official.stations?.[k];
    const lo = runs[k].laps[runs[k].laps.length - 1], hi = ends[k];
    const ok = (l) => l && l.i > lo && l.i < hi && l.cadence < RUNNING - 15 && l.dur >= 30;
    while (want && seg(list).dur < want - 60) {
      const before = laps[list[0].i - 1], after = laps[list[list.length - 1].i + 1];
      const pick = [after, before].filter(ok).sort((a, b) => b.dur - a.dur)[0];
      if (!pick) break;
      if (pick === after) list.push(pick);
      else list.unshift(pick);
    }
    return seg(list);
  });
  return { runs, stations, ok: runs.length === 8 && stations.every(Boolean) };
}

const avg = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const inLap = (records, lap) => records.filter((r) => r.t >= lap.start && r.t < lap.start + lap.dur);

// Everything the page shows. Runs: official time and true pace, average and
// last-60-s HR, cadence, true step length, watch vs corrected power, HR per
// 100 W. Stations: official time, HR (flagged where wrist HR is unreliable).
export function analyse(fit, splits) {
  const runKm = 1; // every HYROX run is 1 km
  const match = matchLaps(fit.laps, { runs: splits.runs, stations: STATIONS.map((n) => splits.stations[n]) });
  const runs = match.runs.map((lap, k) => {
    const rr = inLap(fit.records, lap);
    const official = splits.runs[k];
    const vTrue = official ? (runKm * 1000) / official : null;
    const vWatch = lap.dist ? lap.dist / lap.dur : null;
    const spm = avg(rr.map((r) => (r.spm > 100 ? r.spm : null)));
    const power = avg(rr.map((r) => (r.power > 0 ? r.power : null)));
    const corrected = power && vTrue && vWatch ? power * (vTrue / vWatch) : null;
    const hr = avg(rr.map((r) => r.hr));
    return {
      name: `Run ${k + 1}`, lap: lap.i, official, watchTime: lap.dur, watchDist: lap.dist,
      laps: lap.laps, pace: official ? official / runKm : null, kmh: vTrue ? vTrue * 3.6 : null,
      hr, hrLate: avg(rr.slice(-60).map((r) => r.hr)), hrMax: Math.max(...rr.map((r) => r.hr || 0)) || null,
      spm, step: vTrue && spm ? vTrue / (spm / 60) : null,
      watchPower: power, power: corrected, hrPer100W: hr && corrected ? (hr / corrected) * 100 : null,
    };
  });
  // A run much quicker than the others is usually a short timing-mat layout
  // (Run 1 at DC); keep it on the page but out of comparisons.
  const times = runs.map((r) => r.official).filter(Boolean).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  for (const r of runs) r.suspect = !!(r.official && median && r.official < 0.85 * median);

  const stations = STATIONS.map((name, k) => {
    const lap = match.stations[k];
    const rr = lap ? inLap(fit.records, lap) : [];
    return {
      name, lap: lap?.i ?? null, laps: lap?.laps ?? [], official: splits.stations[name] ?? null, watchTime: lap?.dur ?? null,
      hr: lap ? avg(rr.map((r) => r.hr)) : null, hrMax: lap ? Math.max(...rr.map((r) => r.hr || 0)) || null : null,
      hrReliable: !WRIST_HR_UNRELIABLE.has(name),
    };
  });

  const sum = (xs) => (xs.every((x) => x != null) ? xs.reduce((a, b) => a + b, 0) : null);
  return {
    match, runs, stations, runKm,
    totals: { runs: sum(runs.map((r) => r.official)), stations: sum(stations.map((s) => s.official)), roxzone: splits.roxzone },
    insights: insights(runs),
  };
}

// Plain-language findings from the comparable runs (not suspect, all values).
export function insights(runs) {
  // Runs 2-7 only: Run 1 and Run 8 have timing-mat and course quirks.
  const ok = runs.slice(1, 7).filter((r) => !r.suspect && r.official && r.spm && r.step);
  if (ok.length < 3) return [];
  const out = [];
  const fast = ok.reduce((a, b) => (b.official < a.official ? b : a));
  const slow = ok.reduce((a, b) => (b.official > a.official ? b : a));
  const dStep = (fast.step - slow.step) / slow.step, dSpm = (fast.spm - slow.spm) / slow.spm;
  out.push(`Fastest comparable run: ${fast.name} (${clock(fast.official)}); slowest: ${slow.name} (${clock(slow.official)}). ` +
    `${fast.name} had ${Math.abs(dStep * 100).toFixed(0)}% ${dStep >= 0 ? 'longer' : 'shorter'} steps and ${Math.abs(dSpm * 100).toFixed(0)}% ${dSpm >= 0 ? 'higher' : 'lower'} cadence, ` +
    `so the speed came mostly from ${Math.abs(dStep) >= Math.abs(dSpm) ? 'stride length' : 'cadence'}.`);
  const withHr = ok.filter((r) => r.hrPer100W);
  if (withHr.length >= 3) {
    const v = withHr.map((r) => r.hrPer100W);
    out.push(`Heart rate per 100 W ranged ${Math.min(...v).toFixed(1)}–${Math.max(...v).toFixed(1)} beats across comparable runs; ` +
      `a run well above the rest cost more heart rate for its pace, often from the station before it.`);
  }
  const late = ok.filter((r) => r.hrLate).reduce((a, b) => (b.hrLate > a.hrLate ? b : a), ok[0]);
  if (late?.hrLate) out.push(`Highest late-run heart rate: ${late.name}, ${Math.round(late.hrLate)} bpm over its last minute.`);
  return out;
}

// ---------- comparing races ----------

// Run fade: Run 7 pace vs Run 2 pace, in %. Run 1 and Run 8 are left out
// (timing mats and course quirks, e.g. Boston's Run 8 included a walk into
// the wall ball zone). Positive = slowed down. Relative, so a course whose run
// lap isn't exactly 1 km doesn't change it.
export function fadePct(runs) {
  const r2 = runs[1]?.official, r7 = runs[6]?.official;
  return r2 && r7 ? ((r7 - r2) / r2) * 100 : null;
}

// Each run's time as a ratio to the race's own Runs 2-7 average (1.00 = its
// average pace; above 1 = slower). Comparable between courses of any length.
export function relativeRuns(runs) {
  const mid = runs.slice(1, 7).map((r) => r.official).filter(Boolean);
  const avgMid = mid.length ? mid.reduce((a, b) => a + b, 0) / mid.length : null;
  return runs.map((r) => (r.official && avgMid ? r.official / avgMid : null));
}

// What's saved on the device for a race: its results only (never the raw file,
// heart rate trace or GPS).
export function summarise(a, meta) {
  const keepRun = ['name', 'official', 'pace', 'kmh', 'hr', 'hrLate', 'hrMax', 'spm', 'step', 'power', 'watchPower', 'hrPer100W', 'suspect', 'lap', 'laps', 'watchTime', 'watchDist'];
  const keepStation = ['name', 'official', 'hr', 'hrMax', 'hrReliable', 'lap', 'laps', 'watchTime'];
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
  return {
    v: 1, ...meta, runKm: a.runKm, savedAt: new Date().toISOString(),
    matchOk: a.match.ok, totals: a.totals, insights: a.insights, fade: fadePct(a.runs),
    runs: a.runs.map((r) => pick(r, keepRun)), stations: a.stations.map((s) => pick(s, keepStation)),
  };
}

// Plain-language findings across 2-3 saved races (in the order given).
export function compareInsights(races) {
  if (races.length < 2) return [];
  const out = [];
  const total = (r) => (r.totals.runs ?? 0) + (r.totals.stations ?? 0) + (r.totals.roxzone ?? 0);
  const runsRox = (r) => (r.totals.runs ?? 0) + (r.totals.roxzone ?? 0);
  const [base, ...rest] = races;
  for (const r of rest) {
    const d = total(r) - total(base), dRun = runsRox(r) - runsRox(base), dSt = (r.totals.stations ?? 0) - (base.totals.stations ?? 0);
    const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + clock(Math.abs(x));
    out.push(`${r.name} vs ${base.name}: ${sign(d)} overall: runs + Roxzone ${sign(dRun)}, stations ${sign(dSt)}.` +
      (Math.abs(dSt) > Math.abs(dRun) ? ' The stations explain most of the difference.' : ' The runs explain most of the difference.'));
  }
  const fades = races.filter((r) => r.fade != null);
  if (fades.length >= 2) out.push(`Run fade (Run 2 → Run 7): ${fades.map((r) => `${r.name} ${r.fade >= 0 ? '+' : ''}${r.fade.toFixed(1)}%`).join(', ')}. Lower means steadier pacing.`);
  const divs = new Set(races.map((r) => r.division));
  if (divs.size > 1) out.push('These races include Open and Pro: Pro stations are heavier (sleds, lunges, wall balls), so compare stations with care. Runs are comparable.');
  // Biggest single-station gap between first and each other race.
  for (const r of rest) {
    const gaps = r.stations.map((s, k) => [s.name, (s.official ?? 0) - (base.stations[k]?.official ?? 0)]).filter(([, g]) => g);
    if (!gaps.length) continue;
    const [name, g] = gaps.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
    out.push(`Biggest station difference, ${r.name} vs ${base.name}: ${name} ${g > 0 ? '+' : '−'}${clock(Math.abs(g))}.`);
  }
  return out;
}

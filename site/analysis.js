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
 */

export const STATIONS = ['SkiErg', 'Sled Push', 'Sled Pull', 'Burpee Broad Jumps', 'Row', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls'];
// Wrist HR during these stations shows smooth decay / cadence lock, not real HR.
export const WRIST_HR_UNRELIABLE = new Set(['SkiErg', 'Sled Push', 'Burpee Broad Jumps', 'Sandbag Lunges']);
const RUN_KM = 1;

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

// Official splits from pasted text: a CSV like "Run 1,run,3:39,219" or lines
// copied from the results page ("Run 1  3:39", "SkiErg 00:04:35"). Takes the
// first time on each line whose name is a run, a station or Roxzone.
// Returns { runs: [8 seconds|null], stations: { name: seconds }, roxzone }.
export function parseSplits(text) {
  const out = { runs: Array(8).fill(null), stations: {}, roxzone: null };
  for (const line of String(text).split(/\r?\n/)) {
    const time = line.split(/[\s,;\t|]+/).map(toSeconds).find((x) => x != null);
    if (time == null) continue;
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
export function matchLaps(laps) {
  const runs = laps.filter((l) => l.dur > 150 && l.cadence >= 75).slice(0, 8);
  const stations = runs.map((r, k) => {
    const end = k + 1 < runs.length ? runs[k + 1].i : Infinity;
    const between = laps.filter((l) => l.i > r.i && l.i < end);
    return between.length ? between.reduce((a, b) => (b.dur > a.dur ? b : a)) : null;
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
  const match = matchLaps(fit.laps);
  const runs = match.runs.map((lap, k) => {
    const rr = inLap(fit.records, lap);
    const official = splits.runs[k];
    const vTrue = official ? (RUN_KM * 1000) / official : null;
    const vWatch = lap.dist ? lap.dist / lap.dur : null;
    const spm = avg(rr.map((r) => (r.spm > 100 ? r.spm : null)));
    const power = avg(rr.map((r) => (r.power > 0 ? r.power : null)));
    const corrected = power && vTrue && vWatch ? power * (vTrue / vWatch) : null;
    const hr = avg(rr.map((r) => r.hr));
    return {
      name: `Run ${k + 1}`, lap: lap.i, official, watchTime: lap.dur, watchDist: lap.dist,
      pace: official ? official / RUN_KM : null, kmh: vTrue ? vTrue * 3.6 : null,
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
      name, lap: lap?.i ?? null, official: splits.stations[name] ?? null, watchTime: lap?.dur ?? null,
      hr: lap ? avg(rr.map((r) => r.hr)) : null, hrMax: lap ? Math.max(...rr.map((r) => r.hr || 0)) || null : null,
      hrReliable: !WRIST_HR_UNRELIABLE.has(name),
    };
  });

  const sum = (xs) => (xs.every((x) => x != null) ? xs.reduce((a, b) => a + b, 0) : null);
  return {
    match, runs, stations,
    totals: { runs: sum(runs.map((r) => r.official)), stations: sum(stations.map((s) => s.official)), roxzone: splits.roxzone },
    insights: insights(runs),
  };
}

// Plain-language findings from the comparable runs (not suspect, all values).
export function insights(runs) {
  const ok = runs.filter((r) => !r.suspect && r.official && r.spm && r.step);
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

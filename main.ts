// gta6-trophy-rarity-forecast-01: forecast each GTA VI PS5 trophy's Exophase earn rate
// at the case's target, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95), from the
// house's recorded reads of the trophy page up to the case's checkpoint.
//
// Model: two views of the same dynamics, averaged in logit space.
//   (A) A saturating curve. Each trophy's rate is fitted as
//       r(t) = R - (R - r_first) * exp(-lam * (t - t_first)) over the last
//       36 h of reads, by a deterministic grid search over (R, lam): R is the
//       rate the trophy settles at, lam how fast it gets there. A rate cannot
//       keep rising forever — most players never do a given piece of content —
//       so a saturating shape beats an unbounded trend for a 4.5-day horizon.
//       The fit is read at the target.
//   (B) A log-time trend. logit(rate) is fitted by least squares against
//       ln(1 + hours since release) over the last 36 h of reads and read at the
//       target, the move from the last rate clamped to 1.0 logit units.
// The median is the weighted mean of the two in logit space (0.7 saturating,
// 0.3 trend); the saturating fit is the physically grounded one, the trend
// is the hedge.
// The spread starts at the random-walk width (0.5 logit per sqrt day, the house
// baseline's) and widens with the two models' disagreement.
//
// Special cases: a trophy at 100% in the last read keeps a narrow band near 100
// (it survived a six-fold growth of tracked players at 100% on launch night);
// a trophy never earned yet takes a tier prior with a wide spread.
//
// Node 22, standard library only, no network, deterministic: everything is a
// pure function of the case file, so two runs write the same bytes.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at LEVELS. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, logit units per square-root day. */
const SIGMA = 0.5;
/** Weight of the saturating fit in the median (trend takes the rest). */
const W_SIM = 0.7;
/** Hours of history used to fit the saturating curve and the trend. */
const TREND_WINDOW_H = 36;
/** Largest logit move the trend fit may claim from the last rate. */
const TREND_CLAMP = 1.0;
/** Extra spread floor, and the spread's cap, in logit units. */
const SPREAD_FLOOR = 0.1;
const SPREAD_CAP = 1.3;
const SPREAD_MIN = 0.25;
/** Quantiles for a trophy at 100% in the last read. */
const HUNDRED_BAND = [99.9, 99.97, 99.99, 100, 100];
/** Day-7 median rate (percent) for a trophy never earned yet, by tier. */
const TIER_PRIOR: Record<string, number> = {
  platinum: 0.04,
  gold: 0.08,
  silver: 0.15,
  bronze: 0.3,
};
const TIER_PRIOR_SPREAD = 1.3;

interface Trophy {
  id: number;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Least squares y = a + b*x; returns [a, b]. */
const ols = (xs: number[], ys: number[]): [number, number] => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return [my - b * mx, b];
};

interface Series {
  /** Hours since release for each usable read. */
  t: number[];
  /** Tracked players at each read. */
  n: number[];
  /** Earn rates (percent) at each read; null where the read lacked the trophy. */
  r: Array<number | null>;
}

/** Build the usable series for one trophy: reads with a time and a player count. */
function series(c: Case, idx: number, releaseMs: number): Series {
  const t: number[] = [];
  const n: number[] = [];
  const r: Array<number | null> = [];
  for (const read of c.history) {
    const ms = Date.parse(read.at);
    if (Number.isNaN(ms) || !(read.players_tracked > 0)) continue;
    t.push((ms - releaseMs) / 3_600_000);
    n.push(read.players_tracked);
    r.push(read.rates[idx] ?? null);
  }
  return { t, n, r };
}

/** Saturating-curve fit r(t) = R - (R - r_first) * exp(-lam * (t - t_first)),
 *  anchored at the first read of the fitting window and grid-searched over
 *  (R, lam); read at the target. Falls back to the last rate when too few
 *  usable reads. The anchor matters: a rate is already above zero at the
 *  window's start, so a curve forced through the origin would invent growth
 *  from flat data. */
function saturatingRate(s: Series, windowH: number, tTarget: number, rLast: number): number {
  const lastT = s.t[s.t.length - 1];
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < s.t.length; i++) {
    const r = s.r[i];
    if (r === null || r <= 0 || r >= 100) continue;
    if (s.t[i] < lastT - windowH) continue;
    pts.push([Math.max(0, s.t[i]), r]);
  }
  if (pts.length < 3) return rLast;
  const tFirst = pts[0][0];
  const rFirst = pts[0][1];
  const rMults = [0.3, 0.5, 0.7, 0.85, 1.0, 1.05, 1.15, 1.3, 1.5, 1.8, 2.2, 2.8, 3.5, 5, 7, 10];
  const lams: number[] = [];
  for (let k = 0; k < 20; k++) lams.push(0.0005 * Math.pow(600, k / 19));
  let best: [number, number] = [rLast, Infinity];
  for (const m of rMults) {
    const R = Math.min(99.5, Math.max(0.01, rFirst * m));
    for (const lam of lams) {
      let sse = 0;
      for (const [t, r] of pts) {
        const pred = R - (R - rFirst) * Math.exp(-lam * (t - tFirst));
        sse += (pred - r) * (pred - r);
      }
      if (sse < best[1]) {
        best = [R - (R - rFirst) * Math.exp(-lam * (tTarget - tFirst)), sse];
      }
    }
  }
  return Math.min(99.5, Math.max(0.01, best[0]));
}

/** Logit-log-time trend read at the target, clamped to a move from the last rate. */
function trendRate(s: Series, windowH: number, tTarget: number, rLast: number): number {
  const lastT = s.t[s.t.length - 1];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < s.t.length; i++) {
    const r = s.r[i];
    if (r === null || r <= 0 || r >= 100) continue;
    if (s.t[i] < lastT - windowH) continue;
    xs.push(Math.log1p(Math.max(0, s.t[i])));
    ys.push(logit(r));
  }
  if (xs.length < 3) return rLast;
  const [a, b] = ols(xs, ys);
  const lLast = logit(rLast);
  const lPred = a + b * Math.log1p(Math.max(0, tTarget));
  const lClamped = Math.min(lLast + TREND_CLAMP, Math.max(lLast - TREND_CLAMP, lPred));
  return invLogit(lClamped);
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const releaseMs = Date.parse(c.game.release_date ?? '') || Date.parse(c.history[0]?.at ?? c.at);
  const targetMs = Date.parse(c.target);
  const lastRead = c.history[c.history.length - 1];
  const tLast = (Date.parse(lastRead?.at ?? c.at) - releaseMs) / 3_600_000;
  const tTarget = (targetMs - releaseMs) / 3_600_000;
  const dDays = Math.max(0, c.horizon_minutes / 1440);
  const baseSpread = SIGMA * Math.sqrt(dDays);

  return c.trophies.map((trophy, idx) => {
    const s = series(c, idx, releaseMs);
    const rLast = lastRead?.rates[idx] ?? null;

    // No usable history at all: fall back to the tier prior.
    if (s.t.length === 0 || rLast === null) {
      const m = logit(TIER_PRIOR[trophy.tier] ?? 0.15);
      return { id: trophy.id, q: Z.map((z) => round4(invLogit(m + z * TIER_PRIOR_SPREAD))) };
    }
    // A trophy every tracked player holds: keep a narrow band near 100.
    if (rLast >= 99.99) return { id: trophy.id, q: [...HUNDRED_BAND] };

    const rSat = saturatingRate(s, TREND_WINDOW_H, tTarget, rLast);

    // (B) Log-time trend.
    const rTrend = trendRate(s, TREND_WINDOW_H, tTarget, rLast);

    // A trophy never earned yet: tier prior, wide spread.
    const everEarned = s.r.some((r) => r !== null && r > 0);
    if (!everEarned) {
      const m = logit(TIER_PRIOR[trophy.tier] ?? 0.15);
      return { id: trophy.id, q: Z.map((z) => round4(invLogit(m + z * TIER_PRIOR_SPREAD))) };
    }

    const lSat = logit(rSat);
    const lTrend = logit(rTrend);
    const m = W_SIM * lSat + (1 - W_SIM) * lTrend;
    const disagree = Math.abs(lSat - lTrend);
    const spread = Math.min(
      SPREAD_CAP,
      Math.max(SPREAD_MIN, Math.sqrt(baseSpread * baseSpread + (0.25 * disagree) ** 2 + SPREAD_FLOOR ** 2)),
    );
    const q = Z.map((z) => round4(Math.min(100, Math.max(0.01, invLogit(m + z * spread)))));
    // Enforce non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: trophy.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}

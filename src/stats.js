'use strict';
/* ============================================================
 * STC 시뮬레이터 — 통계 유틸 (stats.js)
 * 시간가중 누적기 · 고정빈 히스토그램 · 시계열 빈 · t분위/95% CI ·
 * 반복(rep) 결과 집계 · CSV
 * ============================================================ */
const STCStats = (() => {

  // ---------- 시간가중 누적기 ----------
  // set(t, v): 시각 t부터 값 v. mean(tEnd): [tStart, tEnd] 평균. reset(t): 통계 시작점 재설정.
  class TimeWeighted {
    constructor(t0, v0) { this.reset(t0 || 0); this.v = v0 || 0; }
    reset(t) { this.t0 = t; this.tLast = t; this.area = 0; this.max = this.v || 0; }
    set(t, v) {
      if (t < this.tLast) throw new Error('TimeWeighted: 시간 역행');
      this.area += this.v * (t - this.tLast);
      this.tLast = t; this.v = v;
      if (v > this.max) this.max = v;
    }
    mean(tEnd) {
      const span = tEnd - this.t0;
      if (!(span > 0)) return this.v;
      return (this.area + this.v * (tEnd - this.tLast)) / span;
    }
  }

  // ---------- 상태 시간 누적 (크레인 상태별) ----------
  class StateClock {
    constructor(states, t0, initial) {
      this.states = states.slice();
      this.time = {}; for (const s of states) this.time[s] = 0;
      this.cur = initial; this.tLast = t0 || 0;
    }
    enter(t, state) {
      if (t < this.tLast) throw new Error('StateClock: 시간 역행');
      this.time[this.cur] += t - this.tLast;
      this.tLast = t; this.cur = state;
    }
    reset(t) { for (const s of this.states) this.time[s] = 0; this.tLast = t; }
    snapshot(tEnd) {
      const out = {}; for (const s of this.states) out[s] = this.time[s];
      out[this.cur] += tEnd - this.tLast;
      return out;
    }
  }

  // ---------- 고정빈 히스토그램 (마지막 빈 = overflow) ----------
  class Hist {
    constructor(binSize, maxVal) {
      if (!(binSize > 0) || !(maxVal > 0)) throw new Error('Hist: binSize, maxVal 양수');
      this.binSize = binSize; this.maxVal = maxVal;
      this.n = Math.ceil(maxVal / binSize);
      this.counts = new Array(this.n + 1).fill(0);
      this.count = 0; this.sum = 0; this.sumSq = 0; this.min = Infinity; this.max = -Infinity;
    }
    add(x) {
      const i = x >= this.maxVal ? this.n : Math.max(0, Math.floor(x / this.binSize));
      this.counts[i]++; this.count++; this.sum += x; this.sumSq += x * x;
      if (x < this.min) this.min = x; if (x > this.max) this.max = x;
    }
    reset() { this.counts.fill(0); this.count = 0; this.sum = 0; this.sumSq = 0; this.min = Infinity; this.max = -Infinity; }
    mean() { return this.count ? this.sum / this.count : 0; }
    sd() {
      if (this.count < 2) return 0;
      const m = this.mean();
      return Math.sqrt(Math.max(0, (this.sumSq - this.count * m * m) / (this.count - 1)));
    }
    toJSON() { return { binSize: this.binSize, maxVal: this.maxVal, counts: this.counts.slice(), count: this.count, mean: this.mean(), sd: this.sd(), min: this.count ? this.min : 0, max: this.count ? this.max : 0 }; }
  }

  // ---------- 분위수 (정렬 배열, 선형보간) ----------
  function quantile(sorted, q) {
    const n = sorted.length;
    if (!n) return 0;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.min(lo + 1, n - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // ---------- t 분포 97.5% 분위 (양측 95%) ----------
  const T975 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
    40: 2.021, 60: 2.000, 120: 1.980,
  };
  function tInv95(df) {
    if (!(df >= 1)) return NaN;
    if (T975[df] !== undefined) return T975[df];
    if (df > 120) return 1.960 + (1.980 - 1.960) * (120 / df);   // 1/df 보간 (∞ → 1.960)
    const keys = Object.keys(T975).map(Number).sort((a, b) => a - b);
    let lo = keys[0], hi = keys[keys.length - 1];
    for (const k of keys) { if (k <= df) lo = k; if (k >= df) { hi = k; break; } }
    if (lo === hi) return T975[lo];
    const w = (1 / df - 1 / hi) / (1 / lo - 1 / hi);           // 1/df 선형보간
    return T975[hi] + (T975[lo] - T975[hi]) * w;
  }

  // ---------- 표본 요약 ----------
  function summarize(arr) {
    const xs = arr.filter(x => Number.isFinite(x));
    const n = xs.length;
    if (!n) return { n: 0, mean: NaN, sd: NaN, ci95: NaN, min: NaN, max: NaN };
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const ci95 = n > 1 ? tInv95(n - 1) * sd / Math.sqrt(n) : 0;
    return { n, mean, sd, ci95, min: Math.min(...xs), max: Math.max(...xs) };
  }

  // ---------- 객체 평탄화: 숫자 잎만, id 배열은 id로 키잉 ----------
  const SKIP = new Set(['hist', 'ts', 'schema', 'scenarioId', 'meta']);
  function flatten(obj, prefix, out) {
    out = out || {};
    for (const [k, v] of Object.entries(obj)) {
      if (SKIP.has(k)) continue;
      const key = prefix ? prefix + '.' + k : k;
      if (typeof v === 'number') out[key] = v;
      else if (typeof v === 'boolean') out[key] = v ? 1 : 0;
      else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const it = v[i];
          if (it && typeof it === 'object') flatten(it, key + '.' + (it.id !== undefined ? it.id : i), out);
        }
      } else if (v && typeof v === 'object') flatten(v, key, out);
    }
    return out;
  }

  // ---------- rep 집계: 같은 시나리오의 rep 결과 배열 → {metric: {n, mean, sd, ci95}} ----------
  function aggregateReps(reps) {
    const flats = reps.map(r => flatten(r));
    const keys = new Set(); for (const f of flats) for (const k of Object.keys(f)) keys.add(k);
    const agg = {};
    for (const k of keys) agg[k] = summarize(flats.map(f => f[k]).filter(x => x !== undefined));
    // 히스토그램 합산 (같은 빈 정의 가정)
    const histSum = {};
    for (const r of reps) if (r.hist) for (const [name, h] of Object.entries(r.hist)) {
      if (!h || !h.counts) continue;
      if (!histSum[name]) histSum[name] = { binSize: h.binSize, maxVal: h.maxVal, counts: h.counts.slice(), count: h.count };
      else { const s = histSum[name]; for (let i = 0; i < s.counts.length; i++) s.counts[i] += h.counts[i] || 0; s.count += h.count; }
    }
    // 시계열 평균 (같은 빈 수 가정)
    const tsMean = {};
    const tsAll = reps.map(r => r.ts).filter(Boolean);
    if (tsAll.length) {
      const first = tsAll[0];
      tsMean.binSec = first.binSec;
      const avgArr = (getter) => {
        const arrs = tsAll.map(getter).filter(Boolean);
        if (!arrs.length) return [];
        const n = Math.min(...arrs.map(a => a.length));
        const out = new Array(n).fill(0);
        for (const a of arrs) for (let i = 0; i < n; i++) out[i] += a[i] / arrs.length;
        return out;
      };
      for (const key of Object.keys(first)) {
        if (key === 'binSec') continue;
        if (Array.isArray(first[key])) tsMean[key] = avgArr(t => t[key]);
        else if (first[key] && typeof first[key] === 'object') {
          tsMean[key] = {};
          for (const sub of Object.keys(first[key])) tsMean[key][sub] = avgArr(t => t[key] && t[key][sub]);
        }
      }
    }
    return { n: reps.length, agg, histSum, tsMean };
  }

  // ---------- CSV (UTF-8 BOM은 호출측에서 접두) ----------
  function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(6).replace(/\.?0+$/, '')) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows, columns) {
    const cols = columns || Object.keys(rows[0] || {});
    const lines = [cols.map(c => csvEscape(typeof c === 'string' ? c : c.label)).join(',')];
    for (const r of rows) lines.push(cols.map(c => csvEscape(typeof c === 'string' ? r[c] : c.get(r))).join(','));
    return '﻿' + lines.join('\r\n');
  }

  return { version: '0.1.0', TimeWeighted, StateClock, Hist, quantile, tInv95, summarize, flatten, aggregateReps, csvEscape, toCsv };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCStats;

'use strict';
/* ============================================================
 * STC 시뮬레이터 — 최적화기 (optimizer.js) — 순수 함수, 실행은 runner가 담당
 *   zoningOptions(sc)      : 랙 기하에서 조닝 후보 생성 (single / x2@bay k / y2@level k / x3)
 *   stationVariants()      : 스테이션 변형 (asis / addOutRight / outLift)
 *   enumerate(base, space) : 설계공간 → 설계별 시나리오 (검증·중복 제거·해석식 사전값)
 *   evaluate(agg, targets) : 집계 결과 → 실행가능 판정 + 사유
 *   rank(rows)             : 사전식 순위 (총 크레인 수 → 실행가능 → 최대 busy → 평균 대기) + Pareto
 *   plan(rows, opt)        : 2단계 스크리닝 작업 목록
 * ============================================================ */
const STCOptimizer = (() => {
  const V = (typeof STCValidate !== 'undefined') ? STCValidate : require('./validate.js');
  const Fem = (typeof STCFem !== 'undefined') ? STCFem : require('./fem9851.js');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- 조닝 후보 ----------
  function extents(sc) {
    const rk = sc.rack;
    const xs = [rk.x0, rk.x0 + rk.length, ...sc.stations.map(s => s.x), ...sc.cranes.flatMap(c => c.zone.x)];
    const ys = [0, rk.height, ...sc.stations.map(s => s.y), ...sc.cranes.flatMap(c => c.zone.y)];
    return { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] };
  }
  function homeFor(sc, zone) {
    const inside = sc.stations.filter(s => V.inRect(zone, s.x, s.y));
    const h = inside.find(s => s.kind === 'in') || inside[0];
    return h ? { home: h.id, x0: h.x, y0: h.y } : { home: null, x0: zone.x[0], y0: zone.y[0] };
  }
  function makeCranes(sc, rects, prefix) {
    return rects.map((z, i) => ({ id: `${prefix}${i + 1}`, zone: z, ...homeFor(sc, z) }));
  }
  function zoningOptions(sc) {
    const ext = extents(sc);
    const { bayX, levelY } = V.cellCoords(sc.rack);
    const opts = [{ key: 'single', label: '1존 (크레인 1대)', cranes: [{ id: 'STC1', zone: { x: ext.x.slice(), y: ext.y.slice() }, ...homeFor(sc, { x: ext.x, y: ext.y }) }] }];
    for (let k = 1; k < bayX.length; k++) {
      const mid = (bayX[k - 1] + bayX[k]) / 2;
      const rects = [{ x: [ext.x[0], mid], y: ext.y.slice() }, { x: [mid, ext.x[1]], y: ext.y.slice() }];
      opts.push({ key: `x2@bay${k}`, label: `좌/우 2존 (bay ${k}|${k + 1} 경계, x=${mid.toFixed(2)} m)`, cranes: makeCranes(sc, rects, 'STC_X') });
    }
    for (let k = 1; k < levelY.length; k++) {
      const mid = (levelY[k - 1] + levelY[k]) / 2;
      const rects = [{ x: ext.x.slice(), y: [ext.y[0], mid] }, { x: ext.x.slice(), y: [mid, ext.y[1]] }];
      opts.push({ key: `y2@level${k}`, label: `상/하 2존 (level ${k}|${k + 1} 경계, y=${mid.toFixed(2)} m)`, cranes: makeCranes(sc, rects, 'STC_Y') });
    }
    if (bayX.length >= 3) {
      const a = Math.floor(bayX.length / 3), b = Math.floor(2 * bayX.length / 3);
      const m1 = (bayX[a - 1] + bayX[a]) / 2, m2 = (bayX[b - 1] + bayX[b]) / 2;
      const rects = [{ x: [ext.x[0], m1], y: ext.y.slice() }, { x: [m1, m2], y: ext.y.slice() }, { x: [m2, ext.x[1]], y: ext.y.slice() }];
      opts.push({ key: 'x3', label: `좌/중/우 3존 (x=${m1.toFixed(2)}, ${m2.toFixed(2)} m)`, cranes: makeCranes(sc, rects, 'STC_X') });
    }
    return opts;
  }

  // ---------- 스테이션 변형 ----------
  // addOutRight: 기존 출고 스테이션을 반대편 x 끝에 복제(우측 타워 출고). 출고 수요는 존별 입고 비중으로 재배분.
  // outLift: 출고 스테이션 높이를 0으로 (전용 리프트가 상승 담당 → 크레인 승강 leg 제거)
  function stationVariants() {
    return [
      { key: 'asis', label: '현행 배치', apply: (sc) => sc },
      { key: 'addOutRight', label: '반대편 출고 스테이션 추가', apply: (sc) => {
        const outs = sc.stations.filter(s => s.kind === 'out');
        if (!outs.length) return sc;
        const xs = sc.stations.map(s => s.x);
        const xL = Math.min(...xs), xR = Math.max(...xs);
        for (const o of outs) {
          const mirrorX = Math.abs(o.x - xL) < Math.abs(o.x - xR) ? xR : xL;
          if (sc.stations.some(s => s.kind === 'out' && Math.abs(s.x - mirrorX) < 1e-6 && Math.abs(s.y - o.y) < 1e-6)) continue;
          const m = clone(o); m.id = o.id + '_M'; m.name = (o.name || o.id) + ' (추가)'; m.x = mirrorX;
          m.arrival = { ...(o.arrival || {}), ratePerHour: 0 };   // 수요는 rebalanceOut 이 존별 입고 비중으로 배분
          sc.stations.push(m);
        }
        return sc;
      } },
      { key: 'outLift', label: '출고 전용 리프트 (출고 ST y→0)', apply: (sc) => {
        for (const s of sc.stations) if (s.kind === 'out') s.y = 0;
        return sc;
      } },
    ];
  }

  // 출고 수요 재배분: 각 출고 스테이션에 그 존의 입고 비중만큼 (같은 존에 여럿이면 균등)
  function rebalanceOut(sc) {
    const outs = sc.stations.filter(s => s.kind === 'out' && s.arrival && s.arrival.ratePerHour !== undefined);
    if (outs.length < 2) return sc;
    const total = outs.reduce((a, s) => a + (s.arrival.ratePerHour || 0), 0);
    const zoneIn = sc.cranes.map(c => sc.stations.filter(s => s.kind === 'in' && V.inRect(c.zone, s.x, s.y)).reduce((a, s) => a + ((s.arrival && s.arrival.ratePerHour) || 0), 0));
    const zoneOutCount = sc.cranes.map(c => outs.filter(s => V.inRect(c.zone, s.x, s.y)).length);
    const inSum = zoneIn.reduce((a, b) => a + b, 0);
    if (!(inSum > 0)) return sc;
    let assigned = 0;
    for (const s of outs) {
      const zi = V.zoneOf(sc.cranes, s.x, s.y);
      const share = zi >= 0 && zoneOutCount[zi] > 0 ? (zoneIn[zi] / inSum) / zoneOutCount[zi] : 0;
      s.arrival.ratePerHour = Math.round(total * share * 100) / 100; assigned += s.arrival.ratePerHour;
    }
    // 반올림 잔차는 첫 스테이션에
    if (Math.abs(assigned - total) > 1e-9) outs[0].arrival.ratePerHour = Math.round((outs[0].arrival.ratePerHour + total - assigned) * 100) / 100;
    return sc;
  }

  const DEFAULT_SPACE = {
    zoning: ['single'], stationsVariant: ['asis'],
    mode: ['SC-return', 'DC'], pairing: ['nearest'], priority: ['oldest-first'], storageRule: ['closest-open'],
    parallelAisles: [1, 2, 3],
  };

  // ---------- 설계공간 열거 ----------
  function enumerate(base, space) {
    space = { ...DEFAULT_SPACE, ...(space || {}) };
    const zonings = zoningOptions(base);
    const variants = stationVariants();
    const rows = [];
    const seen = new Set();
    for (const zk of space.zoning) for (const vk of space.stationsVariant) for (const mode of space.mode)
      for (const pairing of space.pairing) for (const priority of space.priority) for (const storageRule of space.storageRule)
        for (const k of space.parallelAisles) {
          const pair = mode === 'DC' ? pairing : 'fifo';               // DC 아니면 pairing 무의미 → 중복 제거
          const key = [zk, vk, mode, pair, priority, storageRule, k].join('|');
          if (seen.has(key)) continue; seen.add(key);
          const z = zonings.find(o => o.key === zk); const v = variants.find(o => o.key === vk);
          if (!z || !v) continue;
          let sc = clone(base);
          sc.cranes = clone(z.cranes);
          sc = v.apply(sc);
          // 변형으로 추가된 스테이션의 home 갱신
          sc.cranes = sc.cranes.map(c => ({ ...c, ...homeFor(sc, c.zone) }));
          sc = rebalanceOut(sc);
          sc.policy = { ...sc.policy, mode, pairing: pair, priority, storageRule };
          sc.parallelAisles = k;
          const design = { zoning: zk, zoningLabel: z.label, stationsVariant: vk, variantLabel: v.label, mode, pairing: pair, priority, storageRule, parallelAisles: k, cranesPerAisle: sc.cranes.length, totalCranes: sc.cranes.length * k };
          const name = `${z.label.split(' ')[0]} · ${v.label} · ${mode}${mode === 'DC' ? '/' + pair : ''} · ${priority} · ${storageRule} · 통로 ${k}`;
          sc.name = name;
          const val = V.validate(sc);
          let prefilter = null;
          try { const f = Fem.rev0(sc); prefilter = { U: f.U, Usc: f.scOnly.U, tAvg: f.tAvg }; } catch (e) { prefilter = null; }
          rows.push({ id: key, design, scenario: sc, valid: val.ok, invalidReason: val.errors.join(' / '), warnings: val.warnings, prefilter, stage: 0, result: null, feasible: null, reasons: [], rank: null, pareto: false });
        }
    return rows;
  }

  // ---------- 판정 ----------
  function pick(agg, prefix, suffix) {
    const out = [];
    for (const k of Object.keys(agg)) if (k.startsWith(prefix) && k.endsWith(suffix)) out.push(agg[k].mean);
    return out;
  }
  function evaluate(agg, targets) {
    targets = { rhoMax: 0.8, maxQueue: 3, doneRatioMin: 0.98, queueTrendMax: 1.5, ...(targets || {}) };
    const reasons = [];
    const g = (k) => (agg[k] ? agg[k].mean : NaN);
    const doneRatio = g('throughput.doneRatio');
    const busy = Math.max(...pick(agg, 'cranes.', '.busy'), 0);
    const meanQ = Math.max(...pick(agg, 'stations.', '.meanQueue'), 0);
    const trend = g('flags.queueTrend');
    const unserv = g('jobs.unservable');
    const blocked = g('flags.storageBlocked');
    const viol = g('flags.zoneViolations');
    if (!(doneRatio >= targets.doneRatioMin)) reasons.push(`달성률 ${(doneRatio * 100).toFixed(1)}% < ${(targets.doneRatioMin * 100).toFixed(0)}%`);
    if (!(busy <= targets.rhoMax)) reasons.push(`최대 가동률 ${(busy * 100).toFixed(1)}% > 목표 ${(targets.rhoMax * 100).toFixed(0)}%`);
    if (!(trend < targets.queueTrendMax)) reasons.push(`대기열 증가 추세 ×${trend.toFixed(2)}`);
    if (!(meanQ <= targets.maxQueue)) reasons.push(`평균 대기열 ${meanQ.toFixed(1)} > ${targets.maxQueue}`);
    if (unserv > 0) reasons.push(`처리 불가 작업 ${unserv.toFixed(1)}건`);
    if (blocked > 0) reasons.push('저장 블로킹(빈 셀 없음) 발생');
    if (viol > 0) reasons.push('존 이탈');
    const meanWait = (() => { const w = pick(agg, 'stations.', '.meanWait'); return w.length ? w.reduce((a, b) => a + b, 0) / w.length : NaN; })();
    return { feasible: reasons.length === 0, reasons, metrics: { doneRatio, busy, meanQ, trend, meanWait, unserv } };
  }

  function shortReason(s) {
    if (/달성률/.test(s)) return "달성률 미달"; if (/가동률/.test(s)) return "가동률 초과"; if (/증가 추세/.test(s)) return "대기열 증가";
    if (/평균 대기열/.test(s)) return "대기열 상한"; if (/처리 불가/.test(s)) return "처리 불가"; if (/블로킹/.test(s)) return "저장 블로킹"; if (/존 이탈/.test(s)) return "존 이탈";
    return s.split(" ")[0];
  }

  // ---------- 순위·Pareto ----------
  function rank(rows) {
    const evald = rows.filter(r => r.result);
    evald.sort((a, b) =>
      (a.design.totalCranes - b.design.totalCranes) ||
      ((b.feasible ? 1 : 0) - (a.feasible ? 1 : 0)) ||
      ((a.metrics ? a.metrics.busy : 9) - (b.metrics ? b.metrics.busy : 9)) ||
      ((a.metrics ? a.metrics.meanWait : 9e9) - (b.metrics ? b.metrics.meanWait : 9e9)));
    evald.forEach((r, i) => { r.rank = i + 1; r.pareto = false; });
    const feas = evald.filter(r => r.feasible && r.metrics && Number.isFinite(r.metrics.meanWait));
    for (const r of feas) {
      r.pareto = !feas.some(o => o !== r && o.design.totalCranes <= r.design.totalCranes && o.metrics.meanWait <= r.metrics.meanWait &&
        (o.design.totalCranes < r.design.totalCranes || o.metrics.meanWait < r.metrics.meanWait));
    }
    const best = feas.length ? feas.reduce((b, r) => (r.rank < b.rank ? r : b)) : null;
    // 하위 N이 실패한 사유 요약
    const byN = {};
    for (const r of evald) { const n = r.design.totalCranes; if (!byN[n]) byN[n] = { total: 0, feasible: 0, reasons: {} }; byN[n].total++; if (r.feasible) byN[n].feasible++; for (const s of r.reasons) { const k = shortReason(s); byN[n].reasons[k] = (byN[n].reasons[k] || 0) + 1; } }
    return { rows: evald, best, byN };
  }

  // ---------- 2단계 스크리닝 계획 ----------
  function plan(rows, opt) {
    opt = { stage1Reps: 5, stage2Reps: 30, topK: 5, seedBase: 12345, ...(opt || {}) };
    const valid = rows.filter(r => r.valid);
    const stage1 = [];
    for (const r of valid) for (let rep = 0; rep < opt.stage1Reps; rep++) stage1.push({ rowId: r.id, rep, seed: opt.seedBase + rep });
    return { stage1, stage2For: (ranked) => {
      const top = ranked.slice(0, opt.topK);
      const jobs = [];
      for (const r of top) for (let rep = opt.stage1Reps; rep < opt.stage2Reps; rep++) jobs.push({ rowId: r.id, rep, seed: opt.seedBase + rep });
      return jobs;
    } };
  }

  return { version: '0.1.0', DEFAULT_SPACE, zoningOptions, stationVariants, rebalanceOut, enumerate, evaluate, rank, plan, extents, homeFor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCOptimizer;

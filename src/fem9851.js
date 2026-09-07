'use strict';
/* ============================================================
 * STC 시뮬레이터 — FEM 9.851 해석식 (fem9851.js)
 * 두 가지 방법을 제공한다. 이동시간은 모두 STCKin(→ MHKernel)으로 계산해
 * 시뮬레이션과 같은 물리 모델을 쓴다 (해석식 vs 시뮬 차이 = 순수 DES 효과).
 *
 *  1) standard(inp) — fem9851\stc_calculator.py `calculate()` 이식.
 *     입력 단위 mm / m/min (원본과 동일 필드명). Case 1~6, Single/Double Deep, One/Twin Fork.
 *  2) rev0(scenario) — 계산서 Rev.0 "FEM 9.851 준용" 방법: P1·P2는 랙 벽면(x0..x0+L, 0..H)에 두고
 *     각 leg의 이동은 실제 E/A 좌표에서 측정, 복합사이클에 공차 복귀 leg(A→차기 E)를 가산.
 * ============================================================ */
const STCFem = (() => {
  const K = (typeof MHKernel !== 'undefined') ? MHKernel : require('./kernel.js');
  const Kin = (typeof STCKin !== 'undefined') ? STCKin : require('./kin.js');

  // ---------- 1) 표준 방법 (stc_calculator.py 이식) ----------
  // SpeedSpec{high(m/min), low(m/min), acc(m/s²), low_dist(mm), jerk_time, ctrl_delay, comm_delay, pos_delay}
  function specToAxis(sp) {
    return {
      v: (+sp.high) / 60, a: +sp.acc, d: +sp.acc,
      creepDist: (sp.low_dist > 0 ? +sp.low_dist : 0) / 1000,
      creepV: sp.low > 0 ? (+sp.low) / 60 : 0,
      tDelay: (+sp.jerk_time || 0) + (+sp.ctrl_delay || 0) + (+sp.comm_delay || 0),
    };
  }

  function p1p2(inp) {
    const L = inp.travel_length, H = inp.lift_length;
    const p1b = [L / 5, 2 * H / 3], p2b = [2 * L / 3, H / 5];
    const c = +inp.case_type;
    if (c === 5) { const yA = inp.a_y || 0; return { P1: [p1b[0], p1b[1] + yA / 2], P2: [p2b[0], p2b[1] + yA / 2] }; }
    if (c === 6) { const yE = inp.e_y || 0; return { P1: [p1b[0], p1b[1] + yE / 2], P2: [p2b[0], p2b[1] + yE / 2] }; }
    if (c === 3) {
      const yE = inp.e_y || 0;
      if (yE <= H / 2) return { P1: [p1b[0], p1b[1] + yE], P2: [p2b[0], p2b[1] + yE] };
      return { P1: [p1b[0], H - p1b[1] + (yE - H / 2)], P2: [p2b[0], H - p2b[1] + (yE - H / 2)] };
    }
    if (c === 4) {
      const xE = inp.e_x || 0;
      if (xE <= L / 2) return { P1: [p1b[0] + xE, p1b[1]], P2: [p2b[0] + xE, p2b[1]] };
      return { P1: [L - p1b[0] + (xE - L / 2), p1b[1]], P2: [L - p2b[0] + (xE - L / 2), p2b[1]] };
    }
    return { P1: p1b, P2: p2b };
  }

  function reallocation(inp) {
    const xF = inp.travel_length / Math.max(inp.bay_count, 1);
    const yF = inp.lift_length / Math.max(inp.tier_count, 1);
    const f = Math.sqrt(1 / Math.max(1 - inp.alpha, 1e-9));
    return { xF, yF, dx1: xF * f / 10, dy1: yF * f / 3, dx2: xF * f / 3, dy2: yF * f / 10 };
  }

  function standard(inp) {
    const tr = new Kin.AxisModel(specToAxis(inp.travel));
    const ho = new Kin.AxisModel(specToAxis(inp.hoist));
    const fk = new Kin.AxisModel(specToAxis(inp.fork));
    const tPos = Math.max(+inp.travel.pos_delay || 0, +inp.hoist.pos_delay || 0);
    const t03 = inp.t03 !== undefined ? +inp.t03 : 4.0;
    const t04 = inp.t04 !== undefined ? +inp.t04 : 4.0;
    const t05 = inp.t05 !== undefined ? +inp.t05 : 12.0;
    // chebyshev_time: max(tx, ty) + positioning (원본은 거리 0이어도 positioning 가산)
    const cheb = (dxmm, dymm) => K.chebyshev(tr.time(Math.abs(dxmm) / 1000), ho.time(Math.abs(dymm) / 1000), tPos);
    const forkCycle = (strokeMm, liftMm) => fk.time(strokeMm / 1000) * 2 + fk.time(liftMm / 1000);

    const geom = p1p2(inp);
    const P1 = geom.P1, P2 = geom.P2;
    const E = [inp.e_x || 0, inp.e_y || 0], A = [inp.a_x || 0, inp.a_y || 0];
    const tP1E = cheb(P1[0] - E[0], P1[1] - E[1]);
    const tP2E = cheb(P2[0] - E[0], P2[1] - E[1]);
    const tP1A = cheb(P1[0] - A[0], P1[1] - A[1]);
    const tP2A = cheb(P2[0] - A[0], P2[1] - A[1]);
    const tP1_P2 = cheb(P2[0] - P1[0], P2[1] - P1[1]);
    const tA_E = cheb(A[0] - E[0], A[1] - E[1]);

    const isDouble = inp.fork_depth === 'Double Deep';
    const tLHD_E = forkCycle(inp.stroke_single, inp.lift_stroke);
    const tLHD_ET = tLHD_E;
    const tLHD_ZT = isDouble ? forkCycle(inp.stroke_double, inp.lift_stroke) : tLHD_ET;

    const off = reallocation(inp);
    const tF = 0.5 * (cheb(off.dx1, off.dy1) + cheb(off.dx2, off.dy2));
    const tREL = isDouble ? 2 * tF + tLHD_ET + tLHD_ZT : 0;

    const tm1E = 0.5 * (2 * tP1E + 2 * tP2E) + tLHD_E + 0.5 * (tLHD_ET + tLHD_ZT) + t03;
    const tm1A = 0.5 * (2 * tP1A + 2 * tP2A) + tLHD_E + 0.5 * (tLHD_ET + tLHD_ZT) + 0.5 * tREL + t04;
    const tm1 = 0.5 * (tm1E + tm1A);
    const bt = (et, zt) => tLHD_E + tP1E + et + tP1_P2 + zt + tP2A + tLHD_E;
    const tm2 = 0.25 * bt(tLHD_ET, tLHD_ET) + 0.5 * bt(tLHD_ET, tLHD_ZT) + 0.25 * bt(tLHD_ZT, tLHD_ZT) + 0.5 * tREL + t05;

    const twin = inp.fork_count === 'Twin Fork';
    const ppc = twin ? 2 : 1;
    const in_total = (+inp.in_full || 0) + (+inp.in_empty || 0);
    const out_total = (+inp.out_full || 0) + (+inp.out_empty || 0);
    const combined_pal = Math.min(in_total, out_total) * (+inp.combined_ratio || 0);
    const single_in_pal = in_total - combined_pal;
    const single_out_pal = out_total - combined_pal;
    const combined_count = combined_pal / ppc;
    const single_in = single_in_pal / ppc;
    const single_out = single_out_pal / ppc;
    const rel_count = out_total / ppc;
    const sum_combined = combined_count * tm2;
    const sum_in = single_in * tm1E;
    const sum_out = single_out * tm1A;
    const sum_rel = rel_count * tA_E;
    const total_time = sum_combined + sum_in + sum_out + sum_rel;
    const n = Math.max(1, +inp.n_stc || 1);
    const base_time = 3600 * n;
    const efficiency = total_time / base_time;
    const margin = 3600 * (+inp.av || 0.85) * n - total_time;

    return {
      geom: { E, A, P1, P2 }, off,
      tP1E, tP2E, tP1A, tP2A, tP1_P2, tA_E, tLHD_E, tLHD_ET, tLHD_ZT, tF, tREL,
      tm1E, tm1A, tm1, tm2, twin, in_total, out_total, combined_count, single_in, single_out,
      sum_in, sum_out, sum_combined, sum_rel, total_time, base_time, efficiency, margin, pallets_per_cycle: ppc,
      t03, t04, t05, tPos,
    };
  }

  // ---------- 2) Rev.0 준용 방법 (시나리오 좌표계 m) ----------
  // scenario.rack {x0, length, height}, crane {axes, fork, tPos, availability}, stations[{id, kind, x, y, arrival.ratePerHour}]
  function rev0(scenario, opt) {
    opt = opt || {};
    const rk = scenario.rack, cr = scenario.crane;
    const models = Kin.makeModels(cr.axes);
    const fc = Kin.forkCycle(cr.fork).t;
    const tPos = +cr.tPos || 0;
    const eta = opt.availability !== undefined ? +opt.availability : (cr.availability !== undefined ? +cr.availability : 1.0);
    const P1 = { x: rk.x0 + rk.length / 5, y: 2 * rk.height / 3 };
    const P2 = { x: rk.x0 + 2 * rk.length / 3, y: rk.height / 5 };
    const leg = (p, q) => Kin.legTime(p, q, models);
    const rate = (s) => (s.arrival && s.arrival.ratePerHour > 0) ? +s.arrival.ratePerHour : 0;
    const k = Math.max(1, Math.round(scenario.parallelAisles || 1));

    const stations = scenario.stations.map(s => {
      const tP1 = leg(s, P1), tP2 = leg(s, P2);
      return { id: s.id, name: s.name, kind: s.kind, x: s.x, y: s.y, rate: rate(s) / k,
               tP1, tP2, tm1: tP1 + tP2 + 2 * fc + 2 * tPos };      // 단독사이클(왕복) — E/A 기준
    });
    const ins = stations.filter(s => s.kind === 'in' && s.rate > 0);
    const outs = stations.filter(s => s.kind === 'out' && s.rate > 0);
    const inTotal = ins.reduce((a, s) => a + s.rate, 0);
    const outTotal = outs.reduce((a, s) => a + s.rate, 0);

    // 복합사이클: 입고 스트림 E × 출고 스테이션 A (복수면 출고율 비례 배분), 복귀 leg는 A → 같은 E
    // Rev.0 관행: 입고 스트림 전량을 쌍으로 계상 (입고 > 출고인 잔여분은 "근사 처리" — 쌍에 포함).
    // 출고 > 입고인 초과분만 출고 단독사이클로 가산한다.
    const dc = [];
    for (const e of ins) {
      for (const a of outs) {
        const share = outTotal > 0 ? a.rate / outTotal : 0;
        const pairs = e.rate * share;                                   // 쌍/h
        const legs = { eP1: leg(e, P1), p1p2: leg(P1, P2), p2A: leg(P2, a), ret: leg(a, e) };
        const t = legs.eP1 + legs.p1p2 + legs.p2A + 4 * fc + 4 * tPos + legs.ret;
        dc.push({ inId: e.id, outId: a.id, pairs, legs, t, transfers: 4 * fc, aux: 4 * tPos });
      }
    }
    const pairsTotal = dc.reduce((a, d) => a + d.pairs, 0);
    const D_dc = dc.reduce((a, d) => a + d.pairs * d.t, 0);
    const residualIn = Math.max(0, inTotal - outTotal), residualOut = Math.max(0, outTotal - inTotal);
    const tm1OutAvg = outTotal > 0 ? outs.reduce((a, s) => a + s.rate * s.tm1, 0) / outTotal : 0;
    const D_res = residualOut * tm1OutAvg;
    const D = D_dc + D_res;
    const tAvg = pairsTotal > 0 ? D_dc / pairsTotal : 0;
    const S = 3600 * eta;
    const U = S > 0 ? D / S : Infinity;
    const capacityPairs = tAvg > 0 ? S / tAvg : Infinity;
    const fulfillment = pairsTotal > 0 ? capacityPairs / pairsTotal : 1;
    // 단독 전용 운영 (참고): 모든 이동을 단독사이클로
    const D_sc = ins.reduce((a, s) => a + s.rate * s.tm1, 0) + outs.reduce((a, s) => a + s.rate * s.tm1, 0);
    return {
      method: 'FEM 9.851 준용 (Rev.0)', P1, P2, forkCycle: fc, tPos, eta, parallelAisles: k,
      stations, dc, inTotal, outTotal, pairsTotal, residualIn, residualOut,
      D_dc, D_res, D, tAvg, S, U, N: U, capacityPairs, fulfillment,
      scOnly: { D: D_sc, U: S > 0 ? D_sc / S : Infinity, moves: inTotal + outTotal },
    };
  }

  return { version: '0.1.0', specToAxis, p1p2, reallocation, standard, rev0 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCFem;

'use strict';
const fs = require('fs');
const path = require('path');
const Fem = require('./fem9851.js');
const Presets = require('./presets.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. 표준 방법: Python stc_calculator.py 골든값 (clean 사양) 1e-6 ----------
{
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fem9851.golden.json'), 'utf8'));
  ok(golden.cases.length >= 10, '골든 케이스 수');
  const FIELDS = ['tP1E', 'tP2E', 'tP1A', 'tP2A', 'tP1_P2', 'tA_E', 'tLHD_E', 'tLHD_ET', 'tLHD_ZT', 'tF', 'tREL',
    'tm1E', 'tm1A', 'tm1', 'tm2', 'combined_count', 'single_in', 'single_out', 'sum_in', 'sum_out', 'sum_combined', 'sum_rel',
    'total_time', 'base_time', 'efficiency', 'margin', 'pallets_per_cycle'];
  for (const c of golden.cases) {
    const inp = c.input;
    const spec = (s) => ({ high: s.high, low: 0, acc: s.acc, low_dist: 0, jerk_time: 0, ctrl_delay: 0, comm_delay: 0, pos_delay: 0 });
    const r = Fem.standard({ ...inp, travel: spec(inp.travel), hoist: spec(inp.hoist), fork: spec(inp.fork) });
    near(r.geom.P1[0], c.result.P1[0], 1e-6, `${c.name} P1.x`); near(r.geom.P1[1], c.result.P1[1], 1e-6, `${c.name} P1.y`);
    near(r.geom.P2[0], c.result.P2[0], 1e-6, `${c.name} P2.x`); near(r.geom.P2[1], c.result.P2[1], 1e-6, `${c.name} P2.y`);
    for (const f of FIELDS) near(r[f], c.result[f], 1e-6 * Math.max(1, Math.abs(c.result[f])), `${c.name} ${f}`);
  }
}

// ---------- 2. 표준 방법: 저속·지연 포함 사양은 커널 물리(정합 프로파일)로 계산됨 — 값 존재·단조 ----------
{
  const base = {
    travel_length: 20000, lift_length: 20000, bay_count: 20, tier_count: 10, alpha: 0.95, av: 0.85,
    fork_depth: 'Single Deep', fork_count: 'One Fork', stroke_single: 1400, stroke_double: 2800, lift_stroke: 110,
    travel: { high: 100, low: 5, acc: 0.3, low_dist: 250, jerk_time: 1.0, ctrl_delay: 1.16, comm_delay: 0.5, pos_delay: 0.5 },
    hoist: { high: 30, low: 5, acc: 0.5, low_dist: 150, jerk_time: 1.0, ctrl_delay: 1.58, comm_delay: 0.5, pos_delay: 0.5 },
    fork: { high: 30, low: 5, acc: 0.5, low_dist: 100, jerk_time: 0, ctrl_delay: 0.3, comm_delay: 0.5, pos_delay: 0 },
    in_full: 50, in_empty: 0, out_full: 50, out_empty: 0, combined_ratio: 0, case_type: 1, e_x: 0, e_y: 0, a_x: 0, a_y: 0, n_stc: 1,
  };
  const r = Fem.standard(base);
  ok(r.tm1E > 0 && r.tm2 > r.tm1E && Number.isFinite(r.efficiency), '지연 포함 사양 계산');
  const clean = Fem.standard({ ...base,
    travel: { ...base.travel, low: 0, low_dist: 0, jerk_time: 0, ctrl_delay: 0, comm_delay: 0, pos_delay: 0 },
    hoist: { ...base.hoist, low: 0, low_dist: 0, jerk_time: 0, ctrl_delay: 0, comm_delay: 0, pos_delay: 0 },
    fork: { ...base.fork, low: 0, low_dist: 0, jerk_time: 0, ctrl_delay: 0, comm_delay: 0, pos_delay: 0 } });
  ok(r.tm1E > clean.tm1E && r.tm2 > clean.tm2, '저속·지연은 사이클을 늘린다');
  near(r.tA_E, 0.5, 1e-12, 'E=A 이면 tA_E = positioning (원본 동일)');
}

// ---------- 3. Rev.0 준용 방법: 계산서 표 재현 ----------
{
  const sc = Presets.carBodyRev0();
  const r = Fem.rev0(sc);
  near(r.P1.x, 8.825, 1e-9, 'P1.x = x0+L/5'); near(r.P1.y, 12.67 * 2 / 3, 1e-9, 'P1.y = 2H/3');
  near(r.P2.x, 3.175 + 28.25 * 2 / 3, 1e-9, 'P2.x'); near(r.P2.y, 12.67 / 5, 1e-9, 'P2.y');
  near(r.forkCycle, 8.0, 1e-12, 't_ü = 8.0 (override)');
  const byIn = Object.fromEntries(r.dc.map(d => [d.inId, d]));
  // DC-A E_L0 → A_L8: 11.8 + 11.5 + 14.3 + 32 + 4 + 11.3 = 84.9
  near(byIn.E_L0.legs.eP1, 11.8, 0.05, 'DC-A E→P1');
  near(byIn.E_L0.legs.p1p2, 11.5, 0.05, 'DC-A P1→P2');
  near(byIn.E_L0.legs.p2A, 14.3, 0.05, 'DC-A P2→A');
  near(byIn.E_L0.legs.ret, 11.3, 0.05, 'DC-A 공차 복귀');
  near(byIn.E_L0.t, 84.9, 0.1, 'DC-A 합계 84.9');
  near(byIn.E_R8.legs.eP1, 15.6, 0.05, 'DC-B E→P1'); near(byIn.E_R8.legs.ret, 18.1, 0.05, 'DC-B 복귀');
  near(byIn.E_R8.t, 95.5, 0.1, 'DC-B 합계 95.5');
  near(byIn.E_R0.t, 95.5, 0.1, 'DC-C 합계 95.5');
  near(byIn.E_L0.pairs, 68, 1e-9, 'DC-A 68쌍/h'); near(byIn.E_R8.pairs, 22, 1e-9, 'DC-B 22쌍/h'); near(byIn.E_R0.pairs, 3, 1e-9, 'DC-C 3쌍/h');
  near(r.pairsTotal, 93, 1e-9, '계 93쌍/h (출고 92 초과분은 잔여 단독)');
  near(r.tAvg, 87.7, 0.1, '가중평균 87.7 s');
  near(r.D_dc, 8161, 8161 * 0.002, 'D = 8,161 s/h (±0.2%)');
  near(r.S, 3240, 1e-9, 'S = 3,600 × 0.9');
  near(r.U * 100, 252, 0.5, '이용률 252 %');
  near(r.capacityPairs, 36.9, 0.1, '1대 처리능력 36.9 쌍/h');
  near(r.fulfillment * 100, 39.7, 0.2, '충족률 39.7 %');
  near(r.N, 2.52, 0.01, '필요 대수 2.52');
  const st = Object.fromEntries(r.stations.map(s => [s.id, s]));
  near(st.E_L0.tm1, 44.1, 0.1, '입고 단독 44.1 s');
  near(st.A_L8.tm1, 40.9, 0.1, '출고 단독 40.9 s');
  // 잔여: 입고 93 − 출고 92 = 1 JPH — Rev.0 관행대로 쌍에 포함(근사), 별도 보고만
  near(r.residualIn, 1, 1e-9, '잔여 입고 1 JPH 보고');
  near(r.D, r.D_dc, 1e-9, '입고 초과분은 쌍에 포함 (D = D_dc)');
  // 출고 초과 케이스: 초과분은 출고 단독으로 가산
  const scO = Presets.carBodyRev0(); scO.stations.find(s => s.id === 'A_L8').arrival.ratePerHour = 100;
  const rO = Fem.rev0(scO);
  near(rO.residualOut, 7, 1e-9, '출고 초과 7 JPH');
  near(rO.D - rO.D_dc, 7 * 40.88, 0.5, '출고 초과분 × 출고 단독 40.9 s');
  // 통로 3개: 수요 ÷ 3 → U ≈ 84 %
  const r3 = Fem.rev0({ ...sc, parallelAisles: 3 });
  near(r3.U, r.U / 3, 1e-9, 'parallelAisles=3 → U/3');
  ok(r3.U < 0.9, '통로 3개면 η=0.9 내 (0.84)');
  // 가동률 옵션
  const r1 = Fem.rev0(sc, { availability: 1.0 });
  near(r1.U * 100, 227, 0.6, 'η=1.0 → 227 % (계산서 감도 검토)');
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

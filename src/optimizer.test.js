'use strict';
const O = require('./optimizer.js');
const P = require('./presets.js');
const E = require('./engine.js');
const S = require('./stats.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. 조닝 후보 ----------
{
  const sc = P.carBodyRev0();
  const z = O.zoningOptions(sc);
  ok(z.length === 1 + 4 + 5 + 1, `조닝 후보 수 ${z.length} = 1+4+5+1`);
  const x2 = z.find(o => o.key === 'x2@bay3');
  near(x2.cranes[0].zone.x[1], (17.3 + 22.95) / 2, 1e-9, 'x2@bay3 경계 = bay3|4 중점');
  ok(x2.cranes[0].home === 'E_L0' && x2.cranes[1].home === 'E_R8', 'home = 존 내 첫 입고 스테이션');
  const y2 = z.find(o => o.key === 'y2@level3');
  near(y2.cranes[0].zone.y[1], (3.92 + 6.77) / 2, 1e-9, 'y2@level3 경계');
  const x3 = z.find(o => o.key === 'x3');
  ok(x3.cranes.length === 3, 'x3 3존');
}

// ---------- 2. 스테이션 변형 + 출고 재배분 ----------
{
  const sc = P.carBodyRev0();
  const vs = O.stationVariants();
  const add = vs.find(v => v.key === 'addOutRight').apply(JSON.parse(JSON.stringify(sc)));
  ok(add.stations.length === 5 && add.stations[4].id === 'A_L8_M' && add.stations[4].x === 33.1 && add.stations[4].y === 8, '우측 출고 추가');
  const lift = vs.find(v => v.key === 'outLift').apply(JSON.parse(JSON.stringify(sc)));
  ok(lift.stations.find(s => s.id === 'A_L8').y === 0, 'outLift: 출고 y=0');
  // x2 조닝 + addOutRight → 재배분: 좌 68/(68+25)·92, 우 25/93·92
  const x2 = O.zoningOptions(sc).find(o => o.key === 'x2@bay3');
  add.cranes = x2.cranes;
  O.rebalanceOut(add);
  const L = add.stations.find(s => s.id === 'A_L8').arrival.ratePerHour, R = add.stations.find(s => s.id === 'A_L8_M').arrival.ratePerHour;
  near(L + R, 92, 1e-6, '출고 합 92 유지');
  near(L, 92 * 68 / 93, 0.02, '좌 출고 = 입고 비중');
}

// ---------- 3. 열거·중복 제거·유효성 ----------
{
  const sc = P.carBodyRev0();
  const rows = O.enumerate(sc, { zoning: ['single', 'x2@bay3', 'y2@level3'], stationsVariant: ['asis', 'addOutRight'], mode: ['SC-return', 'DC'], pairing: ['fifo', 'nearest'], priority: ['oldest-first'], storageRule: ['closest-open'], parallelAisles: [1, 3] });
  // mode SC-return은 pairing 무의미 → (SC 1 + DC 2) = 3 조합 × 3 zoning × 2 variant × 2 aisles = 36
  ok(rows.length === 36, `열거 ${rows.length} (중복 제거 후 36)`);
  const asisX2 = rows.filter(r => r.design.zoning === 'x2@bay3' && r.design.stationsVariant === 'asis');
  ok(asisX2.every(r => !r.valid && /반출 불가/.test(r.invalidReason)), 'as-is x2는 전부 무효(사유 포함)');
  const addX2 = rows.filter(r => r.design.zoning === 'x2@bay3' && r.design.stationsVariant === 'addOutRight');
  ok(addX2.every(r => r.valid), 'addOutRight x2는 유효');
  const y2asis = rows.filter(r => r.design.zoning === 'y2@level3' && r.design.stationsVariant === 'asis');
  ok(y2asis.every(r => !r.valid), 'as-is y2 무효');
  ok(rows.every(r => r.prefilter && r.prefilter.U > 0), '해석식 사전값');
  ok(rows.find(r => r.design.zoning === 'single' && r.design.parallelAisles === 3).design.totalCranes === 3, '통로 3 = 총 3대');
  const ids = new Set(rows.map(r => r.id)); ok(ids.size === rows.length, 'id 유일');
}

// ---------- 4. evaluate / rank / plan (소규모 실제 실행) ----------
{
  const sc = P.carBodyRev0(); sc.run.durationSec = 4 * 3600; sc.run.warmupSec = 1800;
  const rows = O.enumerate(sc, { zoning: ['single'], stationsVariant: ['asis'], mode: ['DC'], pairing: ['nearest'], priority: ['oldest-first'], storageRule: ['closest-open'], parallelAisles: [1, 2, 3] });
  const pl = O.plan(rows, { stage1Reps: 2, stage2Reps: 4, topK: 2 });
  ok(pl.stage1.length === 6, 'stage1 = 3 설계 × 2 rep');
  const byRow = {};
  for (const j of pl.stage1) { const r = rows.find(x => x.id === j.rowId); (byRow[r.id] = byRow[r.id] || []).push(E.runScenario(r.scenario, { rep: j.rep, seed: j.seed })); }
  for (const r of rows) { const a = S.aggregateReps(byRow[r.id]); r.result = a; const ev = O.evaluate(a.agg, r.scenario.targets); r.feasible = ev.feasible; r.reasons = ev.reasons; r.metrics = ev.metrics; }
  const one = rows.find(r => r.design.parallelAisles === 1), three = rows.find(r => r.design.parallelAisles === 3);
  ok(!one.feasible && one.reasons.some(s => /달성률/.test(s)), '통로 1: 불가 (달성률)');
  ok(three.feasible, '통로 3: 실행가능 ' + three.reasons.join(' / '));
  const rk = O.rank(rows);
  ok(rk.best && rk.best.design.totalCranes <= 3, '최적 = 최소 대수 실행가능');
  ok(rk.rows[0].rank === 1 && rk.rows.every((r, i) => r.rank === i + 1), '순위 부여');
  ok(rk.best.pareto, '최적해는 Pareto');
  const s2 = pl.stage2For(rk.rows);
  ok(s2.length === 2 * 2 && s2.every(j => j.rep >= 2), 'stage2 = top2 × rep 2..3');
  ok(rk.byN[1] && rk.byN[1].feasible === 0, '하위 N 실패 요약');
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

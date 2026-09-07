'use strict';
const E = require('./engine.js');
const P = require('./presets.js');
const Fem = require('./fem9851.js');
const Kin = require('./kin.js');
const V = require('./validate.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }
function rel(x, y, tolRel, name) { ok(Math.abs(x - y) <= tolRel * Math.abs(y), name + ` (got ${x.toFixed(3)}, want ${y.toFixed(3)} ±${(tolRel * 100).toFixed(1)}%)`); }
const t0 = Date.now();

// Math.random 사용 감시 — 엔진은 절대 호출하지 않아야 한다
const realRandom = Math.random;
Math.random = () => { throw new Error('엔진이 Math.random을 호출했습니다'); };

// ---------- 1. 결정성 ----------
{
  const sc = P.carBodyRev0(); sc.run.durationSec = 3 * 3600; sc.run.warmupSec = 1800;
  const a = JSON.stringify(E.runScenario(sc, { rep: 0 }));
  const b = JSON.stringify(E.runScenario(sc, { rep: 0 }));
  ok(a === b, '같은 seed → 결과 동일');
  const c = JSON.stringify(E.runScenario(sc, { rep: 1 }));
  ok(a !== c, '다른 rep → 결과 상이');
}

// ---------- 2. 보존식 + 상태 시간 합 + 존 불변식 ----------
{
  const sc = P.carBodyRev0(); sc.run.durationSec = 4 * 3600;
  const sim = new E.Sim(sc, { rep: 2, debug: true });
  for (let t = 600; t <= sc.run.durationSec; t += 600) {
    sim.advanceTo(t);
    const pend = sim.pendingCount(), prog = sim.inProgressCount();
    ok(sim.jobs.createdAll === sim.jobs.doneAll + pend + prog, `보존식 t=${t}: ${sim.jobs.createdAll} = ${sim.jobs.doneAll}+${pend}+${prog}`);
    for (const c of sim.cranes) {
      const p = sim.cranePos(c);
      ok(V.inRect(c.zone, p.x, p.y), `보간 위치 존 내 t=${t}`);
    }
  }
  const r = sim.result();
  for (const c of r.cranes) {
    const sum = Object.values(c.stateTime).reduce((a, b) => a + b, 0);
    near(sum, 1, 1e-9, `상태 시간 합 = 1 (${c.id})`);
    ok(c.cellsOcc + c.cellsEmpty <= c.cellsTotal, '셀 카운터 정합');
  }
  ok(r.flags.zoneViolations === 0, '존 이탈 0');
  const occ = sim.cells.filter(c => c.state === E.OCC).length;
  ok(occ === sim.cranes.reduce((n, c) => n + c.cellsOcc, 0), '점유 카운터 = 실제 점유 셀');
  const emp = sim.cells.filter(c => c.state === E.EMPTY).length;
  ok(emp === sim.cranes.reduce((n, c) => n + c.cellsEmpty, 0), '빈 카운터 = 실제 빈 셀');
}

// ---------- 3. 스텝 전진 == 일괄 실행 ----------
{
  const sc = P.carBodyRev0(); sc.run.durationSec = 2 * 3600; sc.run.warmupSec = 600;
  const s1 = new E.Sim(sc, { rep: 3 });
  for (let t = 1; t <= sc.run.durationSec; t += 1) s1.advanceTo(t);
  const a = JSON.stringify(s1.result());
  const b = JSON.stringify(new E.Sim(sc, { rep: 3 }).run());
  ok(a === b, '1 s 스텝 전진 결과 == run()');
}

// ---------- 4. 검증 오류 → 생성 실패 ----------
{
  const sc = P.carBodyRev0();
  sc.cranes = [
    { id: 'L', zone: { x: [0, 20], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'R', zone: { x: [20, 34.6], y: [0, 12.67] }, home: 'E_R0', x0: 33.1, y0: 0 },
  ];
  let msg = '';
  try { new E.Sim(sc); } catch (e) { msg = e.message; }
  ok(/반출 불가/.test(msg), '출고 없는 존 → 생성 거부: ' + msg.slice(0, 60));
}

// ---------- 5. SC-return vs FEM 9.851 tm1 (대형 랙, PRD 5%) ----------
{
  const sc = P.largeRackValidation();
  const r = E.runScenario(sc, { rep: 0 });
  const fem = Fem.rev0(sc);
  const st = Object.fromEntries(fem.stations.map(s => [s.id, s]));
  ok(r.cranes[0].cycles.scIn > 300 && r.cranes[0].cycles.scOut > 300, `표본 수 scIn=${r.cranes[0].cycles.scIn} scOut=${r.cranes[0].cycles.scOut}`);
  rel(r.cranes[0].meanCycle.scIn, st.E.tm1, 0.05, 'SC-in 평균 vs tm1E (5%)');
  rel(r.cranes[0].meanCycle.scOut, st.A.tm1, 0.05, 'SC-out 평균 vs tm1A (5%)');
  ok(!r.flags.saturated && r.throughput.doneRatio > 0.95, '저부하: 비포화, doneRatio > 0.95');
  console.log(`  [검증] 대형 랙 SC-in ${r.cranes[0].meanCycle.scIn.toFixed(2)} s vs tm1E ${st.E.tm1.toFixed(2)} s (Δ ${((r.cranes[0].meanCycle.scIn / st.E.tm1 - 1) * 100).toFixed(2)}%)`);
}

// ---------- 6. DC(E=A) vs FEM tm2 (포화 운전으로 항상 쌍 형성) ----------
{
  const sc = P.largeRackValidation();
  sc.policy.mode = 'DC'; sc.policy.pairing = 'fifo';
  for (const s of sc.stations) s.arrival.ratePerHour = 60;
  sc.run.durationSec = 30 * 3600;
  const r = E.runScenario(sc, { rep: 0 });
  const fem = Fem.rev0(sc);
  const dcT = fem.dc[0].t;
  ok(r.cranes[0].cycles.dc > 500, `DC 표본 ${r.cranes[0].cycles.dc}`);
  rel(r.cranes[0].meanCycle.dc, dcT, 0.05, 'DC 평균 vs tm2 (5%)');
  ok(r.flags.saturated, '과부하 → saturated');
  console.log(`  [검증] 대형 랙 DC ${r.cranes[0].meanCycle.dc.toFixed(2)} s vs tm2 ${dcT.toFixed(2)} s (Δ ${((r.cranes[0].meanCycle.dc / dcT - 1) * 100).toFixed(2)}%)`);
}

// ---------- 7. Bozer & White: 셀 전수 열거 = 1 + b²/3, 시뮬 표본평균 = 열거 ----------
for (const b of [1, 0.5]) {
  const sc = P.bozerWhite(b);
  const models = Kin.makeModels(sc.crane.axes);
  const cells = V.buildCells(sc.rack);
  const Ept = { x: 0, y: 0 };
  const enumMean = cells.reduce((a, c) => a + 2 * Kin.legTime(Ept, c, models), 0) / cells.length;
  const T = Math.max(sc.rack.length / sc.crane.axes.x.v, sc.rack.height / sc.crane.axes.y.v);
  near(enumMean / T, 1 + b * b / 3, 1e-3, `B&W 열거 E(SC)/T b=${b}`);
  sc.run.durationSec = 100 * 3600; sc.run.warmupSec = 3600;
  const r = E.runScenario(sc, { rep: 0 });
  const n = r.cranes[0].cycles.scIn + r.cranes[0].cycles.scOut;
  const simMean = (r.cranes[0].meanCycle.scIn * r.cranes[0].cycles.scIn + r.cranes[0].meanCycle.scOut * r.cranes[0].cycles.scOut) / n;
  ok(n > 1500, `B&W 표본 ${n}`);
  rel(simMean, enumMean, 0.02, `B&W 시뮬 표본평균 vs 열거 b=${b} (2%)`);
  console.log(`  [검증] B&W b=${b}: 열거 ${enumMean.toFixed(3)} s, 시뮬 ${simMean.toFixed(3)} s, 이론 ${((1 + b * b / 3) * T).toFixed(3)} s`);
}

// ---------- 8. 차체 프리셋: 1대 포화 vs 통로 3개 ----------
{
  const sc = P.carBodyRev0();
  const r1 = E.runScenario(sc, { rep: 0 });
  ok(r1.flags.saturated, '1대 DC: saturated');
  ok(r1.throughput.doneRatio < 0.6, `1대 달성률 ${(r1.throughput.doneRatio * 100).toFixed(1)}% < 60%`);
  ok(r1.cranes[0].busy > 0.95, `1대 busy ${(r1.cranes[0].busy * 100).toFixed(1)}% > 95%`);
  const eL0 = r1.stations.find(s => s.id === 'E_L0');
  ok(eL0.blockedTime > 0 && eL0.backlogMax >= 1, `입고 스테이션 백로그(라인 정지 ${eL0.blockedTime.toFixed(0)} s, 최대 ${eL0.backlogMax})`);
  const fem = Fem.rev0(sc);
  rel(r1.cranes[0].meanCycle.dc, fem.tAvg, 0.10, `1대 DC 평균 ${r1.cranes[0].meanCycle.dc.toFixed(1)} s vs Rev.0 가중평균 87.7 s (10%)`);
  console.log(`  [검증] 차체 1대: DC ${r1.cranes[0].meanCycle.dc.toFixed(1)} s, 처리 ${r1.throughput.perHour.toFixed(1)} moves/h (요구 ${r1.throughput.demandPerHour}), 달성 ${(r1.throughput.doneRatio * 100).toFixed(1)}%`);
  const sc3 = P.carBodyRev0(); sc3.parallelAisles = 3;
  const r3 = E.runScenario(sc3, { rep: 0 });
  ok(!r3.flags.saturated, '통로 3개: 비포화');
  ok(r3.throughput.doneRatio > 0.97, `통로 3개 달성률 ${(r3.throughput.doneRatio * 100).toFixed(1)}%`);
  ok(r3.cranes[0].busy < 0.9, `통로 3개 busy ${(r3.cranes[0].busy * 100).toFixed(1)}%`);
  near(r3.throughput.demandPerHour, 185 / 3, 1e-9, '통로 3개 수요 ÷ 3');
  console.log(`  [검증] 차체 통로3: busy ${(r3.cranes[0].busy * 100).toFixed(1)}%, 평균 대기 in ${r3.stations[0].meanWait.toFixed(0)} s / out ${r3.stations[1].meanWait.toFixed(0)} s`);
}

// ---------- 9. 워밍업 리셋 ----------
{
  const sc = P.carBodyRev0(); sc.parallelAisles = 3; sc.run.warmupSec = 4 * 3600;
  const r = E.runScenario(sc, { rep: 0 });
  ok(r.jobs.done < r.jobs.doneAll && r.jobs.created < r.jobs.createdAll, '워밍업 이전 작업 제외');
  near(r.statSec, 4 * 3600, 1e-9, 'statSec = 4 h');
  ok(r.ts.done.length === Math.ceil(4 * 3600 / sc.run.tsBinSec), '시계열 빈 수');
  near(r.ts.done.reduce((a, b) => a + b, 0), r.jobs.done, 1e-9, '시계열 done 합 = jobs.done');
}

// ---------- 10. 우선순위: retrieval-first는 입고 대기를 늘린다 ----------
{
  const base = P.carBodyRev0(); base.parallelAisles = 2; base.policy.mode = 'SC-stay';
  const run = (prio) => { const sc = JSON.parse(JSON.stringify(base)); sc.policy.priority = prio; return E.runScenario(sc, { rep: 0 }); };
  const rf = run('retrieval-first'), sf = run('storage-first'), of = run('oldest-first');
  const inWait = (r) => r.stations.filter(s => s.kind === 'in').reduce((a, s) => a + s.meanWait * s.served, 0) / r.stations.filter(s => s.kind === 'in').reduce((a, s) => a + s.served, 0);
  const outWait = (r) => r.stations.find(s => s.kind === 'out').meanWait;
  ok(inWait(rf) > inWait(sf), `retrieval-first 입고 대기 ${inWait(rf).toFixed(0)} > storage-first ${inWait(sf).toFixed(0)}`);
  ok(outWait(sf) > outWait(rf), `storage-first 출고 대기 ${outWait(sf).toFixed(0)} > retrieval-first ${outWait(rf).toFixed(0)}`);
  ok(inWait(of) < inWait(rf) && outWait(of) < outWait(sf), 'oldest-first는 양쪽 극단 사이');
}

// ---------- 11. 도착 생성: takt 개수·poisson 개수 ----------
{
  const sc = P.carBodyRev0(); sc.parallelAisles = 3;
  const sim = new E.Sim(sc, { rep: 5 }); sim.run();
  const st = Object.fromEntries(sim.stations.map(s => [s.id, s]));
  near(st.E_L0.arrivalsAll, 68 / 3 * 8, 8, 'takt 68/3 × 8 h');
  near(st.A_L8.arrivalsAll, 92 / 3 * 8, 8, 'takt 92/3 × 8 h');
  ok(st.E_R0.arrivalsAll >= 2 && st.E_R0.arrivalsAll <= 20, `poisson 1/h × 8 h → ${st.E_R0.arrivalsAll}`);
}

// ---------- 12. 다존 (좌/우 + 우측 출고 추가) ----------
{
  const sc = P.carBodyRev0();
  sc.cranes = [
    { id: 'STC_L', zone: { x: [0, 20.1], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'STC_R', zone: { x: [20.1, 34.6], y: [0, 12.67] }, home: 'E_R0', x0: 33.1, y0: 0 },
  ];
  sc.stations.push({ id: 'A_R8', name: '우 출고', kind: 'out', x: 33.1, y: 8, capacity: 2, arrival: { type: 'takt', ratePerHour: 25, jitterPct: 10, minStock: 1 }, retrieval: 'any' });
  sc.stations.find(s => s.id === 'A_L8').arrival.ratePerHour = 67;
  const sim = new E.Sim(sc, { rep: 0, debug: true });
  const r = sim.run();
  ok(r.flags.zoneViolations === 0, '2존 이탈 0');
  ok(r.cranes.every(c => c.cycles.dc + c.cycles.scIn + c.cycles.scOut > 50), '두 크레인 모두 작업');
  const zc = sim.zoneCells.map(z => z.length);
  ok(zc[0] === 18 && zc[1] === 12, `존 셀 분배 ${zc.join('/')} (bay 1~3 | 4~5)`);
  for (const c of sim.cells) if (c.state === E.OCC) ok(c.zone === V.zoneOf(sim.cranes, c.x, c.y), '점유 셀 존 정합');
  console.log(`  [검증] 2존: L busy ${(r.cranes[0].busy * 100).toFixed(0)}% R busy ${(r.cranes[1].busy * 100).toFixed(0)}%, 달성 ${(r.throughput.doneRatio * 100).toFixed(1)}%`);
}

// ---------- 13. 정책 효과: DC nearest ≤ fifo, closest-open < random ----------
{
  const base = P.carBodyRev0(); base.parallelAisles = 3;
  const run = (patch) => { const sc = JSON.parse(JSON.stringify(base)); Object.assign(sc.policy, patch); return E.runScenario(sc, { rep: 0 }); };
  const fifo = run({ pairing: 'fifo' }), nearest = run({ pairing: 'nearest' });
  ok(nearest.cranes[0].meanCycle.dc <= fifo.cranes[0].meanCycle.dc + 0.5, `DC nearest ${nearest.cranes[0].meanCycle.dc.toFixed(1)} ≤ fifo ${fifo.cranes[0].meanCycle.dc.toFixed(1)}`);
  const scR = run({ mode: 'SC-stay', storageRule: 'random-empty' }), scC = run({ mode: 'SC-stay', storageRule: 'closest-open' });
  ok(scC.cranes[0].meanCycle.scIn < scR.cranes[0].meanCycle.scIn, `closest-open SC-in ${scC.cranes[0].meanCycle.scIn.toFixed(1)} < random ${scR.cranes[0].meanCycle.scIn.toFixed(1)}`);
}

// ---------- 14. 애니메이션 보간: 이동 중 위치가 시작·끝 사이, 포크 신장률 0..1 ----------
{
  const sc = P.carBodyRev0();
  const sim = new E.Sim(sc, { rep: 0 });
  let sawMove = false, sawFork = false, okPos = true, okFork = true;
  for (let t = 0; t < 1800; t += 0.5) {
    sim.advanceTo(t);
    const c = sim.cranes[0];
    if (c.act && c.act.kind === 'move') {
      sawMove = true;
      const p = sim.cranePos(c), f = c.act.mv.from, to = c.act.mv.to;
      if (p.x < Math.min(f.x, to.x) - 1e-6 || p.x > Math.max(f.x, to.x) + 1e-6 || p.y < Math.min(f.y, to.y) - 1e-6 || p.y > Math.max(f.y, to.y) + 1e-6) okPos = false;
    }
    if (c.act && c.act.kind === 'fork') { sawFork = true; const e = sim.forkExt(c); if (e < 0 || e > 1) okFork = false; }
  }
  ok(sawMove && okPos, '이동 보간 범위 내');
  ok(sawFork && okFork, '포크 신장률 0..1');
}

Math.random = realRandom;
console.log(`결과: ${pass} PASS / ${fail} FAIL (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (fail) process.exit(1);

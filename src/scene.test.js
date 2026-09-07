'use strict';
const Sc = require('./scene.js');
const E = require('./engine.js');
const P = require('./presets.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. layout ----------
{
  const sc = P.carBodyRev0();
  const L = Sc.layout(sc);
  ok(L.cells.length === 30, '셀 박스 30');
  near(L.pitchX, 5.65, 1e-9, 'bay 피치 5.65');
  ok(L.pitchY > 2 && L.pitchY < 3.5, `level 피치(중앙값) ${L.pitchY}`);
  ok(L.cells.every(c => c.z < 0), '편측 랙은 z<0 (앞면)');
  const st = Object.fromEntries(L.stations.map(s => [s.id, s]));
  ok(st.E_L0.z === 0 && st.E_L0.forkDir.x === -1, '랙 밖 스테이션: 통로 축선, 포크 −x');
  ok(st.E_R8.forkDir.x === 1, '우측 스테이션 포크 +x');
  ok(L.xMin <= 0 && L.xMax >= 34.6, '바닥 범위가 존을 포함');
  const G = Sc.layout(P.generic20x10());
  ok(G.cells.length === 400 && G.cells.some(c => c.z > 0) && G.cells.some(c => c.z < 0), '양측 랙 z ±');
  const gs = G.stations[0];
  ok(gs.z < 0 && gs.forkDir.z === -1, '랙 구간 안 스테이션: 앞면 랙 자리');
}

// ---------- 2. frame: 상태·색·포크·셀 표시 ----------
{
  const sc = P.carBodyRev0();
  const sim = new E.Sim(sc, { rep: 0 });
  let sawFork = false, sawLoad = false, sawMove = false, okColors = true, okCells = true;
  for (let t = 0; t < 2400; t += 0.25) {
    sim.advanceTo(t);
    const f = Sc.frame(sim, t);
    const c = f.cranes[0];
    if (!Sc.STATE_COLORS[c.state] || c.color !== Sc.STATE_COLORS[c.state]) okColors = false;
    if (c.state === 'fork') { sawFork = true; if (c.forkExt < 0 || c.forkExt > 1) okColors = false; if (c.forkDir.x === 0 && c.forkDir.z === 0) okColors = false; }
    if (c.loadOnFork) sawLoad = true;
    if (c.state === 'moveLoaded' || c.state === 'moveEmpty') sawMove = true;
    let occ = 0; for (let i = 0; i < f.cellState.length; i++) if (f.cellState[i] === E.OCC || f.cellState[i] === E.RES_OUT) occ++;
    if (occ !== f.kpi.occupied) okCells = false;
    if (f.cellShowLoad.length !== 30) okCells = false;
  }
  ok(sawFork && sawLoad && sawMove, '포크·적재·이동 프레임 관측');
  ok(okColors, '상태색·포크 방향 유효');
  ok(okCells, '셀 상태 카운트 = 점유 수');
  const f = Sc.frame(sim);
  ok(f.stations.length === 4 && f.stations.every(s => s.queue >= 0 && s.atBuffer <= Math.max(s.queue, 0)), '스테이션 대기열');
  ok(f.kpi.ratePerHour > 0 && f.kpi.doneAll > 0, 'KPI 진행');
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

'use strict';
const K = require('./kernel.js');
const Kin = require('./kin.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. creep=0, delay=0 → 커널 travelTime과 일치 (사다리꼴·삼각) ----------
{
  const ax = { v: 2.9167, a: 0.4, d: 0.4 };
  for (const s of [0.5, 3, 7.33, 13.18, 20.51, 21.26, 24.27, 31.6, 100]) {
    const p = Kin.axisProfile(s, ax);
    near(p.t, K.travelTime(s, ax.v, ax.a, ax.d), 1e-9, `axisProfile.t == kernel s=${s}`);
    near(p.sEnd, s, 1e-9, `sEnd == s s=${s}`);
    const sum = p.phases.reduce((acc, ph) => acc + ph.dur, 0);
    near(sum, p.tMove, 1e-9, `phase 합 == tMove s=${s}`);
  }
}

// ---------- 2. posOn 종점·단조·속도 연속 ----------
{
  const ax = { v: 2.5, a: 0.6, d: 0.8 };
  for (const s of [2, 10, 37.3]) {
    const p = Kin.axisProfile(s, ax);
    near(Kin.posOn(p, 0), 0, 1e-12, `posOn(0)=0 s=${s}`);
    near(Kin.posOn(p, p.t), s, 1e-9, `posOn(t)=s s=${s}`);
    near(Kin.posOn(p, p.t * 3), s, 1e-12, `posOn(>t)=s s=${s}`);
    let prev = 0, mono = true, vjump = 0;
    const N = 4000;
    for (let i = 1; i <= N; i++) {
      const tau = p.t * i / N;
      const x = Kin.posOn(p, tau);
      if (x < prev - 1e-9) mono = false;
      const vfd = (x - prev) / (p.t / N);
      const va = Kin.velOn(p, tau - 0.5 * p.t / N);
      vjump = Math.max(vjump, Math.abs(vfd - va));
      prev = x;
    }
    ok(mono, `단조 증가 s=${s}`);
    ok(vjump < 0.05, `유한차분 속도 == 해석 속도 s=${s} (max diff ${vjump.toFixed(4)})`);
  }
}

// ---------- 3. creep: 커널 구간 솔버와 일치, 종단 접근속도 ≤ creepV ----------
{
  const ax = { v: 2.9167, a: 0.4, d: 0.4, creepDist: 0.25, creepV: 5 / 60 };
  for (const s of [0.1, 0.3, 2, 15]) {
    const p = Kin.axisProfile(s, ax);
    const segs = K.applyCreep([{ len: s, vmax: ax.v }], ax.creepDist, ax.creepV);
    const r = K.travelTimeSegments(segs, ax.a, ax.d);
    near(p.t, r.t, 1e-9, `creep t == 커널 솔버 s=${s}`);
    near(Kin.posOn(p, p.t), s, 1e-9, `creep 종점 s=${s}`);
    const vEnd = Kin.velOn(p, p.t - 1e-3);
    ok(vEnd <= ax.creepV + 1e-6, `종단 접근속도 ≤ creepV s=${s} (v=${vEnd.toFixed(4)})`);
  }
  // creepDist→0 이면 커널 travelTime으로 수렴
  const p0 = Kin.axisProfile(10, { v: 2, a: 0.5, d: 0.5, creepDist: 1e-9, creepV: 0.1 });
  near(p0.t, K.travelTime(10, 2, 0.5, 0.5), 1e-6, 'creepDist→0 연속');
}

// ---------- 4. 지연: t = tMove + tDelay, 지연 중 위치 0, s=0이면 지연 없음 ----------
{
  const ax = { v: 2, a: 0.5, d: 0.5, tDelay: 1.3 };
  const p = Kin.axisProfile(10, ax);
  near(p.t, K.travelTime(10, 2, 0.5, 0.5) + 1.3, 1e-9, '지연 가산');
  near(Kin.posOn(p, 0.65), 0, 1e-12, '지연 중 위치 0');
  ok(Kin.posOn(p, 1.3 + 0.5) > 0, '지연 후 이동 시작');
  const z = Kin.axisProfile(0, ax);
  near(z.t, 0, 1e-12, 's=0 → t=0 (지연 없음)');
  near(Kin.posOn(z, 5), 0, 1e-12, 's=0 → 위치 0');
}

// ---------- 5. makeMove: 체비셰프, 빠른 축 정지 유지, 음방향 ----------
{
  const models = Kin.makeModels({ x: { v: 2.9167, a: 0.4, d: 0.4 }, y: { v: 0.8333, a: 0.5, d: 0.5 } });
  const mv = Kin.makeMove({ x: 1.5, y: 0 }, { x: 8.83, y: 8.45 }, models, 1.0);
  const tx = K.travelTime(7.33, 2.9167, 0.4, 0.4), ty = K.travelTime(8.45, 0.8333, 0.5, 0.5);
  near(mv.dur, Math.max(tx, ty) + 1.0, 1e-9, 'dur = max + tPos');
  near(mv.tx, tx, 1e-9, 'tx'); near(mv.ty, ty, 1e-9, 'ty');
  const pEnd = mv.posAt(mv.dur);
  near(pEnd.x, 8.83, 1e-9, '종점 x'); near(pEnd.y, 8.45, 1e-9, '종점 y');
  // x축(빠름)은 tx 이후 정지 유지, y축은 아직 이동 중
  const mid = mv.posAt(tx + 0.5);
  near(mid.x, 8.83, 1e-9, '빠른 축 도착 후 유지');
  ok(mid.y < 8.45 - 1e-6, '느린 축 아직 이동 중');
  // 음방향
  const back = Kin.makeMove({ x: 8.83, y: 8.45 }, { x: 1.5, y: 0 }, models, 1.0);
  const b = back.posAt(back.dur * 0.5);
  ok(b.x < 8.83 && b.x > 1.5 && b.y < 8.45 && b.y > 0, '음방향 이동 중간점');
  near(back.posAt(back.dur).x, 1.5, 1e-9, '음방향 종점 x');
  // 정지 이동
  const none = Kin.makeMove({ x: 3, y: 2 }, { x: 3, y: 2 }, models, 1.0);
  near(none.dur, 0, 1e-12, '제자리 이동 dur=0');
  // 한 축만 이동해도 tPos 적용
  const oneAxis = Kin.makeMove({ x: 1.5, y: 8 }, { x: 1.5, y: 0 }, models, 1.0);
  near(oneAxis.dur, K.travelTime(8, 0.8333, 0.5, 0.5) + 1.0, 1e-9, '단일 축 이동 + tPos');
}

// ---------- 6. Rev.0 계산서 앵커 (FEM 9.851 준용, 차체 저장 설비) ----------
{
  const models = Kin.makeModels({ x: { v: 175 / 60, a: 0.4, d: 0.4 }, y: { v: 50 / 60, a: 0.5, d: 0.5 } });
  near(models.x.time(7.33), 8.56, 0.02, 'Δx 7.33 m → 8.6 s');
  near(models.y.time(8.45), 11.81, 0.02, 'Δy 8.45 m → 11.8 s');
  near(models.x.time(24.27), 15.61, 0.02, 'Δx 24.27 m → 15.6 s (사다리꼴)');
  near(models.x.time(31.6), 18.13, 0.02, 'Δx 31.6 m → 18.1 s');
  near(models.y.time(8.0), 11.27, 0.02, 'Δy 8.0 m → 11.3 s');
  const E = { x: 1.5, y: 0 }, P1 = { x: 8.83, y: 8.45 }, P2 = { x: 22.01, y: 2.53 }, A = { x: 1.5, y: 8 };
  near(Kin.legTime(E, P1, models), 11.81, 0.02, 'E_L0→P1 = 11.8');
  near(Kin.legTime(P1, P2, models), 11.48, 0.02, 'P1→P2 = 11.5');
  near(Kin.legTime(P2, A, models), 14.32, 0.02, 'P2→A_L8 = 14.3');
  near(Kin.legTime(A, E, models), 11.27, 0.02, 'A_L8→E_L0 = 11.3');
  near(Kin.legTime(E, E, models, 1.0), 0, 1e-12, '동일점 leg = 0');
}

// ---------- 7. 포크 사이클 ----------
{
  const fc = Kin.forkCycle({ v: 1.0, a: 0.6, d: 0.6, stroke: 1.4, lift: 0, tSeat: 1.8 });
  near(fc.tExt, 2 * Math.sqrt(1.4 / 0.6), 1e-9, '신장 시간 = 2√(s/a)');
  near(fc.t, 2 * 2 * Math.sqrt(1.4 / 0.6) + 1.8, 1e-9, '포크 사이클 = 2×신장 + 안착');
  const fo = Kin.forkCycle({ v: 1, a: 0.6, d: 0.6, stroke: 1.4, tOverride: 8.0 });
  near(fo.t, 8.0, 1e-12, 'tOverride 적용'); ok(fo.overridden, 'overridden 플래그');
  near(Kin.forkExtension(fc, 0), 0, 1e-12, '신장률 시작 0');
  near(Kin.forkExtension(fc, fc.tExt), 1, 1e-9, '신장 완료 1');
  near(Kin.forkExtension(fc, fc.tExt + fc.tMid / 2), 1, 1e-12, '유지 구간 1');
  near(Kin.forkExtension(fc, fc.t), 0, 1e-9, '인입 완료 0');
  const half = Kin.forkExtension(fc, fc.tExt / 2);
  near(half, 0.5, 1e-9, '신장 중간 0.5');
}

// ---------- 8. AxisModel 캐시 동일성 ----------
{
  const m = new Kin.AxisModel({ v: 2, a: 0.5, d: 0.5 });
  const a = m.profile(12.34567), b = m.profile(12.34567);
  ok(a === b, '캐시 히트');
  near(m.time(12.3456700000001), m.time(12.34567), 1e-12, '1 nm 양자화');
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

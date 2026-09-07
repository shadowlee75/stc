'use strict';
const K = require('./kernel.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + name); }
}
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. 사다리꼴 폐형식 ----------
{
  const v = 2, a = 0.5, d = 1;            // k = 3, s_crit = 6
  near(K.sCrit(v, a, d), 6, 1e-12, 'sCrit');
  near(K.travelTime(100, v, a, d), 100 / 2 + (2 / 2) * 3, 1e-12, '사다리꼴 t=s/v+v/2·k');
}

// ---------- 2. 삼각 폐형식 ----------
{
  const v = 2, a = 0.5, d = 1;            // s=3 < 6
  const vp = Math.sqrt(2 * 3 / 3);
  near(K.travelTime(3, v, a, d), vp * 3, 1e-12, '삼각 t=vp·k');
}

// ---------- 3. T3 경계 연속성 ----------
{
  for (const [v, a, d] of [[2, 0.5, 1], [1.5, 0.7, 0.7], [4, 1.2, 0.9], [0.5, 0.3, 0.6]]) {
    const sc = K.sCrit(v, a, d);
    const tl = K.travelTime(sc * (1 - 1e-9), v, a, d);
    const tr = K.travelTime(sc * (1 + 1e-9), v, a, d);
    near(tl, tr, 1e-6, `T3 연속성 v=${v},a=${a},d=${d}`);
    near(K.travelTime(sc, v, a, d), v * (1 / a + 1 / d), 1e-9, `T3 경계값 = v·k v=${v}`);
  }
}

// ---------- 4. a=d 축약 = FEM 9.860 식(3) ----------
{
  const v = 2, a = 0.5;
  near(K.travelTime(10, v, a, a), 10 / v + v / a, 1e-12, '9.860 장거리 s/v+v/a');   // s_crit = v²/a = 8
  near(K.travelTime(2, v, a, a), 2 * Math.sqrt(2 / a), 1e-12, '9.860 단거리 2√(s/a)');
}

// ---------- 5. 구간 솔버: 단일 구간 = travelTime, 분할 불변 ----------
{
  const a = 0.6, d = 0.8, v = 2.5, L = 37.3;
  const single = K.travelTimeSegments([{ len: L, vmax: v }], a, d).t;
  near(single, K.travelTime(L, v, a, d), 1e-9, '솔버 단일구간 = travelTime');
  const split3 = K.travelTimeSegments([{ len: 10, vmax: v }, { len: 20, vmax: v }, { len: 7.3, vmax: v }], a, d).t;
  near(split3, single, 1e-9, '솔버 동일상한 분할 불변');
  const split10 = K.travelTimeSegments(
    Array.from({ length: 10 }, () => ({ len: L / 10, vmax: v })), a, d).t;
  near(split10, single, 1e-9, '솔버 10분할 불변');
}

// ---------- 6. 구간 솔버: 중간 저속구간 ----------
{
  const a = 0.6, d = 0.8, v = 3;
  const free = K.travelTimeSegments([{ len: 110, vmax: v }], a, d).t;
  const limited = K.travelTimeSegments(
    [{ len: 50, vmax: v }, { len: 10, vmax: 1 }, { len: 50, vmax: v }], a, d).t;
  ok(limited > free + 1e-6, '저속구간이 있으면 시간 증가');
  const shrink = K.travelTimeSegments(
    [{ len: 55, vmax: v }, { len: 0, vmax: 1 }, { len: 55, vmax: v }], a, d).t;
  near(shrink, free, 1e-9, '저속구간 길이 0 → 무제한과 일치');
}

// ---------- 7. Creep: 켜기/끄기 연속, s 스윕 무불연속 ----------
{
  const a = 0.5, d = 0.5, v = 2, vC = 0.3, sC = 0.8;
  const base = (s) => K.travelTimeSegments([{ len: s, vmax: v }], a, d).t;
  const withCreep = (s) => K.travelTimeSegments(K.applyCreep([{ len: s, vmax: v }], sC, vC), a, d).t;
  // sCreep→0 이면 원본과 일치
  near(K.travelTimeSegments(K.applyCreep([{ len: 20, vmax: v }], 0, vC), a, d).t, base(20), 1e-12, 'creep 끔 = 원본');
  near(K.travelTimeSegments(K.applyCreep([{ len: 20, vmax: v }], 1e-9, vC), a, d).t, base(20), 1e-4, 'sCreep→0 연속');
  ok(withCreep(20) > base(20), 'creep 켜면 시간 증가');
  // 거리 스윕에서 점프 없음 — creep 도입 경계(s≈sC)와 creep 전용 구간(s<sC)까지 포함
  let maxJump = 0, prev = withCreep(0.05);
  for (let s = 0.051; s <= 25; s += 0.001) {
    const t = withCreep(s);
    maxJump = Math.max(maxJump, Math.abs(t - prev));
    ok(t >= prev - 1e-9, s < 0.06 ? `creep 스윕 단조성 s=${s.toFixed(3)}` : 'creep 스윕 단조성');
    if (t < prev - 1e-9) break;
    prev = t;
  }
  ok(maxJump < 0.05, `creep 스윕 최대 점프 ${maxJump.toFixed(6)}s < 0.05s`);
  // 구조 전환 후보점에서 좌·우 극한 차 < 1 ms (PRD G2/T3 기준)
  for (const s0 of [sC, K.sCrit(v, a, d), K.sCrit(v, a, d) + sC, vC * vC / 2 * (1 / a + 1 / d) + sC]) {
    const dl = Math.abs(withCreep(s0 * (1 - 1e-9)) - withCreep(s0 * (1 + 1e-9)));
    ok(dl < 1e-3, `creep 구조 전환점 s=${s0.toFixed(4)} 좌우극한 차 ${dl.toExponential(2)} < 1ms`);
  }
}

// ---------- 8. Jerk — 정확한 S-커브 초과시간 (a+d)/(2j) ----------
{
  near(K.jerkExtra('a', 0.5, 0.5, 2), 0, 1e-12, 'jerk 방식 ⓐ 가산 0');
  near(K.jerkExtra('b', 0.5, 0.4, 2), (0.5 + 0.4) / (2 * 2), 1e-12, 'jerk 방식 ⓑ (a+d)/(2j)');
  // 7-세그먼트 S-커브 수치적분과 대조: s=100, v=2, a=0.5, d=0.4, j=2 → 초과 = 0.225 s
  near(K.jerkExtra('b', 0.5, 0.4, 2), 0.225, 1e-12, 'S-커브 초과시간 일치');
  let threw = 0;
  try { K.jerkExtra('B', 0.5, 0.4, 2); } catch (e) { threw++; }
  try { K.jerkExtra(undefined, 0.5, 0.4, 2); } catch (e) { threw++; }
  ok(threw === 2, 'jerk 모드 오타 거부');
}

// ---------- 9. 지연·Chebyshev ----------
{
  near(K.delaySum([{ value: 0.3 }, { value: 0.2 }, { value: '0.5' }]), 1.0, 1e-12, '지연 합산');
  near(K.chebyshev(3, 5, 0.4), 5.4, 1e-12, 'Chebyshev max+positioning');
}

// ---------- 10. 대수산정: η=1 이면 AN_eff = AN_fem ----------
{
  for (const [w, TC] of [[10, 174.7], [50, 60], [120, 45], [1, 300]]) {
    const r = K.fleet(w, TC, { A: 0.9, Ft: 0.9, Ew: 1, eta: K.etaModels.none() });
    ok(r.AN_eff === r.AN_fem, `η=1: AN_eff=${r.AN_eff} == AN_fem=${r.AN_fem} (w=${w})`);
    ok(r.theta(r.AN_eff) >= w - 1e-6, `θ(AN_eff) ≥ w (w=${w})`);
  }
}

// ---------- 11. 대수산정: η<1 이면 AN_eff ≥ AN_fem, θ 충족 ----------
{
  const eta = K.etaModels.beta(0.06);
  const r = K.fleet(80, 120, { A: 0.85, Ft: 0.9, Ew: 1, eta });
  ok(r.AN_eff >= r.AN_fem, `η<1: AN_eff=${r.AN_eff} ≥ AN_fem=${r.AN_fem}`);
  ok(r.theta(r.AN_eff) >= 80 - 1e-6, 'η<1: θ(AN_eff) ≥ w');
  ok(r.AN_eff === null || r.theta(r.AN_eff - 1) < 80, 'AN_eff 최소성');
}

// ---------- 12. 대수산정: 포화(도달 불가) → AN_eff = null + reason ----------
{
  // β=0.5, A·Ft·Ew=1, TC=60s → θ 상한 = 60·N/(1+0.5(N-1))/1 → N→∞에서 120건/h
  const r = K.fleet(150, 60, { A: 1, Ft: 1, Ew: 1, eta: K.etaModels.beta(0.5) });
  ok(r.AN_eff === null && r.reason === 'saturated', `포화 시 AN_eff=null·reason=saturated (got ${r.AN_eff}, ${r.reason})`);
  // η=1이면 아무리 큰 수요도 null이 아니라 AN_fem과 일치해야 함 (탐색 상한 동적 확장)
  const big = K.fleet(70000, 3600, { A: 1, Ft: 1, Ew: 1, eta: K.etaModels.none() });
  ok(big.AN_eff === big.AN_fem && big.AN_fem === 70000, `대규모 η=1: AN_eff=${big.AN_eff} == AN_fem=${big.AN_fem}`);
}

// ---------- 12b. 골든테스트 T1·T2 (OPIL — PRD 7.2) ----------
{
  // T1: SMARTENVELOPE — 이동시간 d/v 모델, Tc = 0.4 + 40.30/35 + 0.5 + (70.42-40.30)/35 = 2.912 min
  const TC1 = 0.4 + 40.30 / 35 + 0.5 + (70.42 - 40.30) / 35;
  near(TC1, 2.912, 0.001, 'T1 — T_C 2.912 min');
  const f1 = K.fleet(10.222, TC1 * 60, { A: 0.7, Ft: 0.5, Ew: 0.7, eta: K.etaModels.none() });
  near(f1.WL, 29.766, 0.005, 'T1 — WL');
  near(f1.AT, 14.7, 0.001, 'T1 — AT');
  near(f1.WL / f1.AT, 2.025, 0.002, 'T1 — AN_raw');
  ok(f1.AN_fem === 3 && f1.AN_eff === 3, 'T1 — 3대');
  const f1b = K.fleet(10.222, TC1 * 60, { A: 1, Ft: 1, Ew: 1, eta: K.etaModels.none() });
  near(f1b.WL / f1b.AT, 0.496, 0.002, 'T1-B — 보정계수 1.0 방치 시 0.496');
  ok(f1b.AN_fem === 1, 'T1-B — 1대 오산 재현');
  // T2: SMARTHam — Tc = 1.0 + 65/65 = 2.0 min, w = 39.76/2
  const f2 = K.fleet(39.76 / 2.0, 120, { A: 0.99, Ft: 0.99, Ew: 1.0, eta: K.etaModels.none() });
  near(f2.WL, 39.76, 0.01, 'T2 — WL');
  near(f2.AT, 58.806, 0.001, 'T2 — AT');
  near(f2.WL / f2.AT, 0.676, 0.002, 'T2 — AN_raw');
  ok(f2.AN_fem === 1, 'T2 — 1대');
}

// ---------- 12c. FEM 9.860 §5.6 리프트 병목 경로 ----------
{
  const r = K.fem9860Lift({ tC2y: 60, tC2x: 45, nL: 2 });
  near(r.lambdaY, 3600 * 2 / 60, 1e-9, '§5.6 λ_y');
  near(r.lambdaX, 3600 / 45, 1e-9, '§5.6 λ_x');
  near(r.nShuttle, 60 / (45 * 2), 1e-9, '§5.6 n_shuttle');
  let threw = 0;
  try { K.fem9860Lift({ tC2y: 0, tC2x: 45, nL: 2 }); } catch (e) { threw++; }
  ok(threw === 1, '§5.6 입력 검증');
}

// ---------- 13. T7 물리한계 ----------
{
  const { Nmax, level } = K.physCheck(5, 300, 12);   // Nmax = 25
  ok(Nmax === 25 && level === 'ok', 'T7 정상 범위');
  ok(K.physCheck(8, 300, 12).level === 'warn', 'T7 N>0.3·Nmax 경고');
  ok(K.physCheck(26, 300, 12).level === 'error', 'T7 N>Nmax 오류');
}

// ---------- 14. 입력 검증 ----------
{
  let threw = 0;
  try { K.travelTime(-1, 2, 0.5, 0.5); } catch (e) { threw++; }
  try { K.travelTime(10, 0, 0.5, 0.5); } catch (e) { threw++; }
  try { K.fleet(10, 60, { A: 0, Ft: 1, Ew: 1 }); } catch (e) { threw++; }
  try { K.travelTimeSegments([{ len: 10, vmax: 1e-13 }], 0.5, 0.5); } catch (e) { threw++; }   // 사실상 0 속도 → 시간 0 반환 금지
  try { K.travelTimeSegments([{ len: -5, vmax: 2 }, { len: 10, vmax: 2 }], 0.5, 0.5); } catch (e) { threw++; }
  try { K.travelTimeSegments([{ len: NaN, vmax: 2 }], 0.5, 0.5); } catch (e) { threw++; }
  try { K.etaModels.beta(-1); } catch (e) { threw++; }
  try { K.etaModels.power(1, 1); } catch (e) { threw++; }
  ok(threw === 8, '잘못된 입력 거부 (확장)');
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);

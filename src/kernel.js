'use strict';
/* ============================================================
 * 공통 운동학 커널 (PRD §5) — 물동량계산 통합플랫폼
 * K1 이동시간 t(s) · K2 지연 · K3 동시동작 · K4 보정계수 · K5 대수산정
 * 근거: FEM 9.860 (2017-08) 식(3), FEM 9.222, VDI 3561 Bl.4
 * ============================================================ */
const MHKernel = (() => {

  // ---------- 단위 변환 ----------
  const mm2m = (mm) => mm / 1000;
  const mpm2mps = (vpm) => vpm / 60; // m/min → m/s

  // ---------- K1. 이동시간 t(s) — 정지→정지, 단일 상한 ----------
  // s [m], v [m/s], a/d [m/s²]  →  t [s]
  // 사다리꼴/삼각 자동 분기, s = s_crit 에서 양쪽 모두 v·(1/a+1/d)로 연속
  function sCrit(v, a, d) {
    return (v * v / 2) * (1 / a + 1 / d);
  }

  function travelTime(s, v, a, d) {
    if (!(v > 0) || !(a > 0) || !(d > 0)) throw new Error('v, a, d는 양수여야 합니다');
    if (!(s >= 0)) throw new Error('거리 s는 0 이상이어야 합니다');
    if (s === 0) return 0;
    const k = 1 / a + 1 / d;
    const sc = (v * v / 2) * k;
    if (s >= sc) return s / v + (v / 2) * k;      // 사다리꼴
    const vp = Math.sqrt(2 * s / k);               // 삼각
    return vp * k;
  }

  // ---------- K1. 구간별 속도제한 — 경계 통과속도 연속 모델 ----------
  // segments: [{len [m], vmax [m/s]}], 정지 출발 → 정지 도착.
  // 전진/후진 패스로 경계속도 b[i]를 정하고 구간별 시간을 합산한다.
  // 불변식: 같은 vmax로 임의 분할해도 합계 시간이 변하지 않는다(연속성 G2).
  function travelTimeSegments(segments, a, d) {
    if (!(a > 0) || !(d > 0)) throw new Error('a, d는 양수여야 합니다');
    for (const s of segments) {
      if (!Number.isFinite(s.len) || s.len < 0) throw new Error('구간 길이는 0 이상의 유한값이어야 합니다');
    }
    const segs = segments.filter(s => s.len > 1e-12);
    const n = segs.length;
    if (n === 0) return { t: 0, boundaries: [0], detail: [] };
    for (const s of segs) if (!(s.vmax > 1e-9)) throw new Error('구간 vmax는 양수여야 합니다 (1e-9 m/s 초과)');

    // 전진 패스: 가속 한계로 도달 가능한 경계속도
    const f = new Array(n + 1);
    f[0] = 0;
    for (let i = 0; i < n; i++) {
      const capHere = segs[i].vmax;
      const capNext = i + 1 < n ? segs[i + 1].vmax : Infinity;
      f[i + 1] = Math.min(capHere, capNext, Math.sqrt(f[i] * f[i] + 2 * a * segs[i].len));
    }
    // 후진 패스: 감속 한계로 허용되는 경계속도
    const g = new Array(n + 1);
    g[n] = 0;
    for (let i = n - 1; i >= 0; i--) {
      const capHere = segs[i].vmax;
      const capPrev = i - 1 >= 0 ? segs[i - 1].vmax : Infinity;
      g[i] = Math.min(capHere, capPrev, Math.sqrt(g[i + 1] * g[i + 1] + 2 * d * segs[i].len));
    }
    const b = f.map((fi, i) => Math.min(fi, g[i]));

    // 구간별 시간: 진입 ve, 진출 vx, 상한 vm
    let t = 0;
    const detail = [];
    for (let i = 0; i < n; i++) {
      const L = segs[i].len, vm = segs[i].vmax, ve = b[i], vx = b[i + 1];
      const vpFree = Math.sqrt((2 * a * d * L + d * ve * ve + a * vx * vx) / (a + d));
      const vp = Math.min(vm, vpFree);
      const sAcc = (vp * vp - ve * ve) / (2 * a);
      const sDec = (vp * vp - vx * vx) / (2 * d);
      const sCru = Math.max(0, L - sAcc - sDec);
      const ti = (vp > 0)
        ? (vp - ve) / a + (vp - vx) / d + sCru / vp
        : 0;                                       // vp=0은 len≈0 구간에서만 발생
      t += ti;
      detail.push({ len: L, vmax: vm, ve, vx, vp, t: ti });
    }
    return { t, boundaries: b, detail };
  }

  // ---------- K1. 저속 접근(creep) — 마지막 sCreep 구간에 vCreep 상한 ----------
  // 켜고(sCreep>0) 끄는(sCreep=0) 경계에서 연속: sCreep→0 이면 원래 프로파일과 일치
  function applyCreep(segments, sCreep, vCreep) {
    if (!(sCreep > 0)) return segments.slice();
    if (!(vCreep > 0)) throw new Error('vCreep은 양수여야 합니다');
    const out = [];
    let remain = sCreep;
    // 뒤에서부터 sCreep 만큼을 vCreep 상한으로 치환
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (remain <= 1e-12) { out.unshift(s); continue; }
      if (s.len <= remain + 1e-12) {
        out.unshift({ len: s.len, vmax: Math.min(s.vmax, vCreep) });
        remain -= s.len;
      } else {
        out.unshift({ len: remain, vmax: Math.min(s.vmax, vCreep) });
        out.unshift({ len: s.len - remain, vmax: s.vmax });
        remain = 0;
      }
    }
    return out;
  }

  // ---------- K1. Jerk (FEM 9.860 §5.2.2) ----------
  // 방식 ⓐ: 입력 a·d 자체를 낮춰 사용(가산 0) / 방식 ⓑ: 최대 가속도 + jerk 시간 가산
  // ⓑ 가산량 = (a+d)/(2j) — 순항 구간이 있는 7-세그먼트 S-커브의 사다리꼴 대비 정확한 초과시간
  //   (가속상 지속시간은 a/j 늘지만 평균속도 대칭으로 시간 증가분은 절반. 삼각 프로파일·다구간에서는 근사)
  //   정지→정지 이동 1회당 1회 가산한다 — 중간 속도 변화가 많은 다구간 경로에서는 하한 근사임에 유의.
  function jerkExtra(mode, a, d, j) {
    if (mode !== 'a' && mode !== 'b') throw new Error("jerk 방식은 'a' 또는 'b'여야 합니다");
    if (mode !== 'b') return 0;
    if (!(j > 0)) throw new Error('jerk 방식 ⓑ에는 j > 0 입력이 필요합니다');
    return (a + d) / (2 * j);
  }

  // ---------- K2. 지연 모델 ----------
  // 항목 정의는 장비 계층에서 주입. 합산만 커널이 담당.
  function delaySum(items) {
    return items.reduce((acc, it) => acc + (Number(it.value) || 0), 0);
  }

  // ---------- K3. 동시동작 (Chebyshev) ----------
  function chebyshev(t1, t2, tPositioning) {
    return Math.max(t1, t2) + (tPositioning || 0);
  }

  // ---------- K4/K5. 보정계수·대수산정 ----------
  // w [건/h], TCsec [s/사이클], A·Ft·Ew ∈ (0,1]
  // AN_fem = ⌈WL/AT⌉ (FEM/OPIL 원식, η 미반영 — 참고용 병기)
  // AN_eff = θ_N ≥ w 를 만족하는 최소 N (η 반영, 설계 채택값)
  function fleet(w, TCsec, opt) {
    const A = opt.A, Ft = opt.Ft, Ew = opt.Ew;
    const eta = opt.eta || (() => 1);
    for (const [name, x] of [['A', A], ['F_t', Ft], ['E_w', Ew]]) {
      if (!(x > 0 && x <= 1)) throw new Error(name + '는 (0,1] 범위여야 합니다');
    }
    if (!(w >= 0)) throw new Error('수요 w는 0 이상이어야 합니다');
    if (!(TCsec > 0)) throw new Error('사이클타임은 양수여야 합니다');
    const e1 = eta(1);
    if (!(e1 > 0 && e1 <= 1)) throw new Error('η(1)은 (0,1] 범위여야 합니다');
    const TCmin = TCsec / 60;
    const WL = w * TCmin;                 // 시간당 작업부하 [min/h]
    const AT = 60 * A * Ft * Ew;          // 1대 가용시간 [min/h]
    const AN_fem = w === 0 ? 0 : Math.ceil(WL / AT - 1e-9);
    const theta = (N) => 60 * N * A * Ft * Ew * eta(N) / TCmin;   // [건/h]
    // AN_eff: θ_N ≥ w 최소 N. 탐색 상한은 AN_fem 기반 동적 설정.
    // 미달 시 reason: 'saturated'(θ가 정체·감소 — 증차 무의미) | 'search_limit'(상한 내 미발견)
    let AN_eff = w === 0 ? 0 : null, reason = null;
    if (w > 0) {
      const CAP = Math.max(1000, 2 * AN_fem);
      for (let N = 1; N <= CAP; N++) {
        if (theta(N) >= w - 1e-9) { AN_eff = N; break; }
      }
      if (AN_eff === null) {
        // 100배 규모에서도 미달이면 실질적 포화(증차 무의미), 도달 가능하면 탐색 상한 문제
        reason = theta(CAP * 100) >= w - 1e-9 ? 'search_limit' : 'saturated';
      }
    }
    const rho = (N) => N > 0 ? WL / (N * AT) : 0;
    return { WL, AT, AN_fem, AN_eff, reason, theta, rho };
  }

  // 혼잡 간섭계수 η(N) 모델 (PRD 6.3 — 선형 비례 계산 금지 대응)
  const etaModels = {
    none: () => (() => 1),
    beta: (beta) => {
      if (!(beta >= 0)) throw new Error('β는 0 이상이어야 합니다');
      return (N) => 1 / (1 + beta * (N - 1));
    },
    power: (gamma, Nmax) => {
      if (!(gamma >= 0)) throw new Error('γ는 0 이상이어야 합니다');
      if (!(Nmax >= 2)) throw new Error('N_max는 2 이상이어야 합니다');
      return (N) => N >= Nmax ? 0 : Math.pow(1 - N / Nmax, gamma);
    },
  };

  // ---------- K5. FEM 9.860 §5.6 — 리프트 병목 경로 ----------
  // tC2y: 리프트 복합 사이클 [s], tC2x: 셔틀 복합 사이클 [s], nL: 리프트당 접근 레벨 수
  function fem9860Lift(opt) {
    const { tC2y, tC2x, nL } = opt;
    if (!(tC2y > 0) || !(tC2x > 0)) throw new Error('t_C2,y와 t_C2,x는 양수여야 합니다');
    if (!(nL >= 1)) throw new Error('n_L은 1 이상이어야 합니다');
    return {
      lambdaY: 3600 * nL / tC2y,        // 리프트 처리능력 [건/h]
      lambdaX: 3600 / tC2x,             // 셔틀 1대 처리능력 [건/h]
      nShuttle: tC2y / (tC2x * nL),     // 리프트당 셔틀 대수
    };
  }

  // ---------- T7. 물리한계 ----------
  // L [m] 루프/라인 길이, sMin [m] 차간 최소 안전거리
  function physCheck(N, L, sMin) {
    if (!(L > 0) || !(sMin > 0)) throw new Error('L, s_min은 양수여야 합니다');
    const Nmax = Math.floor(L / sMin);
    let level = 'ok';
    if (N > Nmax) level = 'error';
    else if (N > 0.3 * Nmax) level = 'warn';
    return { Nmax, level };
  }

  return {
    version: '0.1.0',
    mm2m, mpm2mps,
    sCrit, travelTime, travelTimeSegments, applyCreep, jerkExtra,
    delaySum, chebyshev, fleet, etaModels, physCheck, fem9860Lift,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MHKernel;

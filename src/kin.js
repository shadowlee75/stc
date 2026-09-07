'use strict';
/* ============================================================
 * STC 시뮬레이터 — 운동학 위치-시간 모듈 (kin.js)
 * 이동시간은 오직 공통 커널 MHKernel로 계산한다 (PRD G1: 자체 t(s) 금지).
 * 커널의 travelTimeSegments().detail(구간별 진입·최고·진출 속도)로부터
 * 가속/순항/감속 phase 목록을 만들어 posAt(τ)를 구간별 2차식으로 제공한다.
 *
 * 축 사양 axis: { v [m/s], a [m/s²], d [m/s²], creepDist [m], creepV [m/s], tDelay [s] }
 *   - creepDist > 0 이면 마지막 creepDist 구간을 creepV 상한으로 저속 접근 (FEM 9.851 5구간 저속구간)
 *   - tDelay: 제어·통신·jerk 등 고정 지연. 이동 시작 전에 부가된다(위치 유지). s=0 이면 지연도 0.
 * ============================================================ */
const STCKin = (() => {
  const K = (typeof MHKernel !== 'undefined') ? MHKernel : require('./kernel.js');

  function normalizeAxis(ax) {
    if (!ax) throw new Error('축 사양이 없습니다');
    const v = +ax.v, a = +ax.a, d = (ax.d === undefined || ax.d === null) ? +ax.a : +ax.d;
    if (!(v > 0) || !(a > 0) || !(d > 0)) throw new Error('축 v, a, d는 양수여야 합니다');
    const creepDist = ax.creepDist > 0 ? +ax.creepDist : 0;
    const creepV = ax.creepV > 0 ? Math.min(+ax.creepV, v) : v;
    const tDelay = ax.tDelay > 0 ? +ax.tDelay : 0;
    return { v, a, d, creepDist, creepV, tDelay };
  }

  // 커널 detail → phase 목록. phase: {t0, s0, dur, v0, acc}
  function phasesFromDetail(detail, a, d) {
    const phases = [];
    let t0 = 0, s0 = 0;
    for (const seg of detail) {
      const ve = seg.ve, vx = seg.vx, vp = seg.vp, len = seg.len;
      const tAcc = (vp - ve) / a, sAcc = (vp * vp - ve * ve) / (2 * a);
      const tDec = (vp - vx) / d, sDec = (vp * vp - vx * vx) / (2 * d);
      let sCru = len - sAcc - sDec; if (sCru < 0) sCru = 0;
      const tCru = vp > 0 ? sCru / vp : 0;
      if (tAcc > 1e-12) { phases.push({ t0, s0, dur: tAcc, v0: ve, acc: a }); t0 += tAcc; s0 += sAcc; }
      if (tCru > 1e-12) { phases.push({ t0, s0, dur: tCru, v0: vp, acc: 0 }); t0 += tCru; s0 += sCru; }
      if (tDec > 1e-12) { phases.push({ t0, s0, dur: tDec, v0: vp, acc: -d }); t0 += tDec; s0 += sDec; }
    }
    return { phases, tMove: t0, sEnd: s0 };
  }

  // 축 1개, 거리 s[m] 정지→정지 프로파일
  // 반환: { s, t (지연 포함 총시간), tMove, tDelay, phases, sEnd }
  function axisProfile(s, axis) {
    const ax = normalizeAxis(axis);
    if (!(s >= 0)) throw new Error('거리 s는 0 이상이어야 합니다');
    if (s < 1e-12) return { s: 0, t: 0, tMove: 0, tDelay: 0, phases: [], sEnd: 0 };
    let segs = [{ len: s, vmax: ax.v }];
    if (ax.creepDist > 0) segs = K.applyCreep(segs, ax.creepDist, ax.creepV);
    const r = K.travelTimeSegments(segs, ax.a, ax.d);
    const ph = phasesFromDetail(r.detail, ax.a, ax.d);
    return { s, t: r.t + ax.tDelay, tMove: r.t, tDelay: ax.tDelay, phases: ph.phases, sEnd: ph.sEnd, tKernel: r.t };
  }

  // 프로파일 위 위치 (τ는 이동 시작 기준, 지연 포함)
  function posOn(prof, tau) {
    if (prof.s === 0) return 0;
    const t = tau - prof.tDelay;
    if (t <= 0) return 0;
    if (t >= prof.tMove) return prof.s;
    const ph = prof.phases;
    for (let i = ph.length - 1; i >= 0; i--) {
      const p = ph[i];
      if (t >= p.t0) {
        const dt = Math.min(t - p.t0, p.dur);
        const x = p.s0 + p.v0 * dt + 0.5 * p.acc * dt * dt;
        return x > prof.s ? prof.s : x;
      }
    }
    return 0;
  }

  // 프로파일 위 속도 (검증·표시용)
  function velOn(prof, tau) {
    if (prof.s === 0) return 0;
    const t = tau - prof.tDelay;
    if (t <= 0 || t >= prof.tMove) return 0;
    const ph = prof.phases;
    for (let i = ph.length - 1; i >= 0; i--) {
      const p = ph[i];
      if (t >= p.t0) return p.v0 + p.acc * Math.min(t - p.t0, p.dur);
    }
    return 0;
  }

  // 축 모델: 거리별 프로파일 캐시 (격자 셀 간 거리는 종류가 적어 효과가 큼)
  class AxisModel {
    constructor(axis) {
      this.axis = normalizeAxis(axis);
      this.cache = new Map();
    }
    profile(s) {
      const key = Math.round(s * 1e9);          // 1 nm 양자화 (격자 거리 중복 제거, 해석식 1e-6 정합 유지)
      let p = this.cache.get(key);
      if (!p) { p = axisProfile(key / 1e9, this.axis); this.cache.set(key, p); }
      return p;
    }
    time(s) { return this.profile(s).t; }
  }

  // 2축 동시 이동 (주행 x, 승강 y): 동시 출발, 느린 축이 시간을 정하고 빠른 축은 도착 후 정지 유지.
  // dur = chebyshev(tx, ty, tPos). 두 축 모두 0이면 dur=0 (위치결정도 없음).
  function makeMove(from, to, models, tPos) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    const px = models.x.profile(adx), py = models.y.profile(ady);
    const moved = adx > 1e-9 || ady > 1e-9;
    const dur = moved ? K.chebyshev(px.t, py.t, tPos || 0) : 0;
    const sx = Math.sign(dx), sy = Math.sign(dy);
    const fx = from.x, fy = from.y;
    return {
      from: { x: fx, y: fy }, to: { x: to.x, y: to.y },
      dur, tx: px.t, ty: py.t, dist: { x: adx, y: ady },
      posAt(tau) {
        return { x: fx + sx * posOn(px, tau), y: fy + sy * posOn(py, tau) };
      },
      velAt(tau) {
        return { x: sx * velOn(px, tau), y: sy * velOn(py, tau) };
      },
    };
  }

  // 포크(LHD) 사이클: 신장 + (승강·안착) + 인입. fork: {v,a,d,stroke,lift,tSeat,tOverride}
  // tOverride > 0 이면 실측/지정값을 그대로 사용 (Rev.0 t_ü = 8.0 s).
  function forkCycle(fork) {
    if (fork.tOverride > 0) {
      const t = +fork.tOverride;
      return { t, tExt: t / 3, tRet: t / 3, tMid: t / 3, overridden: true };
    }
    const m = new AxisModel({ v: fork.v, a: fork.a, d: fork.d, creepDist: fork.creepDist, creepV: fork.creepV, tDelay: fork.tDelay });
    const tExt = m.time(+fork.stroke || 0);
    const tLift = m.time(+fork.lift || 0);
    const tSeat = fork.tSeat > 0 ? +fork.tSeat : 0;
    const tMid = tLift + tSeat;
    return { t: 2 * tExt + tMid, tExt, tRet: tExt, tMid, overridden: false };
  }

  // 포크 신장률 0..1 (애니메이션용): 신장 → 유지 → 인입
  function forkExtension(fc, tau) {
    if (tau <= 0) return 0;
    if (tau < fc.tExt) return fc.tExt > 0 ? tau / fc.tExt : 1;
    if (tau < fc.tExt + fc.tMid) return 1;
    const r = tau - fc.tExt - fc.tMid;
    if (r < fc.tRet) return fc.tRet > 0 ? 1 - r / fc.tRet : 0;
    return 0;
  }

  // 체비셰프 구간시간 (해석식·디스패치 공용): 두 점 사이 max(tx, ty) (+tPos)
  function legTime(p, q, models, tPos) {
    const tx = models.x.time(Math.abs(q.x - p.x));
    const ty = models.y.time(Math.abs(q.y - p.y));
    if (tx === 0 && ty === 0) return 0;
    return K.chebyshev(tx, ty, tPos || 0);
  }

  function makeModels(axes) {
    return { x: new AxisModel(axes.x), y: new AxisModel(axes.y) };
  }

  return {
    version: '0.1.0',
    normalizeAxis, axisProfile, posOn, velOn, AxisModel, makeModels,
    makeMove, legTime, forkCycle, forkExtension,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCKin;

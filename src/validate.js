'use strict';
/* ============================================================
 * STC 시뮬레이터 — 시나리오 검증 + 기하 (validate.js)
 * 스키마·범위 · 존 비중첩/레일 간격 · 스테이션→존 귀속 · 존별 물질수지 · 반출 도달성
 * 기하 헬퍼(셀 생성, 존 포함)는 엔진과 공유한다.
 * ============================================================ */
const STCValidate = (() => {

  const MODES = ['SC-return', 'SC-stay', 'DC'];
  const PAIRINGS = ['fifo', 'nearest'];
  const PRIORITIES = ['oldest-first', 'storage-first', 'retrieval-first', 'alternate'];
  const STORAGE_RULES = ['random-empty', 'closest-open'];
  const RETRIEVAL_CELLS = ['random', 'fifo', 'nearest'];
  const ARRIVALS = ['takt', 'poisson', 'csv', 'none'];

  // ---------- 기하 ----------
  // 셀 좌표: bayX/levelY 명시 또는 균등 (벽면 원점 x0, 높이 0..H 를 levels 등분한 중심)
  function cellCoords(rack) {
    const bays = rack.bays | 0, levels = rack.levels | 0;
    const bayX = (rack.bayX && rack.bayX.length === bays) ? rack.bayX.map(Number)
      : Array.from({ length: bays }, (_, i) => rack.x0 + (i + 0.5) * rack.length / bays);
    const levelY = (rack.levelY && rack.levelY.length === levels) ? rack.levelY.map(Number)
      : Array.from({ length: levels }, (_, i) => (i + 0.5) * rack.height / levels);
    return { bayX, levelY };
  }

  // cells: [{idx, bay, level, side, x, y}]  idx = side·bays·levels + level·bays + bay
  function buildCells(rack) {
    const { bayX, levelY } = cellCoords(rack);
    const sides = rack.sides === 2 ? 2 : 1;
    const cells = [];
    for (let s = 0; s < sides; s++)
      for (let l = 0; l < levelY.length; l++)
        for (let b = 0; b < bayX.length; b++)
          cells.push({ idx: cells.length, bay: b, level: l, side: s, x: bayX[b], y: levelY[l] });
    return cells;
  }

  const EPS = 1e-9;
  function inRect(zone, x, y) {
    return x >= zone.x[0] - EPS && x <= zone.x[1] + EPS && y >= zone.y[0] - EPS && y <= zone.y[1] + EPS;
  }
  // 첫 번째로 포함하는 크레인 인덱스, 없으면 -1
  function zoneOf(cranes, x, y) {
    for (let i = 0; i < cranes.length; i++) if (inRect(cranes[i].zone, x, y)) return i;
    return -1;
  }
  function rectsOverlap(a, b) {
    return a.x[0] < b.x[1] - EPS && b.x[0] < a.x[1] - EPS && a.y[0] < b.y[1] - EPS && b.y[0] < a.y[1] - EPS;
  }
  function rangesOverlap(a, b) { return a[0] < b[1] - EPS && b[0] < a[1] - EPS; }

  // ---------- 검증 ----------
  function validate(sc) {
    const errors = [], warnings = [], info = [];
    const err = (m) => errors.push(m), warn = (m) => warnings.push(m), note = (m) => info.push(m);
    const num = (v) => typeof v === 'number' && Number.isFinite(v);

    if (!sc || typeof sc !== 'object') return { ok: false, errors: ['시나리오가 객체가 아닙니다'], warnings, info };
    if (sc.schema !== 'stcsim/scenario@1') warn(`schema 필드가 'stcsim/scenario@1'가 아닙니다: ${sc.schema}`);

    // run
    const run = sc.run || {};
    if (!(run.durationSec > 0)) err('run.durationSec는 양수여야 합니다');
    if (!(run.warmupSec >= 0)) err('run.warmupSec는 0 이상이어야 합니다');
    if (run.warmupSec >= run.durationSec) err('워밍업이 시뮬레이션 시간 이상입니다 — 통계 구간이 없습니다');
    if (!(run.tsBinSec > 0)) err('run.tsBinSec는 양수여야 합니다');
    if (!(run.sampleSec > 0)) err('run.sampleSec는 양수여야 합니다');

    // rack
    const rk = sc.rack || {};
    if (!(rk.bays >= 1) || !(rk.levels >= 1)) err('rack.bays, rack.levels는 1 이상이어야 합니다');
    if (rk.sides !== 1 && rk.sides !== 2) err('rack.sides는 1 또는 2여야 합니다');
    if (!num(rk.x0) || !(rk.length > 0) || !(rk.height > 0)) err('rack.x0, length(>0), height(>0)가 필요합니다');
    if (rk.bayX && rk.bayX.length !== rk.bays) err(`rack.bayX 길이(${rk.bayX.length})가 bays(${rk.bays})와 다릅니다`);
    if (rk.levelY && rk.levelY.length !== rk.levels) err(`rack.levelY 길이(${rk.levelY.length})가 levels(${rk.levels})와 다릅니다`);
    if (!(rk.initialFill >= 0 && rk.initialFill <= 1)) err('rack.initialFill은 0~1이어야 합니다');
    if (rk.depth && rk.depth !== 1) warn('depth > 1 (Double Deep 재배치)은 이 버전에서 모델링하지 않습니다 — single deep으로 취급');

    // crane spec
    const cr = sc.crane || {};
    for (const ax of ['x', 'y']) {
      const a = cr.axes && cr.axes[ax];
      if (!a || !(a.v > 0) || !(a.a > 0) || !((a.d === undefined) || a.d > 0)) err(`crane.axes.${ax}: v, a, d는 양수여야 합니다`);
    }
    const fk = cr.fork || {};
    if (!(fk.tOverride > 0) && (!(fk.v > 0) || !(fk.a > 0))) err('crane.fork: tOverride가 없으면 v, a가 양수여야 합니다');
    if (!(cr.tPos >= 0)) err('crane.tPos는 0 이상이어야 합니다');
    if (cr.availability !== undefined && !(cr.availability > 0 && cr.availability <= 1)) err('crane.availability는 (0,1]이어야 합니다');

    // policy
    const po = sc.policy || {};
    if (!MODES.includes(po.mode)) err(`policy.mode는 ${MODES.join('|')} 중 하나여야 합니다: ${po.mode}`);
    if (!PAIRINGS.includes(po.pairing)) err(`policy.pairing는 ${PAIRINGS.join('|')}: ${po.pairing}`);
    if (!PRIORITIES.includes(po.priority)) err(`policy.priority는 ${PRIORITIES.join('|')}: ${po.priority}`);
    if (!STORAGE_RULES.includes(po.storageRule)) err(`policy.storageRule은 ${STORAGE_RULES.join('|')}: ${po.storageRule}`);
    if (!RETRIEVAL_CELLS.includes(po.retrievalCell)) err(`policy.retrievalCell은 ${RETRIEVAL_CELLS.join('|')}: ${po.retrievalCell}`);
    if (po.agingLimit_s !== null && po.agingLimit_s !== undefined && !(po.agingLimit_s > 0)) err('policy.agingLimit_s는 null 또는 양수');

    const k = sc.parallelAisles === undefined ? 1 : sc.parallelAisles;
    if (!(Number.isInteger(k) && k >= 1)) err('parallelAisles는 1 이상의 정수여야 합니다');

    // cranes / zones
    const cranes = Array.isArray(sc.cranes) ? sc.cranes : [];
    if (!cranes.length) err('크레인이 최소 1대 필요합니다');
    const ids = new Set();
    for (const c of cranes) {
      if (!c.id) err('크레인 id가 없습니다');
      else if (ids.has(c.id)) err(`크레인 id 중복: ${c.id}`); else ids.add(c.id);
      const z = c.zone;
      if (!z || !Array.isArray(z.x) || !Array.isArray(z.y) || !(z.x[0] < z.x[1]) || !(z.y[0] < z.y[1]))
        err(`크레인 ${c.id}: zone.x/zone.y는 [lo, hi] (lo < hi)여야 합니다`);
    }
    const bodyW = cr.bodyWidth > 0 ? cr.bodyWidth : 0;
    for (let i = 0; i < cranes.length; i++) for (let j = i + 1; j < cranes.length; j++) {
      const a = cranes[i].zone, b = cranes[j].zone;
      if (!a || !b || !a.x || !b.x) continue;
      if (rectsOverlap(a, b)) { err(`존 중첩: ${cranes[i].id} ↔ ${cranes[j].id} — 존은 겹칠 수 없습니다`); continue; }
      if (rangesOverlap(a.y, b.y)) {                       // 같은 레일 (y 겹침, x 분리)
        const gap = Math.max(b.x[0] - a.x[1], a.x[0] - b.x[1]);
        if (gap < bodyW - EPS) warn(`같은 레일 존 ${cranes[i].id}·${cranes[j].id}의 x 간격 ${gap.toFixed(2)} m < 크레인 폭 ${bodyW} m — 경계에서 충돌 위험(존 경계에 완충 구간 권장)`);
      } else if (rangesOverlap(a.x, b.x)) {                // x 겹침, y 분리 → 상하층
        warn(`존 ${cranes[i].id}·${cranes[j].id}는 x가 겹치고 높이로 분리됨 — 별도 레일(상·하층 크레인) 구성이 필요합니다`);
      }
    }

    // stations
    const stations = Array.isArray(sc.stations) ? sc.stations : [];
    if (!stations.length) err('스테이션이 최소 1개 필요합니다');
    const sids = new Set();
    const zoneStations = cranes.map(() => []);
    let anyIn = 0, anyOut = 0;
    for (const s of stations) {
      if (!s.id) { err('스테이션 id가 없습니다'); continue; }
      if (sids.has(s.id)) err(`스테이션 id 중복: ${s.id}`); else sids.add(s.id);
      if (s.kind !== 'in' && s.kind !== 'out') err(`스테이션 ${s.id}: kind는 in|out`);
      if (!num(s.x) || !num(s.y)) err(`스테이션 ${s.id}: x, y 숫자 필요`);
      if (!(s.capacity >= 1)) err(`스테이션 ${s.id}: capacity ≥ 1`);
      const ar = s.arrival || { type: 'none' };
      if (!ARRIVALS.includes(ar.type)) err(`스테이션 ${s.id}: arrival.type은 ${ARRIVALS.join('|')}`);
      if (ar.type !== 'none' && ar.type !== 'csv' && !(ar.ratePerHour >= 0)) err(`스테이션 ${s.id}: arrival.ratePerHour ≥ 0`);
      if (ar.jitterPct !== undefined && !(ar.jitterPct >= 0 && ar.jitterPct <= 100)) err(`스테이션 ${s.id}: jitterPct 0~100`);
      if (s.kind === 'out' && s.retrieval && !['any', 'fifo'].includes(s.retrieval)) err(`스테이션 ${s.id}: retrieval은 any|fifo`);
      if (s.kind === 'in') anyIn += ar.ratePerHour || 0; else anyOut += ar.ratePerHour || 0;
      if (num(s.x) && num(s.y) && cranes.length) {
        const zi = zoneOf(cranes, s.x, s.y);
        if (zi < 0) err(`스테이션 ${s.id} (${s.x}, ${s.y})가 어느 존에도 속하지 않습니다`);
        else zoneStations[zi].push(s);
      }
    }
    for (const c of cranes) {
      if (c.home && !sids.has(c.home)) err(`크레인 ${c.id}: home 스테이션 '${c.home}'이 없습니다`);
      if (c.home && sids.has(c.home)) {
        const h = stations.find(s => s.id === c.home);
        if (h && c.zone && c.zone.x && !inRect(c.zone, h.x, h.y)) err(`크레인 ${c.id}: home '${c.home}'이 존 밖입니다`);
      }
      if (num(c.x0) && num(c.y0) && c.zone && c.zone.x && !inRect(c.zone, c.x0, c.y0)) err(`크레인 ${c.id}: 초기 위치 (${c.x0}, ${c.y0})가 존 밖입니다`);
    }

    // cells per zone + mass balance
    let cells = [];
    if (!errors.length || (rk.bays >= 1 && rk.levels >= 1 && num(rk.x0) && rk.length > 0 && rk.height > 0)) {
      try { cells = buildCells(rk); } catch (e) { err('셀 생성 실패: ' + e.message); }
    }
    const zoneCells = cranes.map(() => 0);
    let orphan = 0;
    for (const c of cells) { const zi = zoneOf(cranes, c.x, c.y); if (zi < 0) orphan++; else zoneCells[zi]++; }
    if (orphan > 0) warn(`어느 존에도 속하지 않는 셀 ${orphan}개 — 저장·반출에서 제외됩니다`);
    const balance = [];
    cranes.forEach((c, i) => {
      const ins = zoneStations[i].filter(s => s.kind === 'in');
      const outs = zoneStations[i].filter(s => s.kind === 'out');
      const inRate = ins.reduce((a, s) => a + ((s.arrival && s.arrival.ratePerHour) || 0), 0) / (k || 1);
      const outRate = outs.reduce((a, s) => a + ((s.arrival && s.arrival.ratePerHour) || 0), 0) / (k || 1);
      const free = Math.round(zoneCells[i] * (1 - (rk.initialFill || 0)));
      const stock = zoneCells[i] - free;
      const b = { crane: c.id, cells: zoneCells[i], stations: zoneStations[i].map(s => s.id), inRate, outRate, drift: inRate - outRate, free, stock };
      if (zoneCells[i] === 0) err(`존 ${c.id}: 셀이 0개입니다`);
      if (inRate > 0 && outs.length === 0) err(`존 ${c.id}: 입고 ${inRate.toFixed(1)}건/h 유입되지만 출고 스테이션이 없어 반출 불가 → 존이 채워지기만 함 (약 ${free > 0 ? (free / inRate).toFixed(1) : 0} h 후 포화). 존별 출고 스테이션을 배치하거나 조닝을 바꾸세요`);
      if (outRate > 0 && ins.length === 0) warn(`존 ${c.id}: 출고 ${outRate.toFixed(1)}건/h 요구되지만 입고 스테이션이 없어 재고 ${stock}개 소진 후 기아(starved)`);
      if (ins.length && outs.length && Math.abs(b.drift) > 1e-9) {
        if (b.drift > 0) { const h = free / b.drift; b.hoursToFull = h; if (h < (run.durationSec || 0) / 3600) warn(`존 ${c.id}: 입출 수지 +${b.drift.toFixed(1)}건/h → 약 ${h.toFixed(1)} h 후 만재(저장 블로킹 발생 예상)`); else note(`존 ${c.id}: 입출 수지 +${b.drift.toFixed(1)}건/h (만재까지 약 ${h.toFixed(1)} h)`); }
        else { const h = stock / -b.drift; b.hoursToEmpty = h; if (h < (run.durationSec || 0) / 3600) warn(`존 ${c.id}: 입출 수지 ${b.drift.toFixed(1)}건/h → 약 ${h.toFixed(1)} h 후 재고 소진`); else note(`존 ${c.id}: 입출 수지 ${b.drift.toFixed(1)}건/h`); }
      }
      balance.push(b);
    });
    if (anyOut > 0 && cranes.every((c, i) => zoneStations[i].every(s => s.kind !== 'out'))) err('출고 스테이션이 어느 존에도 없습니다');
    if (anyIn === 0 && anyOut === 0 && stations.every(s => !s.arrival || s.arrival.type !== 'csv')) warn('도착률이 모두 0입니다 — 작업이 생성되지 않습니다');

    return { ok: errors.length === 0, errors, warnings, info, zoneStations: zoneStations.map(z => z.map(s => s.id)), zoneCells, balance, cellCount: cells.length };
  }

  return {
    version: '0.1.0', MODES, PAIRINGS, PRIORITIES, STORAGE_RULES, RETRIEVAL_CELLS, ARRIVALS,
    cellCoords, buildCells, inRect, zoneOf, rectsOverlap, rangesOverlap, validate,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCValidate;

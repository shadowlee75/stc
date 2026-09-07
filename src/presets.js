'use strict';
/* ============================================================
 * STC 시뮬레이터 — 프리셋 (presets.js)
 * 시나리오 스키마 stcsim/scenario@1. 단위: m, s, m/s, m/s², 건/h
 * ============================================================ */
const STCPresets = (() => {

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- 차체 저장 설비 Rev.0 (FEM 9.851 준용 계산서, 2026-08-26) ----------
  // 도면: 전장 34,600 = 6,000 + 5,650×4 + 6,000 → 베이 중심 6.0/11.65/17.3/22.95/28.6 m
  // 랙 벽면(FEM 기준면): x0 = 3.175 m, L = 28.25 m, H = 12.67 m (좌측 체인 1,150+2,770+2,850+2,950+2,950 — 확인 요)
  // E/A: E_L0 (1.5, 0) 입고 Sealing 68 · A_L8 (1.5, 8) 출고 92 · E_R8 (33.1, 8) 입고 2tone 22 · E_R0 (33.1, 0) 입고 Repair 3
  // 이재 t_ü = 8.0 s/회(신장 3.1 + 인입 3.1 + 승강·안착 1.8), 정지·전환 1.0 s/개소, 가동률 η = 0.90
  // 저장 용량 30셀(편측 기준 — 확인 필요 No.4). 입출 수지 +1 JPH 드리프트(No.6) → 초기 충전 0.6로 8 h 내 포화 회피
  function carBodyRev0() {
    return {
      schema: 'stcsim/scenario@1',
      name: '차체 저장 설비 Rev.0 — 5 Bay × 6 Level (FEM 9.851 준용)',
      note: '출처: STC 물동량 계산서(FEM 9.851 준용)_Rev0.docx. 확인 필요 사항 7건 반영 전. 운영 전제: 입·출고 복합사이클 페어링.',
      seedBase: 12345,
      run: { durationSec: 8 * 3600, warmupSec: 3600, tsBinSec: 300, sampleSec: 10 },
      rack: {
        bays: 5, levels: 6, sides: 1,
        x0: 3.175, length: 28.25, height: 12.67, aisleLength: 34.6,
        bayX: [6.0, 11.65, 17.3, 22.95, 28.6],
        levelY: [0, 1.15, 3.92, 6.77, 9.72, 12.67],
        depth: 1, initialFill: 0.6, initialFillHours: 2,
        cellDepth: 2.5, aisleWidth: 3.2, loadSize: { l: 4.8, w: 1.9, h: 1.5 },
      },
      crane: {
        axes: {
          x: { v: 175 / 60, a: 0.4, d: 0.4, creepDist: 0, creepV: 0, tDelay: 0 },
          y: { v: 50 / 60, a: 0.5, d: 0.5, creepDist: 0, creepV: 0, tDelay: 0 },
        },
        fork: { v: 1.0, a: 0.6, d: 0.6, stroke: 1.4, lift: 0, tSeat: 1.8, tOverride: 8.0 },
        tPos: 1.0, bodyWidth: 6.0, availability: 0.9,
      },
      stations: [
        { id: 'E_L0', name: '좌 0 m 입고 (Sealing)', kind: 'in', x: 1.5, y: 0, capacity: 2,
          arrival: { type: 'takt', ratePerHour: 68, jitterPct: 10 } },
        { id: 'A_L8', name: '좌 8 m 출고 (TC & 2tone)', kind: 'out', x: 1.5, y: 8.0, capacity: 2,
          arrival: { type: 'takt', ratePerHour: 92, jitterPct: 10, minStock: 1 }, retrieval: 'any', takeAway: null },
        { id: 'E_R8', name: '우 8 m 입고 (2tone 리턴)', kind: 'in', x: 33.1, y: 8.0, capacity: 2,
          arrival: { type: 'takt', ratePerHour: 22, jitterPct: 10 } },
        { id: 'E_R0', name: '우 0 m 입고 (Repair)', kind: 'in', x: 33.1, y: 0, capacity: 1,
          arrival: { type: 'poisson', ratePerHour: 3 } },
      ],
      cranes: [
        { id: 'STC1', zone: { x: [0, 34.6], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
      ],
      policy: { mode: 'DC', pairing: 'fifo', priority: 'oldest-first', storageRule: 'random-empty', retrievalCell: 'random', agingLimit_s: null },
      parallelAisles: 1,
      targets: { rhoMax: 0.8, maxQueue: 3, doneRatioMin: 0.98 },
      hist: { cycle: { binSec: 5, maxSec: 300 }, wait: { binSec: 15, maxSec: 1800 } },
    };
  }

  // ---------- 범용 20 Bay × 10 Level (stc_calculator.py 기본값) ----------
  function generic20x10() {
    return {
      schema: 'stcsim/scenario@1',
      name: '범용 AS/RS 20 Bay × 10 Level (stc_calculator 기본값)',
      note: 'FEM 9.851 Case 1 (E=A 코너). 5구간 저속 접근·지연 포함. 단독사이클 + 복귀.',
      seedBase: 777,
      run: { durationSec: 8 * 3600, warmupSec: 1800, tsBinSec: 300, sampleSec: 10 },
      rack: {
        bays: 20, levels: 10, sides: 2,
        x0: 0, length: 20, height: 20, aisleLength: 22,
        bayX: null, levelY: null,
        depth: 1, initialFill: 0.6, initialFillHours: 4,
        cellDepth: 1.3, aisleWidth: 1.8, loadSize: { l: 1.1, w: 1.1, h: 1.2 },
      },
      crane: {
        axes: {
          x: { v: 100 / 60, a: 0.3, d: 0.3, creepDist: 0.25, creepV: 5 / 60, tDelay: 1.0 + 1.16 + 0.5 },
          y: { v: 30 / 60, a: 0.5, d: 0.5, creepDist: 0.15, creepV: 5 / 60, tDelay: 1.0 + 1.58 + 0.5 },
        },
        fork: { v: 30 / 60, a: 0.5, d: 0.5, stroke: 1.4, lift: 0.11, tSeat: 0, tOverride: 0, creepDist: 0.1, creepV: 5 / 60, tDelay: 0.3 },
        tPos: 0.5, bodyWidth: 1.5, availability: 0.85,
      },
      stations: [
        { id: 'E', name: '입고 E', kind: 'in', x: 0, y: 0, capacity: 3, arrival: { type: 'poisson', ratePerHour: 50 } },
        { id: 'A', name: '출고 A', kind: 'out', x: 0, y: 0, capacity: 3, arrival: { type: 'poisson', ratePerHour: 50, minStock: 1 }, retrieval: 'any', takeAway: null },
      ],
      cranes: [{ id: 'STC1', zone: { x: [-1, 22], y: [0, 20] }, home: 'E', x0: 0, y0: 0 }],
      policy: { mode: 'SC-return', pairing: 'fifo', priority: 'oldest-first', storageRule: 'random-empty', retrievalCell: 'random', agingLimit_s: null },
      parallelAisles: 1,
      targets: { rhoMax: 0.85, maxQueue: 5, doneRatioMin: 0.98 },
      hist: { cycle: { binSec: 5, maxSec: 300 }, wait: { binSec: 15, maxSec: 1800 } },
    };
  }

  // ---------- 검증용: 대형 랙 50 × 15, 단일 코너 스테이션 (PRD 5% 기준 판정용) ----------
  function largeRackValidation() {
    return {
      schema: 'stcsim/scenario@1',
      name: '검증용 대형 랙 50 Bay × 15 Level — 코너 E=A',
      note: 'FEM 9.851 표준 P1/P2 해석식 vs 시뮬레이션 SC-return/DC 비교 (PRD §7.1 < 5%).',
      seedBase: 4242,
      run: { durationSec: 40 * 3600, warmupSec: 3600, tsBinSec: 600, sampleSec: 30 },
      rack: {
        bays: 50, levels: 15, sides: 1,
        x0: 0, length: 100, height: 30, aisleLength: 100,
        bayX: null, levelY: null,
        depth: 1, initialFill: 0.5, initialFillHours: 10,
        cellDepth: 1.3, aisleWidth: 1.8, loadSize: { l: 1.1, w: 1.1, h: 1.2 },
      },
      crane: {
        axes: {
          x: { v: 2.5, a: 0.5, d: 0.5, creepDist: 0, creepV: 0, tDelay: 0 },
          y: { v: 1.0, a: 0.5, d: 0.5, creepDist: 0, creepV: 0, tDelay: 0 },
        },
        fork: { v: 1.0, a: 0.5, d: 0.5, stroke: 1.4, lift: 0.11, tSeat: 0, tOverride: 5.0 },
        tPos: 0.5, bodyWidth: 1.5, availability: 1.0,
      },
      stations: [
        { id: 'E', name: '입고 E (코너)', kind: 'in', x: 0, y: 0, capacity: 5, arrival: { type: 'poisson', ratePerHour: 20 } },
        { id: 'A', name: '출고 A (코너)', kind: 'out', x: 0, y: 0, capacity: 5, arrival: { type: 'poisson', ratePerHour: 20, minStock: 1 }, retrieval: 'any', takeAway: null },
      ],
      cranes: [{ id: 'STC1', zone: { x: [-1, 100], y: [0, 30] }, home: 'E', x0: 0, y0: 0 }],
      policy: { mode: 'SC-return', pairing: 'fifo', priority: 'oldest-first', storageRule: 'random-empty', retrievalCell: 'random', agingLimit_s: null },
      parallelAisles: 1,
      targets: { rhoMax: 0.85, maxQueue: 5, doneRatioMin: 0.98 },
      hist: { cycle: { binSec: 5, maxSec: 400 }, wait: { binSec: 15, maxSec: 1800 } },
    };
  }

  // ---------- 검증용: Bozer & White 정사각-시간 랙 (E(SC)/T = 1 + b²/3) ----------
  // 가속도 1e6 → 등속 근사. 포크·위치결정 0. 코너 E=A, SC-return.
  function bozerWhite(b) {
    const L = 100, H = 100 * (b || 1);
    const levels = Math.round(H);
    return {
      schema: 'stcsim/scenario@1',
      name: `검증용 Bozer & White b=${b || 1}`,
      note: '연속 균일 랙 해석식 E(SC)/T = 1 + b²/3 대조. 셀 전수 열거값과 시뮬 표본평균 비교.',
      seedBase: 99,
      run: { durationSec: 200 * 3600, warmupSec: 3600, tsBinSec: 3600, sampleSec: 600 },
      rack: {
        bays: 100, levels, sides: 1,
        x0: 0, length: L, height: H, aisleLength: L,
        bayX: null, levelY: null,
        depth: 1, initialFill: 0.5, initialFillHours: 100,
        cellDepth: 1, aisleWidth: 1, loadSize: { l: 0.8, w: 0.8, h: 0.8 },
      },
      crane: {
        axes: {
          x: { v: 1.0, a: 1e6, d: 1e6, creepDist: 0, creepV: 0, tDelay: 0 },
          y: { v: 1.0, a: 1e6, d: 1e6, creepDist: 0, creepV: 0, tDelay: 0 },
        },
        fork: { v: 1.0, a: 1.0, d: 1.0, stroke: 0, lift: 0, tSeat: 0, tOverride: 0 },
        tPos: 0, bodyWidth: 1, availability: 1.0,
      },
      stations: [
        { id: 'E', name: 'E', kind: 'in', x: 0, y: 0, capacity: 1000, arrival: { type: 'poisson', ratePerHour: 12 } },
        { id: 'A', name: 'A', kind: 'out', x: 0, y: 0, capacity: 1000, arrival: { type: 'poisson', ratePerHour: 12, minStock: 1 }, retrieval: 'any', takeAway: null },
      ],
      cranes: [{ id: 'STC1', zone: { x: [-1, L], y: [0, H] }, home: 'E', x0: 0, y0: 0 }],
      policy: { mode: 'SC-return', pairing: 'fifo', priority: 'oldest-first', storageRule: 'random-empty', retrievalCell: 'random', agingLimit_s: null },
      parallelAisles: 1,
      targets: { rhoMax: 0.9, maxQueue: 100, doneRatioMin: 0.9 },
      hist: { cycle: { binSec: 5, maxSec: 400 }, wait: { binSec: 15, maxSec: 1800 } },
    };
  }

  const list = [
    { key: 'carBodyRev0', label: '차체 저장 설비 Rev.0 (5×6)', make: carBodyRev0 },
    { key: 'generic20x10', label: '범용 20×10 (stc_calculator 기본값)', make: generic20x10 },
    { key: 'largeRackValidation', label: '검증용 대형 랙 50×15', make: largeRackValidation },
    { key: 'bozerWhite1', label: '검증용 Bozer & White b=1', make: () => bozerWhite(1) },
    { key: 'bozerWhite05', label: '검증용 Bozer & White b=0.5', make: () => bozerWhite(0.5) },
  ];

  function get(key) {
    const p = list.find(x => x.key === key);
    if (!p) throw new Error('알 수 없는 프리셋: ' + key);
    return clone(p.make());
  }

  return { version: '0.1.0', list, get, carBodyRev0, generic20x10, largeRackValidation, bozerWhite, clone };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCPresets;

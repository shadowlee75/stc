'use strict';
/* ============================================================
 * STC 시뮬레이터 — 렌더 모델 (scene.js)
 * 엔진 상태 → 3D/2D 뷰가 그대로 그릴 수 있는 순수 데이터. Three.js 의존 없음(노드 테스트 가능).
 *   layout(scenario) : 정적 기하 (셀 박스 위치·크기, 스테이션 패드, 통로, 바닥 범위)
 *   frame(sim, t)    : 동적 상태 (크레인 위치·상태색·포크 신장·적재, 셀 상태, 스테이션 대기열, 시계)
 * 좌표계: x = 통로 방향(주행), y = 높이(승강), z = 통로 가로(포크). 단위 m.
 * ============================================================ */
const STCScene = (() => {
  const V = (typeof STCValidate !== 'undefined') ? STCValidate : require('./validate.js');
  const En = (typeof STCEngine !== 'undefined') ? STCEngine : require('./engine.js');

  // 검증된 범주 팔레트 슬롯(blue·aqua·yellow) + 상태색(critical) + 중립 회색(유휴)
  const STATE_COLORS = {
    idle: '#c3c2b7', moveEmpty: '#2a78d6', moveLoaded: '#1baf7a', fork: '#eda100', blocked: '#d03b3b', starved: '#d03b3b',
  };
  const STATE_LABELS = {
    idle: '유휴', moveEmpty: '공차 주행', moveLoaded: '적재 주행', fork: '이재(포크)', blocked: '블로킹(빈 셀 없음)', starved: '기아(재고 없음)',
  };
  const CELL_COLORS = { empty: '#cbd5e1', reservedIn: '#93c5fd', occupied: '#64748b', reservedOut: '#fdba74' };

  function median(arr) { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }

  function layout(sc) {
    const rk = sc.rack;
    const { bayX, levelY } = V.cellCoords(rk);
    const cells = V.buildCells(rk);
    const pitchX = bayX.length > 1 ? median(bayX.slice(1).map((x, i) => x - bayX[i])) : rk.length;
    const pitchY = levelY.length > 1 ? median(levelY.slice(1).map((y, i) => y - levelY[i])) : rk.height;
    const depth = rk.cellDepth > 0 ? rk.cellDepth : 1.2;
    const aisleW = rk.aisleWidth > 0 ? rk.aisleWidth : 1.8;
    const load = rk.loadSize || { l: Math.min(1.1, pitchX * 0.8), w: Math.min(1.1, depth * 0.8), h: Math.min(1.2, pitchY * 0.6) };
    const zOf = (side) => (side === 0 ? -1 : 1) * (aisleW / 2 + depth / 2);
    const cellBoxes = cells.map(c => ({ idx: c.idx, bay: c.bay, level: c.level, side: c.side, x: c.x, y: c.y, z: zOf(c.side),
      w: pitchX * 0.96, h: pitchY * 0.92, d: depth }));
    const xs = [rk.x0, rk.x0 + rk.length, ...sc.stations.map(s => s.x), ...sc.cranes.flatMap(c => c.zone.x)];
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yTop = Math.max(rk.height, ...levelY) + pitchY / 2;
    const rackCx = rk.x0 + rk.length / 2;
    const stations = sc.stations.map(s => {
      const inside = s.x >= rk.x0 - 1e-9 && s.x <= rk.x0 + rk.length + 1e-9;
      // 랙 구간 안이면 앞면 랙 자리(side 0), 밖이면 통로 끝(축선) — 포크 방향도 그에 맞춤
      const z = inside ? zOf(0) : 0;
      const forkDir = inside ? { x: 0, z: -1 } : { x: s.x < rackCx ? -1 : 1, z: 0 };
      return { id: s.id, name: s.name || s.id, kind: s.kind, x: s.x, y: s.y, z, forkDir, capacity: s.capacity || 1,
               w: Math.max(pitchX * 0.9, load.l * 1.2), d: inside ? depth : Math.max(depth, load.w * 1.4), h: 0.12 };
    });
    const cranes = sc.cranes.map(c => ({ id: c.id, zone: c.zone, mastW: Math.max(0.35, pitchX * 0.08), carriageW: Math.max(0.8, load.l * 1.05), carriageH: Math.max(0.5, load.h * 0.35) }));
    return {
      cells: cellBoxes, cellIndex: Object.fromEntries(cellBoxes.map(c => [c.idx, c])), pitchX, pitchY, depth, aisleW, load, zOf,
      xMin, xMax, yTop, rackX0: rk.x0, rackX1: rk.x0 + rk.length, height: rk.height, sides: rk.sides,
      stations, cranes, floor: { x0: xMin - pitchX, x1: xMax + pitchX, z0: -(aisleW / 2 + depth) - 1, z1: (aisleW / 2 + depth) + 1 },
    };
  }

  function forkDirOf(lay, act) {
    if (!act) return { x: 0, z: 0 };
    if (act.cell) return { x: 0, z: act.cell.side === 0 ? -1 : 1 };
    if (act.station) { const s = lay.stations.find(q => q.id === act.station.id); return s ? s.forkDir : { x: 0, z: -1 }; }
    return { x: 0, z: 0 };
  }

  // 셀 상태 코드: 0 empty, 1 reservedIn, 2 occupied, 3 reservedOut (포크 진행에 따라 적재물 표시 보정)
  function frame(sim, t) {
    const now = (t === undefined) ? sim.now : t;
    const lay = sim._layout || (sim._layout = layout(sim.sc));
    const cellState = new Uint8Array(sim.cells.length);
    const cellShowLoad = new Uint8Array(sim.cells.length);
    for (const c of sim.cells) { cellState[c.idx] = c.state; cellShowLoad[c.idx] = (c.state === En.OCC || c.state === En.RES_OUT) ? 1 : 0; }
    const cranes = sim.cranes.map(c => {
      const pos = sim.cranePos(c, now);
      const act = c.act;
      let forkExt = 0, loadOnFork = !!c.carrying, dir = { x: 0, z: 0 }, label = '';
      if (act && act.kind === 'fork') {
        forkExt = sim.forkExt(c, now);
        dir = forkDirOf(lay, act);
        const prog = sim.fc.t > 0 ? (now - act.t0) / sim.fc.t : 1;
        if (act.action === 'pick') { loadOnFork = prog >= 0.5; if (act.cell && prog >= 0.5) cellShowLoad[act.cell.idx] = 0; }
        else { loadOnFork = prog < 0.5; if (act.cell && prog >= 0.5) cellShowLoad[act.cell.idx] = 1; else if (act.cell) cellShowLoad[act.cell.idx] = 0; }
        label = (act.action === 'pick' ? '픽업' : '적치') + (act.at === 'cell' ? ' @셀' : ' @' + (act.station ? act.station.id : ''));
      } else if (act && act.kind === 'move') {
        label = act.label || (act.loaded ? '적재 주행' : '공차 주행');
      } else label = STATE_LABELS[c.state] || c.state;
      // 예약된 반출 셀(RES_OUT)은 아직 적재물이 있으므로 표시 유지 (위에서 1로 설정됨)
      return { id: c.id, x: pos.x, y: pos.y, state: c.state, color: STATE_COLORS[c.state] || '#999', stateLabel: STATE_LABELS[c.state] || c.state,
               forkExt, forkDir: dir, loadOnFork, label, pendingIn: c.pendingIn.length, pendingOut: c.pendingOut.length,
               cycleType: c.cycleType, jobs: c.activeJobs.map(j => j.id) };
    });
    const stations = sim.stations.map(s => {
      const n = s.waiting.length;
      const atBuffer = s.kind === 'in' ? Math.min(n, s.capacity) : n;
      return { id: s.id, kind: s.kind, queue: n, atBuffer, backlog: s.kind === 'in' ? Math.max(0, n - s.capacity) : 0, arrivals: s.arrivalsAll, served: s.served };
    });
    const occ = sim.occupiedCount();
    return {
      t: now, cranes, cellState, cellShowLoad, stations,
      kpi: { createdAll: sim.jobs.createdAll, doneAll: sim.jobs.doneAll, occupied: occ, cells: sim.cells.length,
             ratePerHour: now > 0 ? sim.jobs.doneAll / now * 3600 : 0, counting: sim.counting },
    };
  }

  return { version: '0.1.0', STATE_COLORS, STATE_LABELS, CELL_COLORS, layout, frame };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCScene;

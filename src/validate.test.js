'use strict';
const V = require('./validate.js');
const P = require('./presets.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }
const has = (arr, re) => arr.some(m => re.test(m));

// ---------- 1. 기하 ----------
{
  const cells = V.buildCells({ bays: 5, levels: 6, sides: 1, x0: 3.175, length: 28.25, height: 12.67,
    bayX: [6.0, 11.65, 17.3, 22.95, 28.6], levelY: [0, 1.15, 3.92, 6.77, 9.72, 12.67] });
  ok(cells.length === 30, '5×6×1 = 30 셀');
  ok(cells[0].x === 6.0 && cells[0].y === 0 && cells[29].x === 28.6 && cells[29].y === 12.67, '명시 좌표');
  ok(cells[7].idx === 7 && cells[7].bay === 2 && cells[7].level === 1, 'idx = level·bays + bay');
  const uni = V.buildCells({ bays: 4, levels: 2, sides: 2, x0: 10, length: 8, height: 4 });
  ok(uni.length === 16, '4×2×2 = 16 셀');
  near(uni[0].x, 11, 1e-12, '균등 bay 중심 x0+(i+0.5)·pitch'); near(uni[0].y, 1, 1e-12, '균등 level 중심 (i+0.5)·H/levels');
  ok(uni[8].side === 1 && uni[8].bay === 0 && uni[8].level === 0, '2면 idx');
  const zones = [{ zone: { x: [0, 10], y: [0, 5] } }, { zone: { x: [10, 20], y: [0, 5] } }];
  ok(V.zoneOf(zones, 5, 2) === 0 && V.zoneOf(zones, 15, 2) === 1 && V.zoneOf(zones, 25, 2) === -1, 'zoneOf');
  ok(V.zoneOf(zones, 10, 2) === 0, '경계는 첫 존');
  ok(!V.rectsOverlap(zones[0].zone, zones[1].zone), '경계 공유는 비중첩');
  ok(V.rectsOverlap({ x: [0, 11], y: [0, 5] }, zones[1].zone), '내부 중첩 감지');
}

// ---------- 2. 프리셋 전부 유효 ----------
for (const p of P.list) {
  const r = V.validate(P.get(p.key));
  ok(r.ok, `프리셋 ${p.key} 유효: ${r.errors.join(' / ')}`);
}

// ---------- 3. 차체 프리셋 수지·귀속 ----------
{
  const r = V.validate(P.carBodyRev0());
  ok(r.zoneStations[0].length === 4, '스테이션 4개 모두 존 귀속');
  ok(r.zoneCells[0] === 30, '존 셀 30');
  near(r.balance[0].drift, 1, 1e-9, '입출 수지 +1 JPH');
  ok(has(r.warnings.concat(r.info), /수지 \+1\.0/), '드리프트 메시지');
}

// ---------- 4. 좌/우 분할(as-is 스테이션) → 우측 존 출고 없음 → 오류 ----------
{
  const sc = P.carBodyRev0();
  sc.crane.bodyWidth = 6.0;
  sc.cranes = [
    { id: 'STC_L', zone: { x: [0, 17.3 + 5.65 / 2], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'STC_R', zone: { x: [17.3 + 5.65 / 2, 34.6], y: [0, 12.67] }, home: 'E_R0', x0: 33.1, y0: 0 },
  ];
  const r = V.validate(sc);
  ok(!r.ok, 'x2 분할 as-is는 무효');
  ok(has(r.errors, /STC_R.*출고 스테이션이 없어 반출 불가/), '사유: 우측 존 출고 없음');
  ok(has(r.warnings, /같은 레일 존.*간격 0\.00 m < 크레인 폭/), '같은 레일 간격 경고');
  ok(r.zoneStations[1].join(',') === 'E_R8,E_R0', '우측 존 스테이션 귀속');
  // 우측 출고 스테이션 추가 → 유효
  sc.stations.push({ id: 'A_R8', name: '우 8 m 출고(추가)', kind: 'out', x: 33.1, y: 8, capacity: 2, arrival: { type: 'takt', ratePerHour: 25, minStock: 1 }, retrieval: 'any' });
  sc.stations.find(s => s.id === 'A_L8').arrival.ratePerHour = 67;
  const r2 = V.validate(sc);
  ok(r2.ok, 'addOutRight 변형은 유효: ' + r2.errors.join(' / '));
}

// ---------- 5. 상/하 분할 → 하층 존(입고만) 오류 + 별도 레일 경고 ----------
{
  const sc = P.carBodyRev0();
  sc.cranes = [
    { id: 'STC_LO', zone: { x: [0, 34.6], y: [0, 5] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'STC_UP', zone: { x: [0, 34.6], y: [5, 12.67] }, home: 'A_L8', x0: 1.5, y0: 8 },
  ];
  const r = V.validate(sc);
  ok(!r.ok && has(r.errors, /STC_LO.*반출 불가/), 'y2 분할: 하층 반출 불가');
  ok(has(r.warnings, /별도 레일/), '별도 레일 경고');
}

// ---------- 6. 존 중첩·스테이션 미귀속·home 오류 ----------
{
  const sc = P.carBodyRev0();
  sc.cranes = [
    { id: 'A', zone: { x: [0, 20], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'B', zone: { x: [15, 34.6], y: [0, 12.67] }, home: 'E_R0', x0: 33.1, y0: 0 },
  ];
  const r = V.validate(sc);
  ok(has(r.errors, /존 중첩: A ↔ B/), '존 중첩 오류');
  const sc2 = P.carBodyRev0();
  sc2.cranes[0].zone = { x: [5, 30], y: [0, 12.67] };
  const r2 = V.validate(sc2);
  ok(has(r2.errors, /E_L0.*어느 존에도 속하지 않습니다/), '스테이션 미귀속 오류');
  ok(has(r2.errors, /home 'E_L0'이 존 밖/), 'home 존 밖 오류');
  const sc3 = P.carBodyRev0();
  sc3.policy.mode = 'DUAL';
  ok(has(V.validate(sc3).errors, /policy\.mode/), '정책 enum 오류');
  const sc4 = P.carBodyRev0();
  sc4.run.warmupSec = sc4.run.durationSec;
  ok(has(V.validate(sc4).errors, /워밍업/), '워밍업 ≥ 런 오류');
}

// ---------- 7. issues 구조와 target (UI 가 해당 칸을 표시·이동하는 근거) ----------
{
  const tgt = (issues, re) => { const it = issues.find(i => re.test(i.msg)); return it ? it.target : undefined; };
  // 문자열 배열과 issues 가 일치해야 한다 (기존 호출부 호환)
  const r0 = V.validate(P.carBodyRev0());
  ok(Array.isArray(r0.issues), 'issues 배열');
  ok(r0.issues.filter(i => i.level === 'error').map(i => i.msg).join('|') === r0.errors.join('|'), 'issues → errors 일치');
  ok(r0.issues.filter(i => i.level === 'warn').map(i => i.msg).join('|') === r0.warnings.join('|'), 'issues → warnings 일치');
  ok(r0.issues.filter(i => i.level === 'info').map(i => i.msg).join('|') === r0.info.join('|'), 'issues → info 일치');
  ok(r0.issues.every(i => 'target' in i && 'level' in i && 'msg' in i), '모든 issue 가 level·msg·target 보유');

  // 크레인 행 지목: home 없음 / 초기 위치 존 밖
  const sc = P.carBodyRev0();
  sc.cranes[0].home = 'NOPE'; sc.cranes[0].x0 = 999;
  const r = V.validate(sc);
  const home = tgt(r.issues, /home 스테이션 'NOPE'이 없습니다/);
  ok(home && home.type === 'crane' && home.id === 'STC1' && home.col === 'home', 'home 오류 → 크레인 행 home 열');
  const pos = tgt(r.issues, /초기 위치 .*존 밖/);
  ok(pos && pos.type === 'crane' && pos.id === 'STC1' && pos.col === 'x0', '초기 위치 오류 → 크레인 행 x0 열');

  // 존에 안 속한 셀 → 크레인·존 표 전체
  const sc2 = P.carBodyRev0();
  sc2.cranes[0].zone.x = [0, 15];
  const orphan = tgt(V.validate(sc2).issues, /어느 존에도 속하지 않는 셀/);
  ok(orphan && orphan.type === 'craneTable', '고아 셀 경고 → 크레인·존 표');

  // 스테이션 행 지목: 존 미귀속 / 용량
  const sc3 = P.carBodyRev0();
  sc3.cranes[0].zone.x = [5, 30];
  const off = tgt(V.validate(sc3).issues, /E_L0 .*어느 존에도 속하지 않습니다/);
  ok(off && off.type === 'station' && off.id === 'E_L0' && off.col === 'x', '스테이션 존 미귀속 → 스테이션 행 x 열');
  const sc4 = P.carBodyRev0();
  sc4.stations[1].capacity = 0;
  const cap = tgt(V.validate(sc4).issues, /A_L8: capacity/);
  ok(cap && cap.type === 'station' && cap.id === 'A_L8' && cap.col === 'capacity', 'capacity 오류 → 해당 열');
  const sc5 = P.carBodyRev0();
  sc5.stations[0].arrival.ratePerHour = -1;
  const rate = tgt(V.validate(sc5).issues, /ratePerHour/);
  ok(rate && rate.col === 'arrival.ratePerHour', '도착률 오류 → arrival.ratePerHour 열');

  // 폼 입력 지목
  const sc6 = P.carBodyRev0();
  sc6.run.warmupSec = sc6.run.durationSec;
  const wu = tgt(V.validate(sc6).issues, /워밍업/);
  ok(wu && wu.type === 'field' && wu.path === 'run.warmupSec', '워밍업 오류 → 폼 필드 경로');
  const sc7 = P.carBodyRev0();
  sc7.policy.mode = 'DUAL';
  const md = tgt(V.validate(sc7).issues, /policy\.mode/);
  ok(md && md.type === 'field' && md.path === 'policy.mode', '정책 오류 → 폼 필드 경로');
  const sc8 = P.carBodyRev0();
  sc8.crane.axes.x.v = 0;
  const av = tgt(V.validate(sc8).issues, /주행.*정격속도/);
  ok(av && av.path === 'crane.axes.x.v', '축 속도 오류 → 해당 폼 필드');
  const sc9 = P.carBodyRev0();
  sc9.rack.levels = 4;                       // levelY 길이 6 과 불일치
  const lv = tgt(V.validate(sc9).issues, /levelY 길이/);
  ok(lv && lv.path === 'rack.levels', 'levelY 불일치 → 단 수 필드');

  // 존 관련 오류는 zone 열을 가리킨다
  const sc10 = P.carBodyRev0();
  sc10.cranes = [
    { id: 'L', zone: { x: [0, 17.3], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'R', zone: { x: [17.3, 34.6], y: [0, 12.67] }, home: 'E_R0', x0: 33.1, y0: 0 },
  ];
  const rr = V.validate(sc10);
  const noOut = tgt(rr.issues, /R: 입고 .*반출 불가/);
  ok(noOut && noOut.type === 'crane' && noOut.id === 'R' && noOut.col === 'zone', '반출 불가 → 해당 크레인 zone 열');
  const sc11 = P.carBodyRev0();
  sc11.cranes = [
    { id: 'A', zone: { x: [0, 20], y: [0, 12.67] }, home: 'E_L0', x0: 1.5, y0: 0 },
    { id: 'B', zone: { x: [15, 34.6], y: [0, 12.67] }, home: 'E_R0', x0: 33.1, y0: 0 },
  ];
  const ov = tgt(V.validate(sc11).issues, /존 중첩/);
  ok(ov && ov.type === 'crane' && ov.id === 'B' && ov.col === 'zone', '존 중첩 → 뒤쪽 크레인 zone 열');
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

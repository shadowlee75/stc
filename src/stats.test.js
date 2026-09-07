'use strict';
const S = require('./stats.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. t 분위 ----------
near(S.tInv95(1), 12.706, 1e-9, 't(1)');
near(S.tInv95(9), 2.262, 1e-9, 't(9)');
near(S.tInv95(29), 2.045, 1e-9, 't(29)');
near(S.tInv95(35), 2.030, 0.005, 't(35) 보간');
near(S.tInv95(1000), 1.962, 0.005, 't(1000) → 1.96 부근');
ok(S.tInv95(50) < S.tInv95(40) && S.tInv95(50) > S.tInv95(60), 't 단조');

// ---------- 2. summarize ----------
{
  const r = S.summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  near(r.mean, 5, 1e-12, '평균');
  near(r.sd, Math.sqrt(32 / 7), 1e-12, '표본 SD');
  near(r.ci95, 2.365 * Math.sqrt(32 / 7) / Math.sqrt(8), 1e-9, '95% CI 반폭');
  ok(r.n === 8 && r.min === 2 && r.max === 9, 'n/min/max');
  const one = S.summarize([3]);
  ok(one.n === 1 && one.sd === 0 && one.ci95 === 0, '표본 1개');
  ok(S.summarize([]).n === 0, '빈 표본');
}

// ---------- 3. TimeWeighted ----------
{
  const tw = new S.TimeWeighted(0, 1);
  tw.set(2, 3);
  near(tw.mean(4), 2, 1e-12, '시간가중 평균 (1×2 + 3×2)/4');
  tw.reset(4); tw.set(5, 0);
  near(tw.mean(6), 1.5, 1e-12, '리셋 후 (3×1 + 0×1)/2');
  ok(tw.max === 3, 'max 추적');
  let threw = false; try { tw.set(1, 0); } catch (e) { threw = true; }
  ok(threw, '시간 역행 예외');
}

// ---------- 4. StateClock ----------
{
  const c = new S.StateClock(['idle', 'move', 'fork'], 0, 'idle');
  c.enter(3, 'move'); c.enter(8, 'fork'); c.enter(10, 'idle');
  const s = c.snapshot(12);
  ok(s.idle === 5 && s.move === 5 && s.fork === 2, '상태 시간 3/5/2 + 잔여 2');
  c.reset(12); c.enter(13, 'move');
  const s2 = c.snapshot(15);
  ok(s2.idle === 1 && s2.move === 2 && s2.fork === 0, '리셋 후 누적');
}

// ---------- 5. Hist ----------
{
  const h = new S.Hist(5, 20);            // 빈 0-5,5-10,10-15,15-20, overflow
  for (const x of [0, 4.99, 5, 12, 19.9, 20, 99]) h.add(x);
  ok(h.counts.join(',') === '2,1,1,1,2', '빈 분포 + overflow');
  near(h.mean(), (0 + 4.99 + 5 + 12 + 19.9 + 20 + 99) / 7, 1e-9, 'hist 평균');
  const j = h.toJSON();
  ok(j.count === 7 && j.max === 99 && j.min === 0, 'toJSON');
  h.reset(); ok(h.count === 0 && h.counts.every(c => c === 0), 'reset');
}

// ---------- 6. quantile ----------
{
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  near(S.quantile(arr, 0.5), 5.5, 1e-12, '중앙값');
  near(S.quantile(arr, 0.95), 9.55, 1e-12, 'p95 보간');
  near(S.quantile([7], 0.95), 7, 1e-12, '단일');
}

// ---------- 7. flatten / aggregateReps ----------
{
  const rep = (busy, done) => ({
    schema: 'x', jobs: { done, in: { done: done - 1 } },
    cranes: [{ id: 'STC1', busy, stateTime: { idle: 1 - busy } }, { id: 'STC2', busy: busy / 2 }],
    flags: { saturated: false },
    hist: { wait: { binSize: 1, maxVal: 2, counts: [1, 2, 3], count: 6 } },
    ts: { binSec: 10, done: [1, 2, 3], queue: { A: [0, 1, 2] } },
  });
  const f = S.flatten(rep(0.8, 10));
  ok(f['jobs.done'] === 10 && f['jobs.in.done'] === 9, '중첩 숫자');
  ok(f['cranes.STC1.busy'] === 0.8 && f['cranes.STC2.busy'] === 0.4, 'id 키잉');
  ok(f['flags.saturated'] === 0, 'bool → 0/1');
  ok(f['hist.wait.count'] === undefined && f['ts.binSec'] === undefined, 'hist/ts 제외');
  const a = S.aggregateReps([rep(0.8, 10), rep(0.6, 14), rep(0.7, 12)]);
  near(a.agg['cranes.STC1.busy'].mean, 0.7, 1e-12, '집계 평균');
  near(a.agg['jobs.done'].sd, 2, 1e-12, '집계 SD');
  ok(a.histSum.wait.counts.join(',') === '3,6,9' && a.histSum.wait.count === 18, '히스토그램 합산');
  ok(a.tsMean.done.join(',') === '1,2,3' && a.tsMean.queue.A.join(',') === '0,1,2', '시계열 평균');
  ok(a.n === 3, 'n');
}

// ---------- 8. CSV ----------
{
  const csv = S.toCsv([{ a: 1, b: 'x,y', c: 'he said "hi"' }, { a: 2.5, b: 'plain', c: '' }], ['a', 'b', 'c']);
  ok(csv.charCodeAt(0) === 0xFEFF, 'BOM');
  const lines = csv.slice(1).split('\r\n');
  ok(lines[0] === 'a,b,c', '헤더');
  ok(lines[1] === '1,"x,y","he said ""hi"""', '이스케이프');
  ok(lines[2] === '2.5,plain,', '숫자·빈값');
  const csv2 = S.toCsv([{ v: 1 / 3 }], [{ label: '값', get: r => r.v }]);
  ok(csv2.includes('값') && csv2.includes('0.333333'), '컬럼 객체 + 유효숫자');
}

console.log(`결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

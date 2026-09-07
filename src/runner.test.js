'use strict';
const R = require('./runner.js');
const P = require('./presets.js');
const E = require('./engine.js');
const S = require('./stats.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('FAIL: ' + name); } }
function near(x, y, tol, name) { ok(Math.abs(x - y) <= tol, name + ` (got ${x}, want ${y}±${tol})`); }

// ---------- 1. 작업 전개: 공통난수 ----------
{
  const a = P.carBodyRev0(), b = P.carBodyRev0(); b.policy.mode = 'SC-stay';
  const jobs = R.expandJobs([{ id: 'A', scenario: a }, { id: 'B', scenario: b }], 3, 1000);
  ok(jobs.length === 6, '2 × 3 = 6');
  ok(jobs[0].seed === 1000 && jobs[2].seed === 1002 && jobs[3].seed === 1000, 'rep seed = seedBase + rep (시나리오 간 동일)');
  const j2 = R.expandJobs([{ id: 'A', scenario: a }], 2);
  ok(j2[1].seed === a.seedBase + 1, 'seedBase 생략 시 시나리오 seedBase');
}

// ---------- 2. 접기 == 일괄 집계 ----------
{
  const sc = P.carBodyRev0(); sc.run.durationSec = 2 * 3600; sc.run.warmupSec = 600; sc.parallelAisles = 3;
  const jobs = R.expandJobs([{ id: 'A', scenario: sc }], 3, 5);
  const results = jobs.map(j => ({ rowId: j.rowId, rep: j.rep, seed: j.seed, result: E.runScenario(j.scenario, { rep: j.rep, seed: j.seed }) }));
  const folded = R.foldResults(results);
  const direct = S.aggregateReps(results.map(r => r.result));
  ok(folded.A.reps === 3 && folded.A.n === 3, 'reps 3');
  near(folded.A.agg['throughput.perHour'].mean, direct.agg['throughput.perHour'].mean, 1e-12, '접기 평균 == 일괄');
  near(folded.A.agg['throughput.perHour'].ci95, direct.agg['throughput.perHour'].ci95, 1e-12, '접기 CI == 일괄');
  ok(R.foldResults([{ rowId: 'X', rep: 0, result: null }]).X === undefined, '실패 결과 제외');
}

// ---------- 3. 메인스레드 폴백 실행 (노드에서는 Worker 없음) ----------
{
  const sc = P.carBodyRev0(); sc.run.durationSec = 3600; sc.run.warmupSec = 300;
  const pool = new R.Pool({ size: 2 });
  let prog = 0;
  pool.run(R.expandJobs([{ id: 'A', scenario: sc }], 2, 7), (d, t) => { prog = d; }).then(res => {
    ok(pool.mode === 'main', '노드: main 모드');
    ok(res.length === 2 && res.every(r => r.result && r.result.schema === 'stcsim/rep@1'), '결과 2건');
    ok(prog === 2, '진행률 2/2');
    const direct = E.runScenario(sc, { rep: 1, seed: 8 });
    ok(JSON.stringify(res[1].result) === JSON.stringify(direct), '폴백 결과 == 직접 실행 (같은 seed)');
    console.log(`결과: ${pass} PASS / ${fail} FAIL`);
    if (fail) process.exit(1);
  });
}

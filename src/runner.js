'use strict';
/* ============================================================
 * STC 시뮬레이터 — 배치 실행기 (runner.js)
 * 페이지의 <script class="engine"> 블록 텍스트로 Worker 소스를 만들어 풀로 실행한다.
 * ping/pong 감지(500 ms) 실패 시 메인스레드 setTimeout 슬라이스로 폴백.
 * 순수 함수(expandJobs, foldResults)는 노드 테스트 가능.
 * ============================================================ */
const STCRunner = (() => {
  const St = (typeof STCStats !== 'undefined') ? STCStats : require('./stats.js');

  // ---------- 순수: 작업 전개 · 집계 ----------
  // rows: [{id, scenario}] → jobs [{rowId, rep, seed, scenario}]  (rep seed = seedBase + rep → 시나리오 간 공통난수)
  function expandJobs(rows, reps, seedBase) {
    const jobs = [];
    for (const r of rows) for (let rep = 0; rep < reps; rep++) jobs.push({ rowId: r.id, rep, seed: (seedBase !== undefined ? seedBase : (r.scenario.seedBase || 0)) + rep, scenario: r.scenario });
    return jobs;
  }
  // results: [{rowId, rep, result}] → {rowId: aggregate}
  function foldResults(results) {
    const by = {};
    for (const r of results) { if (!r || !r.result) continue; (by[r.rowId] = by[r.rowId] || []).push(r.result); }
    const out = {};
    for (const [id, reps] of Object.entries(by)) out[id] = { ...St.aggregateReps(reps), reps: reps.length };
    return out;
  }

  // ---------- Worker 소스 ----------
  function workerMain() {
    self.onmessage = function (e) {
      const d = e.data || {};
      if (d.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
      if (d.type === 'run') {
        try {
          const r = STCEngine.runScenario(d.scenario, { rep: d.rep, seed: d.seed });
          self.postMessage({ type: 'done', id: d.id, result: r });
        } catch (err) { self.postMessage({ type: 'error', id: d.id, error: String((err && err.message) || err) }); }
      }
    };
  }
  function engineSource() {
    if (typeof document === 'undefined') return null;
    const blocks = Array.from(document.querySelectorAll('script.engine'));
    if (!blocks.length) return null;
    return blocks.map(b => b.textContent).join('\n;\n') + '\n;(' + workerMain.toString() + ')();';
  }

  // ---------- 풀 ----------
  class Pool {
    constructor(opt) {
      opt = opt || {};
      this.size = Math.max(1, Math.min(opt.size || ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency - 1 : 2), 8));
      this.mode = 'unknown'; this.workers = []; this.cancelled = false; this.busy = false;
    }
    async detect() {
      const src = engineSource();
      if (!src || typeof Worker === 'undefined') { this.mode = 'main'; return this.mode; }
      let url = null;
      try {
        url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
        const w = new Worker(url);
        const ok = await new Promise((res) => {
          const to = setTimeout(() => res(false), 700);
          w.onmessage = (e) => { if (e.data && e.data.type === 'pong') { clearTimeout(to); res(true); } };
          w.onerror = () => { clearTimeout(to); res(false); };
          w.postMessage({ type: 'ping' });
        });
        if (ok) { this.workers.push(w); this.url = url; this.mode = 'worker'; }
        else { try { w.terminate(); } catch (e) { /* ignore */ } this.mode = 'main'; }
      } catch (e) { this.mode = 'main'; }
      return this.mode;
    }
    _ensureWorkers() {
      while (this.workers.length < this.size) this.workers.push(new Worker(this.url));
    }
    cancel() { this.cancelled = true; }
    // jobs: [{rowId, rep, seed, scenario}], onProgress(done, total, last) → Promise<[{rowId, rep, seed, result|null, error}]>
    async run(jobs, onProgress) {
      if (this.mode === 'unknown') await this.detect();
      this.cancelled = false; this.busy = true;
      const results = new Array(jobs.length); let done = 0;
      const report = (i) => { done++; if (onProgress) onProgress(done, jobs.length, results[i]); };
      try {
        if (this.mode === 'worker') {
          this._ensureWorkers();
          let next = 0;
          await Promise.all(this.workers.map(w => new Promise((resolve) => {
            const feed = () => {
              if (this.cancelled || next >= jobs.length) { resolve(); return; }
              const i = next++; const j = jobs[i];
              w.onmessage = (e) => {
                const d = e.data || {};
                if (d.type === 'done') results[i] = { rowId: j.rowId, rep: j.rep, seed: j.seed, result: d.result };
                else results[i] = { rowId: j.rowId, rep: j.rep, seed: j.seed, result: null, error: d.error || 'unknown' };
                report(i); feed();
              };
              w.onerror = (err) => { results[i] = { rowId: j.rowId, rep: j.rep, seed: j.seed, result: null, error: String(err.message || err) }; report(i); feed(); };
              w.postMessage({ type: 'run', id: i, scenario: j.scenario, rep: j.rep, seed: j.seed });
            };
            feed();
          })));
        } else {
          const Eng = (typeof STCEngine !== 'undefined') ? STCEngine : require('./engine.js');
          for (let i = 0; i < jobs.length; i++) {
            if (this.cancelled) break;
            const j = jobs[i];
            await new Promise(r => setTimeout(r, 0));
            try { results[i] = { rowId: j.rowId, rep: j.rep, seed: j.seed, result: Eng.runScenario(j.scenario, { rep: j.rep, seed: j.seed }) }; }
            catch (err) { results[i] = { rowId: j.rowId, rep: j.rep, seed: j.seed, result: null, error: String(err.message || err) }; }
            report(i);
          }
        }
      } finally { this.busy = false; }
      return results.filter(Boolean);
    }
    terminate() { for (const w of this.workers) { try { w.terminate(); } catch (e) { /* ignore */ } } this.workers = []; }
  }

  return { version: '0.1.0', expandJobs, foldResults, engineSource, workerMain, Pool };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCRunner;

'use strict';
/* ============================================================
 * STC 시뮬레이터 — 이산사건 엔진 (engine.js)
 * 순수 DES(이진힙 이벤트 큐) + 연속 보간(크레인 posAt). DOM 의존 없음 → Worker 탑재.
 *
 * 엔티티: Cell(empty|reservedIn|occupied|reservedOut) · Station(in|out, 대기열, 용량→백로그) ·
 *         Crane(존 1개 전담, 계획 실행기: move|fork act 순차) · Job(in|out)
 * 정책:   mode SC-return|SC-stay|DC · pairing fifo|nearest · priority oldest-first|storage-first|
 *         retrieval-first|alternate · storageRule random-empty|closest-open · retrievalCell random|fifo|nearest
 * 통계:   상태별 시간가중, 스테이션 대기열 시간가중, 대기·사이클 히스토그램, 시계열 빈, 워밍업 리셋
 * 결정성: rep seed → 목적별 RNG 스트림(도착:스테이션별, 셀 선택, 초기 충전). Math.random 미사용.
 * ============================================================ */
const STCEngine = (() => {
  const Kin = (typeof STCKin !== 'undefined') ? STCKin : require('./kin.js');
  const Rng = (typeof STCRng !== 'undefined') ? STCRng : require('./rng.js');
  const St = (typeof STCStats !== 'undefined') ? STCStats : require('./stats.js');
  const V = (typeof STCValidate !== 'undefined') ? STCValidate : require('./validate.js');

  const EMPTY = 0, RES_IN = 1, OCC = 2, RES_OUT = 3;
  const STATES = ['idle', 'moveEmpty', 'moveLoaded', 'fork', 'blocked', 'starved'];
  const BUSY = new Set(['moveEmpty', 'moveLoaded', 'fork']);

  // ---------- 이벤트 힙 (t, seq) ----------
  class Heap {
    constructor() { this.a = []; this.seq = 0; }
    get size() { return this.a.length; }
    push(t, type, data) {
      const ev = { t, seq: this.seq++, type, data };
      const a = this.a; a.push(ev);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (Heap.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
      }
      return ev;
    }
    peek() { return this.a[0]; }
    pop() {
      const a = this.a; const top = a[0]; const last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && Heap.less(a[l], a[m])) m = l;
          if (r < a.length && Heap.less(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]]; i = m;
        }
      }
      return top;
    }
    static less(x, y) { return x.t < y.t || (x.t === y.t && x.seq < y.seq); }
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- 시뮬레이션 ----------
  class Sim {
    constructor(scenario, opt) {
      opt = opt || {};
      const sc = clone(scenario);
      this.sc = sc;
      this.rep = opt.rep || 0;
      this.seed = (opt.seed !== undefined) ? opt.seed : ((sc.seedBase || 0) + this.rep);
      this.debug = !!opt.debug;
      const val = V.validate(sc);
      this.validation = val;
      if (!val.ok && !opt.skipValidate) throw new Error('시나리오 오류: ' + val.errors.join(' / '));

      this.k = Math.max(1, Math.round(sc.parallelAisles || 1));
      this.rng = Rng.makeStreams(this.seed);
      this.models = Kin.makeModels(sc.crane.axes);
      this.fc = Kin.forkCycle(sc.crane.fork);
      this.tPos = +sc.crane.tPos || 0;
      this.duration = sc.run.durationSec; this.warmup = sc.run.warmupSec;
      this.statSec = this.duration - this.warmup;
      this.binSec = sc.run.tsBinSec; this.sampleSec = sc.run.sampleSec;
      this.nBins = Math.max(1, Math.ceil(this.statSec / this.binSec));
      this.now = 0; this.heap = new Heap(); this.counting = this.warmup <= 0;
      this.jobSeq = 0; this.bodySeq = 0;
      this.zoneViolations = 0;

      // 크레인·존
      this.cranes = sc.cranes.map((c, i) => ({
        idx: i, id: c.id, zone: c.zone, homeId: c.home || null, home: null,
        x: (c.x0 !== undefined ? c.x0 : c.zone.x[0]), y: (c.y0 !== undefined ? c.y0 : c.zone.y[0]),
        state: 'idle', clock: new St.StateClock(STATES, 0, 'idle'),
        plan: [], act: null, carrying: null, cycleType: null, cycleStart: 0, activeJobs: [],
        pendingIn: [], pendingOut: [], lastType: 'out',
        moves: 0, distX: 0, distY: 0,
        cycles: { scIn: 0, scOut: 0, dc: 0 }, cycleSum: { scIn: 0, scOut: 0, dc: 0 },
        cellsEmpty: 0, cellsOcc: 0,
      }));

      // 셀
      this.cells = V.buildCells(sc.rack).map(c => ({ ...c, state: EMPTY, load: null, tStored: 0, zone: V.zoneOf(this.cranes, c.x, c.y) }));
      this.zoneCells = this.cranes.map(() => []);
      for (const c of this.cells) if (c.zone >= 0) this.zoneCells[c.zone].push(c);

      // 스테이션
      this.stations = sc.stations.map((s, i) => {
        const zone = V.zoneOf(this.cranes, s.x, s.y);
        const ar = s.arrival || { type: 'none' };
        return {
          idx: i, id: s.id, name: s.name || s.id, kind: s.kind, x: s.x, y: s.y, capacity: s.capacity || 1, zone,
          arrival: { ...ar, ratePerHour: (ar.ratePerHour || 0) / this.k }, retrieval: s.retrieval || 'any',
          waiting: [], arrivals: 0, served: 0, arrivalsAll: 0,
          qTW: new St.TimeWeighted(0, 0), blockedTW: new St.TimeWeighted(0, 0),
          waits: [], backlogMax: 0, maxQueue: 0,
          rng: this.rng.get('arr:' + s.id),
        };
      });
      this.stationById = Object.fromEntries(this.stations.map(s => [s.id, s]));
      for (const c of this.cranes) c.home = c.homeId ? this.stationById[c.homeId] : null;

      // 초기 충전 (존별, 'init' 스트림)
      const initRng = this.rng.get('init');
      const fillHours = (sc.rack.initialFillHours || 1) * 3600;
      this.cranes.forEach((c, zi) => {
        const zc = this.zoneCells[zi];
        const n = Math.round(zc.length * (sc.rack.initialFill || 0));
        const order = zc.slice();
        for (let i = order.length - 1; i > 0; i--) { const j = initRng.int(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        for (let i = 0; i < n; i++) {
          const cell = order[i];
          cell.state = OCC; cell.load = this.newBody(); cell.tStored = -initRng.uniform(0, fillHours);
        }
        c.cellsOcc = n; c.cellsEmpty = zc.length - n;
      });

      // 통계 컨테이너
      const H = sc.hist || {};
      const cyc = H.cycle || { binSec: 5, maxSec: 300 }, wt = H.wait || { binSec: 15, maxSec: 1800 };
      this.hist = {
        cycleScIn: new St.Hist(cyc.binSec, cyc.maxSec), cycleScOut: new St.Hist(cyc.binSec, cyc.maxSec), cycleDc: new St.Hist(cyc.binSec, cyc.maxSec),
        waitIn: new St.Hist(wt.binSec, wt.maxSec), waitOut: new St.Hist(wt.binSec, wt.maxSec),
      };
      this.ts = {
        done: new Array(this.nBins).fill(0), doneIn: new Array(this.nBins).fill(0), doneOut: new Array(this.nBins).fill(0),
        qSum: Object.fromEntries(this.stations.map(s => [s.id, new Array(this.nBins).fill(0)])),
        busySum: Object.fromEntries(this.cranes.map(c => [c.id, new Array(this.nBins).fill(0)])),
        fillSum: new Array(this.nBins).fill(0), nSample: new Array(this.nBins).fill(0),
        totalWaitSamples: [],
      };
      this.jobs = { createdAll: 0, doneAll: 0, created: 0, done: 0, inCreated: 0, inDone: 0, outCreated: 0, outDone: 0, unservable: 0 };
      this.fillTW = new St.TimeWeighted(0, this.occupiedCount() / Math.max(1, this.cells.length));
      this.fillMin = this.fillTW.v; this.fillMax = this.fillTW.v; this.fullTime = 0; this.emptyTime = 0;

      // 이벤트 초기화
      for (const s of this.stations) this.scheduleFirstArrival(s);
      this.scheduleCsv(sc.arrivalsCsv);
      for (let t = this.sampleSec; t <= this.duration + 1e-9; t += this.sampleSec) this.heap.push(t, 'SAMPLE', null);
      if (this.warmup > 0) this.heap.push(this.warmup, 'WARMUP_END', null);
      this.heap.push(this.duration, 'END', null);
      for (const c of this.cranes) this.tryDispatch(c);
    }

    newBody() { return { id: 'B' + String(++this.bodySeq).padStart(5, '0') }; }
    occupiedCount() { let n = 0; for (const c of this.cells) if (c.state === OCC || c.state === RES_OUT) n++; return n; }

    // ---------- 도착 ----------
    scheduleFirstArrival(s) {
      const ar = s.arrival;
      if (!ar || ar.type === 'none' || ar.type === 'csv' || !(ar.ratePerHour > 0)) return;
      const T = 3600 / ar.ratePerHour;
      const t = ar.type === 'takt' ? s.rng.uniform(0, T) : s.rng.exp(1 / T);
      this.heap.push(t, 'ARRIVAL', s);
    }
    scheduleNextArrival(s) {
      const ar = s.arrival;
      if (!ar || ar.type === 'none' || ar.type === 'csv' || !(ar.ratePerHour > 0)) return;
      const T = 3600 / ar.ratePerHour;
      let dt;
      if (ar.type === 'takt') { const j = (ar.jitterPct || 0) / 100; dt = T * (1 + j * s.rng.uniform(-1, 1)); }
      else dt = s.rng.exp(1 / T);
      this.heap.push(this.now + dt, 'ARRIVAL', s);
    }
    scheduleCsv(csv) {
      if (!csv || typeof csv !== 'string') return;
      for (const line of csv.split(/\r?\n/)) {
        const m = line.trim().split(/[,\t;]\s*/);
        if (m.length < 2 || !Number.isFinite(+m[0])) continue;
        const s = this.stationById[m[1].trim()];
        if (!s) continue;
        this.heap.push(+m[0], 'ARRIVAL', s);
      }
    }

    // ---------- 시간 전진 ----------
    advanceTo(t) {
      if (t > this.duration) t = this.duration;
      while (this.heap.size && this.heap.peek().t <= t + 1e-12) {
        const ev = this.heap.pop();
        this.now = ev.t;
        this.handle(ev);
      }
      this.now = t;
      return this;
    }
    run() { this.advanceTo(this.duration); return this.result(); }
    get finished() { return this.now >= this.duration - 1e-12; }

    handle(ev) {
      switch (ev.type) {
        case 'ARRIVAL': this.onArrival(ev.data); break;
        case 'CRANE_STEP': this.completeAct(ev.data); break;
        case 'SAMPLE': this.onSample(); break;
        case 'WARMUP_END': this.resetStats(); break;
        case 'END': break;
      }
    }

    // ---------- 통계 보조 ----------
    bin() { return Math.min(this.nBins - 1, Math.max(0, Math.floor((this.now - this.warmup) / this.binSec))); }
    setState(c, state) {
      if (c.state === state) return;
      c.clock.enter(this.now, state); c.state = state;
    }
    updateQueue(s) {
      const n = s.waiting.length;
      s.qTW.set(this.now, n);
      if (n > s.maxQueue) s.maxQueue = n;
      const backlog = s.kind === 'in' ? Math.max(0, n - s.capacity) : 0;
      if (backlog > s.backlogMax) s.backlogMax = backlog;
      s.blockedTW.set(this.now, backlog > 0 ? 1 : 0);
    }
    updateFill() {
      const f = this.occupiedCount() / Math.max(1, this.cells.length);
      this.fillTW.set(this.now, f);
      if (f < this.fillMin) this.fillMin = f; if (f > this.fillMax) this.fillMax = f;
    }
    resetStats() {
      this.counting = true;
      for (const c of this.cranes) { c.clock.reset(this.now); c.cycles = { scIn: 0, scOut: 0, dc: 0 }; c.cycleSum = { scIn: 0, scOut: 0, dc: 0 }; c.moves = 0; c.distX = 0; c.distY = 0; }
      for (const s of this.stations) { s.qTW.reset(this.now); s.blockedTW.reset(this.now); s.waits = []; s.arrivals = 0; s.served = 0; s.maxQueue = s.waiting.length; s.backlogMax = Math.max(0, s.kind === 'in' ? s.waiting.length - s.capacity : 0); }
      for (const h of Object.values(this.hist)) h.reset();
      this.jobs.created = 0; this.jobs.done = 0; this.jobs.inCreated = 0; this.jobs.inDone = 0; this.jobs.outCreated = 0; this.jobs.outDone = 0;
      this.fillTW.reset(this.now); this.fillMin = this.fillTW.v; this.fillMax = this.fillTW.v;
    }
    onSample() {
      if (!this.counting) return;
      const b = this.bin();
      this.ts.nSample[b]++;
      let totalWait = 0;
      for (const s of this.stations) { this.ts.qSum[s.id][b] += s.waiting.length; totalWait += s.waiting.length; }
      for (const c of this.cranes) this.ts.busySum[c.id][b] += BUSY.has(c.state) ? 1 : 0;
      this.ts.fillSum[b] += this.occupiedCount() / Math.max(1, this.cells.length);
      this.ts.totalWaitSamples.push(totalWait);
    }

    // ---------- 도착 처리 ----------
    onArrival(s) {
      const job = { id: ++this.jobSeq, type: s.kind, station: s, zone: s.zone, tCreate: this.now, tDispatch: null, tPick: null, tDone: null, cell: null, body: null };
      s.arrivalsAll++; this.jobs.createdAll++;
      if (this.counting) { s.arrivals++; this.jobs.created++; if (s.kind === 'in') this.jobs.inCreated++; else this.jobs.outCreated++; }
      if (s.kind === 'in') job.body = this.newBody();
      s.waiting.push(job); this.updateQueue(s);
      const crane = this.cranes[s.zone];
      if (s.kind === 'in') crane.pendingIn.push(job); else crane.pendingOut.push(job);
      this.scheduleNextArrival(s);
      this.tryDispatch(crane);
    }

    // ---------- 셀 선택 ----------
    emptyCells(zi) { const out = []; for (const c of this.zoneCells[zi]) if (c.state === EMPTY) out.push(c); return out; }
    occCells(zi) { const out = []; for (const c of this.zoneCells[zi]) if (c.state === OCC) out.push(c); return out; }
    leg(p, q) { return Kin.legTime(p, q, this.models); }
    argmin(cells, f) {
      let best = null, bv = Infinity;
      for (const c of cells) { const v = f(c); if (v < bv - 1e-12) { bv = v; best = c; } }
      return best;
    }
    chooseStorageCell(zi, station) {
      const cands = this.emptyCells(zi);
      if (!cands.length) return null;
      if (this.sc.policy.storageRule === 'closest-open') return this.argmin(cands, c => this.leg(station, c));
      return this.rng.get('cell').pick(cands);
    }
    // SC-out: 반출 셀 (역 기준: 크레인 현재 위치 → 셀 → 출고 스테이션)
    chooseRetrievalCell(zi, station, crane, rule, ref) {
      const cands = this.occCells(zi);
      if (!cands.length) return null;
      if (station.retrieval === 'fifo' || rule === 'fifo') return this.argmin(cands, c => c.tStored);
      if (rule === 'nearest') { const from = ref || { x: crane.x, y: crane.y }; return this.argmin(cands, c => this.leg(from, c) + this.leg(c, station)); }
      return this.rng.get('cell').pick(cands);
    }
    stockGate(zi, station) {
      const minStock = (station.arrival && station.arrival.minStock) || 0;
      return this.cranes[zi].cellsOcc >= Math.max(1, minStock);
    }

    // ---------- 디스패치 ----------
    tryDispatch(crane) {
      if (crane.act || crane.plan.length) return;
      const zi = crane.idx, po = this.sc.policy;
      const ins = crane.pendingIn, outs = crane.pendingOut;
      const canIn = ins.length > 0 && crane.cellsEmpty > 0;
      const canOut = outs.length > 0 && crane.cellsOcc > 0 && this.stockGate(zi, outs[0].station);
      if (!canIn && !canOut) {
        this.setState(crane, ins.length ? 'blocked' : (outs.length ? 'starved' : 'idle'));
        return;
      }
      if (po.mode === 'DC' && canIn && canOut) {
        const inJob = ins.shift(), outJob = outs.shift();
        const cell1 = this.chooseStorageCell(zi, inJob.station);
        const rule = po.pairing === 'nearest' ? 'nearest' : po.retrievalCell;
        const cell2 = this.chooseRetrievalCell(zi, outJob.station, crane, rule, cell1);
        this.startPlan(crane, this.planDC(inJob, cell1, outJob, cell2), 'dc', [inJob, outJob]);
        return;
      }
      let type;
      if (canIn && canOut) {
        switch (po.priority) {
          case 'storage-first': type = 'in'; break;
          case 'retrieval-first': type = 'out'; break;
          case 'alternate': type = crane.lastType === 'in' ? 'out' : 'in'; break;
          default: type = ins[0].tCreate <= outs[0].tCreate ? 'in' : 'out';
        }
        if (po.agingLimit_s > 0) {
          const other = type === 'in' ? outs[0] : ins[0];
          if (this.now - other.tCreate > po.agingLimit_s) type = type === 'in' ? 'out' : 'in';
        }
      } else type = canIn ? 'in' : 'out';
      crane.lastType = type;
      const ret = po.mode === 'SC-return' && crane.home ? crane.home : null;
      if (type === 'in') {
        const job = ins.shift();
        const cell = this.chooseStorageCell(zi, job.station);
        this.startPlan(crane, this.planSCIn(job, cell, ret), 'scIn', [job]);
      } else {
        const job = outs.shift();
        const cell = this.chooseRetrievalCell(zi, job.station, crane, po.retrievalCell, null);
        this.startPlan(crane, this.planSCOut(job, cell, ret), 'scOut', [job]);
      }
    }

    planSCIn(job, cell, ret) {
      const p = [
        { kind: 'move', to: job.station, loaded: false, label: '입고 스테이션으로' },
        { kind: 'fork', action: 'pick', at: 'station', job, station: job.station },
        { kind: 'move', to: cell, loaded: true, label: '저장 셀로' },
        { kind: 'fork', action: 'place', at: 'cell', job, cell },
      ];
      if (ret) p.push({ kind: 'move', to: ret, loaded: false, label: '복귀', ret: true });
      return p;
    }
    planSCOut(job, cell, ret) {
      const p = [
        { kind: 'move', to: cell, loaded: false, label: '반출 셀로' },
        { kind: 'fork', action: 'pick', at: 'cell', job, cell },
        { kind: 'move', to: job.station, loaded: true, label: '출고 스테이션으로' },
        { kind: 'fork', action: 'place', at: 'station', job, station: job.station },
      ];
      if (ret) p.push({ kind: 'move', to: ret, loaded: false, label: '복귀', ret: true });
      return p;
    }
    planDC(inJob, cell1, outJob, cell2) {
      return [
        { kind: 'move', to: inJob.station, loaded: false, label: '입고 스테이션으로' },
        { kind: 'fork', action: 'pick', at: 'station', job: inJob, station: inJob.station },
        { kind: 'move', to: cell1, loaded: true, label: '저장 셀로' },
        { kind: 'fork', action: 'place', at: 'cell', job: inJob, cell: cell1 },
        { kind: 'move', to: cell2, loaded: false, label: '반출 셀로' },
        { kind: 'fork', action: 'pick', at: 'cell', job: outJob, cell: cell2 },
        { kind: 'move', to: outJob.station, loaded: true, label: '출고 스테이션으로' },
        { kind: 'fork', action: 'place', at: 'station', job: outJob, station: outJob.station },
      ];
    }

    startPlan(crane, plan, cycleType, jobs) {
      const zi = crane.idx;
      for (const a of plan) {
        if (a.kind === 'fork' && a.at === 'cell') {
          if (a.action === 'place') { a.cell.state = RES_IN; crane.cellsEmpty--; }
          else { a.cell.state = RES_OUT; crane.cellsOcc--; }
        }
      }
      for (const j of jobs) { j.tDispatch = this.now; crane.activeJobs.push(j); j.cell = null; }
      for (const a of plan) if (a.kind === 'fork' && a.cell) a.job.cell = a.cell;
      crane.plan = plan; crane.cycleType = cycleType; crane.cycleStart = this.now;
      this.startNextAct(crane);
      void zi;
    }

    startNextAct(crane) {
      for (;;) {
        if (!crane.plan.length) {
          // 사이클 완료
          if (crane.cycleType) {
            const ct = this.now - crane.cycleStart;
            if (this.counting) {
              crane.cycles[crane.cycleType]++; crane.cycleSum[crane.cycleType] += ct;
              const h = crane.cycleType === 'dc' ? this.hist.cycleDc : (crane.cycleType === 'scIn' ? this.hist.cycleScIn : this.hist.cycleScOut);
              h.add(ct);
            }
            crane.cycleType = null; crane.activeJobs = [];
          }
          crane.act = null;
          this.tryDispatch(crane);                // 새 계획은 startPlan → startNextAct 가 시작한다
          return;
        }
        const a = crane.plan.shift();
        if (a.kind === 'move') {
          const mv = Kin.makeMove({ x: crane.x, y: crane.y }, a.to, this.models, this.tPos);
          crane.act = { kind: 'move', t0: this.now, t1: this.now + mv.dur, mv, loaded: a.loaded, label: a.label, target: a.to };
          this.setState(crane, a.loaded ? 'moveLoaded' : 'moveEmpty');
          if (mv.dur <= 0) { this.completeAct(crane, true); continue; }
          this.heap.push(crane.act.t1, 'CRANE_STEP', crane);
          return;
        }
        // fork
        crane.act = { kind: 'fork', t0: this.now, t1: this.now + this.fc.t, action: a.action, at: a.at, job: a.job, cell: a.cell || null, station: a.station || null };
        this.setState(crane, 'fork');
        if (this.fc.t <= 0) { this.completeAct(crane, true); continue; }
        this.heap.push(crane.act.t1, 'CRANE_STEP', crane);
        return;
      }
    }

    completeAct(crane, inline) {
      const a = crane.act;
      if (!a) return;
      if (a.kind === 'move') {
        const mv = a.mv;
        crane.x = mv.to.x; crane.y = mv.to.y;
        if (this.counting) { crane.moves++; crane.distX += mv.dist.x; crane.distY += mv.dist.y; }
        if (!V.inRect(crane.zone, crane.x, crane.y)) {
          this.zoneViolations++;
          if (this.debug) throw new Error(`존 이탈: ${crane.id} → (${crane.x}, ${crane.y})`);
        }
      } else {
        const job = a.job;
        if (a.action === 'pick') {
          if (a.at === 'station') {
            const s = a.station;
            job.tPick = this.now;
            const i = s.waiting.indexOf(job); if (i >= 0) s.waiting.splice(i, 1);
            this.updateQueue(s);
            if (this.counting) { s.served++; const w = job.tPick - job.tCreate; s.waits.push(w); this.hist.waitIn.add(w); }
            crane.carrying = job;
          } else {
            const c = a.cell;
            job.body = c.load; c.state = EMPTY; c.load = null; crane.cellsEmpty++;
            crane.carrying = job; job.tPick = this.now;
            this.updateFill();
          }
        } else {
          if (a.at === 'cell') {
            const c = a.cell;
            c.state = OCC; c.load = job.body; c.tStored = this.now; crane.cellsOcc++;
            crane.carrying = null; job.tDone = this.now;
            this.updateFill();
            this.jobDone(job);
          } else {
            const s = a.station;
            crane.carrying = null; job.tDone = this.now;
            const i = s.waiting.indexOf(job); if (i >= 0) s.waiting.splice(i, 1);
            this.updateQueue(s);
            if (this.counting) { s.served++; const w = job.tDone - job.tCreate; s.waits.push(w); this.hist.waitOut.add(w); }
            this.jobDone(job);
          }
        }
      }
      crane.act = null;
      if (!inline) this.startNextAct(crane);
    }

    jobDone(job) {
      this.jobs.doneAll++;
      if (this.counting) {
        this.jobs.done++;
        if (job.type === 'in') this.jobs.inDone++; else this.jobs.outDone++;
        const b = this.bin();
        this.ts.done[b]++; if (job.type === 'in') this.ts.doneIn[b]++; else this.ts.doneOut[b]++;
      }
    }

    // ---------- 스냅샷 (렌더·검증용) ----------
    cranePos(c, t) {
      const a = c.act;
      const now = (t === undefined) ? this.now : t;
      if (a && a.kind === 'move') return a.mv.posAt(now - a.t0);
      return { x: c.x, y: c.y };
    }
    forkExt(c, t) {
      const a = c.act;
      if (!a || a.kind !== 'fork') return 0;
      return Kin.forkExtension(this.fc, (t === undefined ? this.now : t) - a.t0);
    }
    pendingCount() { return this.cranes.reduce((n, c) => n + c.pendingIn.length + c.pendingOut.length, 0); }
    inProgressCount() { return this.cranes.reduce((n, c) => n + c.activeJobs.filter(j => j.tDone === null).length, 0); }

    // ---------- 결과 ----------
    result() {
      const tEnd = this.now;
      const statSec = Math.max(1e-9, tEnd - Math.max(this.warmup, 0));
      const hours = statSec / 3600;
      const q = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return St.quantile(s, p); };
      const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const cranes = this.cranes.map(c => {
        const stateTime = c.clock.snapshot(tEnd);
        const frac = {}; for (const s of STATES) frac[s] = stateTime[s] / statSec;
        const busy = frac.moveEmpty + frac.moveLoaded + frac.fork;
        const mc = {}; for (const k of ['scIn', 'scOut', 'dc']) mc[k] = c.cycles[k] ? c.cycleSum[k] / c.cycles[k] : 0;
        return { id: c.id, stateTime: frac, busy, blockedFrac: frac.blocked + frac.starved, moves: c.moves, distX: c.distX, distY: c.distY,
                 cycles: { ...c.cycles }, meanCycle: mc, pendingIn: c.pendingIn.length, pendingOut: c.pendingOut.length,
                 cellsOcc: c.cellsOcc, cellsEmpty: c.cellsEmpty, cellsTotal: this.zoneCells[c.idx].length };
      });
      const stations = this.stations.map(s => ({
        id: s.id, kind: s.kind, arrivals: s.arrivals, served: s.served,
        meanQueue: s.qTW.mean(tEnd), maxQueue: s.maxQueue, endQueue: s.waiting.length,
        meanWait: mean(s.waits), p95Wait: q(s.waits, 0.95), maxWait: s.waits.length ? Math.max(...s.waits) : 0,
        blockedTime: s.kind === 'in' ? s.blockedTW.mean(tEnd) * statSec : 0, backlogMax: s.backlogMax,
        demandPerHour: s.arrival.ratePerHour || 0,
      }));
      const demandIn = this.stations.filter(s => s.kind === 'in').reduce((a, s) => a + (s.arrival.ratePerHour || 0), 0);
      const demandOut = this.stations.filter(s => s.kind === 'out').reduce((a, s) => a + (s.arrival.ratePerHour || 0), 0);
      const inPerHour = this.jobs.inDone / hours, outPerHour = this.jobs.outDone / hours;
      const doneRatio = this.jobs.created ? this.jobs.done / this.jobs.created : 1;
      // 큐 추세: 총 대기 표본의 후반 ¼ 평균 / 전반 ¼ 평균
      const tw = this.ts.totalWaitSamples; let queueTrend = 1, lastQ = 0;
      if (tw.length >= 8) {
        const qn = Math.floor(tw.length / 4);
        const first = mean(tw.slice(0, qn)), last = mean(tw.slice(-qn)); lastQ = last;
        queueTrend = (last + 1) / (first + 1);
      }
      const maxCap = Math.max(...this.stations.map(s => s.capacity));
      const saturated = (queueTrend > 1.5 && lastQ > 2) || (doneRatio < 0.9 && lastQ > 2 * maxCap);
      const ts = { binSec: this.binSec, t0: this.warmup, done: this.ts.done, doneIn: this.ts.doneIn, doneOut: this.ts.doneOut, queue: {}, busy: {}, fill: [] };
      for (const s of this.stations) ts.queue[s.id] = this.ts.qSum[s.id].map((v, i) => this.ts.nSample[i] ? v / this.ts.nSample[i] : 0);
      for (const c of this.cranes) ts.busy[c.id] = this.ts.busySum[c.id].map((v, i) => this.ts.nSample[i] ? v / this.ts.nSample[i] : 0);
      ts.fill = this.ts.fillSum.map((v, i) => this.ts.nSample[i] ? v / this.ts.nSample[i] : 0);
      const hist = {}; for (const [k, h] of Object.entries(this.hist)) hist[k] = h.toJSON();
      const totalCells = this.cells.length, occ = this.occupiedCount();
      return {
        schema: 'stcsim/rep@1', scenarioId: this.sc.name, rep: this.rep, seed: this.seed,
        durationSec: this.duration, warmupSec: this.warmup, statSec, parallelAisles: this.k,
        jobs: { created: this.jobs.created, done: this.jobs.done, pending: this.pendingCount(), inProgress: this.inProgressCount(),
                unservable: this.jobs.unservable, createdAll: this.jobs.createdAll, doneAll: this.jobs.doneAll,
                in: { created: this.jobs.inCreated, done: this.jobs.inDone }, out: { created: this.jobs.outCreated, done: this.jobs.outDone } },
        throughput: { perHour: inPerHour + outPerHour, inPerHour, outPerHour, demandPerHour: demandIn + demandOut, demandIn, demandOut, doneRatio,
                      inRatio: demandIn ? inPerHour / demandIn : 1, outRatio: demandOut ? outPerHour / demandOut : 1 },
        cranes, stations,
        rack: { cells: totalCells, meanFill: this.fillTW.mean(tEnd), minFill: this.fillMin, maxFill: this.fillMax, endFill: occ / Math.max(1, totalCells), endOccupied: occ },
        hist, ts,
        flags: { saturated, queueTrend, storageBlocked: cranes.some(c => c.stateTime.blocked > 0), starved: cranes.some(c => c.stateTime.starved > 0), zoneViolations: this.zoneViolations },
      };
    }
  }

  function runScenario(scenario, opt) { return new Sim(scenario, opt).run(); }

  return { version: '0.1.0', STATES, EMPTY, RES_IN, OCC, RES_OUT, Heap, Sim, runScenario };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCEngine;

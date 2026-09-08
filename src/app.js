'use strict';
/* ============================================================
 * STC 시뮬레이터 — 앱 (app.js): 탭 · 시나리오 편집 · 3D 재생 · 통계 · 실험기 · 최적화기 · 해석식 · 도움말
 * ============================================================ */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = STCCharts.fmtNum;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pct = (v, d) => Number.isFinite(v) ? (v * 100).toFixed(d === undefined ? 1 : d) + '%' : '–';
  const hms = (sec) => { const s = Math.max(0, Math.round(sec)); return Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const STATE_ORDER = ['moveEmpty', 'moveLoaded', 'fork', 'blocked', 'starved', 'idle'];

  const App = {
    sc: null, sim: null, last: null, view: null, layout: null, layoutSc: null, pool: null,
    anim: { playing: false, speed: 60, raf: 0, lastTs: 0 },
    exp: { rows: [], results: null }, opt: { rows: [], ranked: null },
  };

  /* ================= 탭 ================= */
  function showTab(name) {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
    if (name !== 'anim') pauseAnim();
    if (name === 'anim') ensureView();
    if (name === 'fem') renderFem();
    if (name === 'stats' && App.last) renderStats();
  }

  /* ================= 시나리오 ================= */
  function getPath(o, p) { return p.split('.').reduce((a, k) => (a === undefined || a === null) ? undefined : a[k], o); }
  function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] === undefined || a[ks[i]] === null) a[ks[i]] = {}; a = a[ks[i]]; } a[ks[ks.length - 1]] = v; }

  function setScenario(sc) {
    App.sc = sc; pauseAnim(); App.sim = null; App.last = null;
    $('hdScenario').textContent = sc.name || '–'; $('scName').value = sc.name || '';
    setVerdict(null);
    syncJson(); renderForm(); renderStationsTable(); renderCranesTable(); validateNow();
    App.layoutSc = null;
    if (App.view && $('tab-anim').classList.contains('on')) ensureView();
    $('statsBody').hidden = true; $('statsEmpty').hidden = false;
    renderFem(); renderDesignSpace('exp'); renderDesignSpace('opt');
  }
  function scenarioChanged() {
    App.sim = null; App.last = null; setVerdict(null); syncJson(); validateNow(); App.layoutSc = null;
    if (App.view && $('tab-anim').classList.contains('on')) ensureView();
    renderFem(); $('statsBody').hidden = true; $('statsEmpty').hidden = false;
    renderDesignSpace('exp'); renderDesignSpace('opt');
  }
  function syncJson() { $('jsonEd').value = JSON.stringify(App.sc, null, 2); }
  function applyJson() {
    try { const sc = JSON.parse($('jsonEd').value); if (!sc || typeof sc !== 'object') throw new Error('객체가 아닙니다'); setScenario(sc); }
    catch (e) { alert('JSON 오류: ' + e.message); }
  }
  /* ---- 지적 사항 → 해당 입력 칸 표시·이동 ---- */
  const LEVEL_CLASS = { error: 'err', warn: 'warn', info: 'info' };
  function targetEls(t) {
    if (!t) return [];
    if (t.type === 'field') { const el = $('f_' + t.path.replace(/\./g, '_')); return el ? [el] : []; }
    if (t.type === 'station' || t.type === 'crane') {
      const row = document.querySelector(`#${t.type === 'station' ? 'stTable' : 'crTable'} tr[data-eid="${CSS.escape(t.id)}"]`);
      if (!row) return [];
      if (!t.col) return [row];
      if (t.col === 'zone') return [row, ...row.querySelectorAll('[data-k^="zone."]')];
      const cell = row.querySelector(`[data-k="${t.col}"]`);
      return cell ? [row, cell] : [row];
    }
    if (t.type === 'craneTable') return [$('crTable')];
    if (t.type === 'stationTable') return [$('stTable')];
    if (t.type === 'json') return [$('jsonEd')];
    return [];
  }
  function applyIssueMarks(issues) {
    document.querySelectorAll('.mk-err,.mk-warn').forEach(el => el.classList.remove('mk-err', 'mk-warn'));
    for (const it of issues) {
      if (!it.target || it.level === 'info') continue;
      const cls = it.level === 'error' ? 'mk-err' : 'mk-warn';
      for (const el of targetEls(it.target)) {
        if (cls === 'mk-err') el.classList.remove('mk-warn');
        else if (el.classList.contains('mk-err')) continue;
        el.classList.add(cls);
      }
    }
  }
  function focusIssue(idx) {
    const it = (App.issues || [])[idx];
    const els = targetEls(it && it.target);
    if (!els.length) return;
    showTab('model');
    const el = els[els.length - 1];
    el.scrollIntoView({ block: 'center' });   // 즉시 이동. smooth 는 이동이 중간에 끊기는 경우가 있다
    const flash = els[0];
    flash.classList.remove('mk-flash');
    void flash.offsetWidth;
    flash.classList.add('mk-flash');
    if (typeof el.focus === 'function' && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.focus({ preventScroll: true });
  }

  function validateNow() {
    const v = STCValidate.validate(App.sc);
    App.issues = v.issues;
    const nErr = v.errors.length, nWarn = v.warnings.length;
    let h = '';
    if (v.ok && !nWarn) h += '<div class="okm">검증 통과 — 오류·경고 없음</div>';
    else if (v.ok) h += '<div class="okm">검증 통과 (경고 ' + nWarn + '건) — 실행할 수 있습니다</div>';
    else h += '<div class="errhead">오류 ' + nErr + '건 — 고쳐야 실행됩니다' + (nWarn ? ' (경고 ' + nWarn + '건)' : '') + '</div>';
    v.issues.forEach((it, i) => {
      const cls = LEVEL_CLASS[it.level];
      const can = targetEls(it.target).length > 0;
      h += can
        ? `<button type="button" class="${cls} jump" data-issue="${i}">${esc(it.msg)}<span class="go">해당 항목 보기 →</span></button>`
        : `<div class="${cls}">${esc(it.msg)}</div>`;
    });
    $('valMsgs').innerHTML = h;
    $('valMsgs').querySelectorAll('[data-issue]').forEach(b => b.addEventListener('click', () => focusIssue(+b.dataset.issue)));
    applyIssueMarks(v.issues);
    const bt = $('balTable');
    if (v.balance && v.balance.length) {
      bt.innerHTML = '<tr><th class="l">존(크레인)</th><th>셀</th><th class="l">스테이션</th><th>입고 건/h</th><th>출고 건/h</th><th>수지</th><th>초기 재고</th></tr>' +
        v.balance.map(b => `<tr><td class="l">${esc(b.crane)}</td><td>${b.cells}</td><td class="l">${esc(b.stations.join(', ') || '—')}</td><td>${fmt(b.inRate, 1)}</td><td>${fmt(b.outRate, 1)}</td><td>${b.drift > 0 ? '+' : ''}${fmt(b.drift, 1)}</td><td>${b.stock}/${b.cells}</td></tr>`).join('');
    } else bt.innerHTML = '';
    return v;
  }

  /* ================= 입력 폼 ================= */
  const mpm = { toUI: v => v * 60, fromUI: v => v / 60 };
  const FIELDS = [
    { grp: '실행', items: [
      { path: 'run.durationSec', label: '시뮬레이션 시간', unit: 'h', toUI: v => v / 3600, fromUI: v => v * 3600, step: 0.5, min: 0.5 },
      { path: 'run.warmupSec', label: '워밍업(통계 제외)', unit: 'min', toUI: v => v / 60, fromUI: v => v * 60, step: 5, min: 0 },
      { path: 'seedBase', label: '난수 시드', step: 1, min: 0 },
      { path: 'parallelAisles', label: '병렬 통로 수 k', unit: '수요 ÷ k', step: 1, min: 1 },
    ] },
    { grp: '랙 (벽면 원점 x0, 길이 L, 높이 H — FEM 기준면)', items: [
      { path: 'rack.bays', label: '베이 수', step: 1, min: 1 }, { path: 'rack.levels', label: '단 수', step: 1, min: 1 },
      { path: 'rack.sides', label: '랙 면', type: 'select', options: [[1, '편측 (1)'], [2, '양측 (2)']], num: true },
      { path: 'rack.initialFill', label: '초기 충전률', step: 0.05, min: 0, max: 1 },
      { path: 'rack.x0', label: '랙 시작 x0', unit: 'm', step: 0.1 }, { path: 'rack.length', label: '랙 길이 L', unit: 'm', step: 0.1, min: 0.1 },
      { path: 'rack.height', label: '랙 높이 H', unit: 'm', step: 0.1, min: 0.1 }, { path: 'rack.aisleLength', label: '통로 전장', unit: 'm', step: 0.1 },
      { path: 'rack.bayX', label: '베이 중심 x 좌표', unit: 'm · 쉼표 구분, 비우면 균등 분할', type: 'list', wide: true },
      { path: 'rack.levelY', label: '단 높이 y 좌표', unit: 'm · 쉼표 구분, 비우면 균등 분할', type: 'list', wide: true },
    ] },
    { grp: '크레인 — 주행 x', items: [
      { path: 'crane.axes.x.v', label: '정격속도', unit: 'm/min', step: 1, min: 1, ...mpm }, { path: 'crane.axes.x.a', label: '가속도', unit: 'm/s²', step: 0.05, min: 0.01 },
      { path: 'crane.axes.x.d', label: '감속도', unit: 'm/s²', step: 0.05, min: 0.01 }, { path: 'crane.axes.x.creepDist', label: '저속 접근거리', unit: 'm', step: 0.05, min: 0 },
      { path: 'crane.axes.x.creepV', label: '저속', unit: 'm/min', step: 0.5, min: 0, ...mpm }, { path: 'crane.axes.x.tDelay', label: '고정 지연(제어·jerk)', unit: 's', step: 0.1, min: 0 },
    ] },
    { grp: '크레인 — 승강 y', items: [
      { path: 'crane.axes.y.v', label: '정격속도', unit: 'm/min', step: 1, min: 1, ...mpm }, { path: 'crane.axes.y.a', label: '가속도', unit: 'm/s²', step: 0.05, min: 0.01 },
      { path: 'crane.axes.y.d', label: '감속도', unit: 'm/s²', step: 0.05, min: 0.01 }, { path: 'crane.axes.y.creepDist', label: '저속 접근거리', unit: 'm', step: 0.05, min: 0 },
      { path: 'crane.axes.y.creepV', label: '저속', unit: 'm/min', step: 0.5, min: 0, ...mpm }, { path: 'crane.axes.y.tDelay', label: '고정 지연', unit: 's', step: 0.1, min: 0 },
    ] },
    { grp: '이재(포크)·부대시간', items: [
      { path: 'crane.fork.tOverride', label: '이재시간 지정 t_ü (0 = 계산)', unit: 's/회', step: 0.1, min: 0 }, { path: 'crane.fork.stroke', label: '포크 스트로크', unit: 'm', step: 0.1, min: 0 },
      { path: 'crane.fork.v', label: '포크 속도', unit: 'm/min', step: 1, min: 1, ...mpm }, { path: 'crane.fork.a', label: '포크 가속도', unit: 'm/s²', step: 0.05, min: 0.01 },
      { path: 'crane.fork.tSeat', label: '승강·안착', unit: 's', step: 0.1, min: 0 }, { path: 'crane.tPos', label: '정지·위치결정 (이동당)', unit: 's', step: 0.1, min: 0 },
      { path: 'crane.availability', label: '가동률 η (해석식·이용률 환산)', step: 0.01, min: 0.1, max: 1 }, { path: 'crane.bodyWidth', label: '크레인 폭 (같은 레일 존 간격)', unit: 'm', step: 0.1, min: 0 },
    ] },
    { grp: '운영 정책 (디스패치)', items: [
      { path: 'policy.mode', label: '운전 모드', type: 'select', options: [['SC-return', 'SC-return (단독, home 복귀 ↔ tm1)'], ['SC-stay', 'SC-stay (단독, 제자리 대기)'], ['DC', 'DC (복합사이클 페어링 ↔ tm2)']] },
      { path: 'policy.pairing', label: 'DC 페어링', type: 'select', options: [['fifo', 'fifo (오래된 것끼리)'], ['nearest', 'nearest (저장 셀에서 최근접 반출)']] },
      { path: 'policy.priority', label: '우선순위', type: 'select', options: [['oldest-first', 'oldest-first'], ['storage-first', 'storage-first (입고 우선)'], ['retrieval-first', 'retrieval-first (출고 우선)'], ['alternate', 'alternate (교대)']] },
      { path: 'policy.storageRule', label: '저장 위치', type: 'select', options: [['random-empty', 'random-empty (임의 빈 셀)'], ['closest-open', 'closest-open (최근접 빈 셀)']] },
      { path: 'policy.retrievalCell', label: '반출 셀 (any)', type: 'select', options: [['random', 'random'], ['fifo', 'fifo (입고순)'], ['nearest', 'nearest (잔여 이동 최소)']] },
      { path: 'policy.agingLimit_s', label: '기아 방지 한도 (0 = 없음)', unit: 's', step: 30, min: 0, nullZero: true },
    ] },
    { grp: '판정 목표', items: [
      { path: 'targets.rhoMax', label: '최대 가동률 ρ', step: 0.05, min: 0.1, max: 1 }, { path: 'targets.doneRatioMin', label: '최소 달성률', step: 0.01, min: 0.5, max: 1 },
      { path: 'targets.maxQueue', label: '평균 대기열 상한', unit: '건', step: 0.5, min: 0 },
    ] },
  ];
  function renderForm() {
    const root = $('form'); let h = '';
    for (const g of FIELDS) {
      h += `<div class="grp"><h3>${esc(g.grp)}</h3><div class="fgrid">`;
      for (const f of g.items) {
        let v = getPath(App.sc, f.path);
        if (f.nullZero && (v === null || v === undefined)) v = 0;
        const id = 'f_' + f.path.replace(/\./g, '_');
        h += `<div class="field${f.wide ? ' wide' : ''}"><label>${esc(f.label)}${f.unit ? ' <span class="u">' + esc(f.unit) + '</span>' : ''}</label>`;
        if (f.type === 'select') h += `<select id="${id}" data-path="${f.path}">${f.options.map(o => `<option value="${o[0]}"${String(o[0]) === String(v) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
        else if (f.type === 'list') h += `<input type="text" id="${id}" data-path="${f.path}" value="${Array.isArray(v) ? v.join(', ') : ''}" placeholder="비우면 균등 분할로 자동 계산">`;
        else { const ui = f.toUI ? f.toUI(+v || 0) : (+v || 0); h += `<input type="number" id="${id}" data-path="${f.path}" value="${Number.isFinite(ui) ? +ui.toFixed(6) : ''}" step="${f.step || 'any'}"${f.min !== undefined ? ' min="' + f.min + '"' : ''}${f.max !== undefined ? ' max="' + f.max + '"' : ''}>`; }
        h += '</div>';
      }
      h += '</div></div>';
    }
    root.innerHTML = h;
    root.querySelectorAll('[data-path]').forEach(el => el.addEventListener('change', () => {
      const f = FIELDS.flatMap(g => g.items).find(x => x.path === el.dataset.path);
      let v;
      if (f.type === 'select') v = f.num ? +el.value : el.value;
      else if (f.type === 'list') {
        const arr = el.value.split(',').map(x => parseFloat(x.trim())).filter(x => Number.isFinite(x));
        v = arr.length ? arr : null;
      } else { const n = parseFloat(el.value); if (!Number.isFinite(n)) return; v = f.fromUI ? f.fromUI(n) : n; if (f.nullZero && v === 0) v = null; }
      setPath(App.sc, f.path, v);
      if (f.path === 'rack.bays' && App.sc.rack.bayX && App.sc.rack.bayX.length !== App.sc.rack.bays) App.sc.rack.bayX = null;
      if (f.path === 'rack.levels' && App.sc.rack.levelY && App.sc.rack.levelY.length !== App.sc.rack.levels) App.sc.rack.levelY = null;
      scenarioChanged();
    }));
  }
  $('scName').addEventListener('change', () => { App.sc.name = $('scName').value; $('hdScenario').textContent = App.sc.name; syncJson(); });

  /* ---- 스테이션 표 ---- */
  function renderStationsTable() {
    const t = $('stTable');
    let h = '<tr><th>id</th><th>이름</th><th>종류</th><th>x m</th><th>y m</th><th>용량</th><th>도착</th><th>건/h</th><th>편차%</th><th>minStock</th><th>반출</th><th></th></tr>';
    App.sc.stations.forEach((s, i) => {
      const ar = s.arrival || (s.arrival = { type: 'takt', ratePerHour: 0, jitterPct: 0 });
      h += `<tr data-i="${i}" data-eid="${esc(s.id)}">
        <td><input type="text" data-k="id" value="${esc(s.id)}" style="width:62px"></td>
        <td><input type="text" data-k="name" value="${esc(s.name || '')}" style="width:120px"></td>
        <td><select data-k="kind"><option value="in"${s.kind === 'in' ? ' selected' : ''}>입고</option><option value="out"${s.kind === 'out' ? ' selected' : ''}>출고</option></select></td>
        <td><input type="number" data-k="x" value="${s.x}" step="0.1" style="width:60px"></td>
        <td><input type="number" data-k="y" value="${s.y}" step="0.1" style="width:60px"></td>
        <td><input type="number" data-k="capacity" value="${s.capacity || 1}" step="1" min="1" style="width:48px"></td>
        <td><select data-k="arrival.type"><option value="takt"${ar.type === 'takt' ? ' selected' : ''}>takt</option><option value="poisson"${ar.type === 'poisson' ? ' selected' : ''}>poisson</option><option value="none"${ar.type === 'none' ? ' selected' : ''}>없음</option></select></td>
        <td><input type="number" data-k="arrival.ratePerHour" value="${ar.ratePerHour || 0}" step="1" min="0" style="width:58px"></td>
        <td><input type="number" data-k="arrival.jitterPct" value="${ar.jitterPct || 0}" step="5" min="0" max="100" style="width:48px"></td>
        <td>${s.kind === 'out' ? `<input type="number" data-k="arrival.minStock" value="${ar.minStock || 0}" step="1" min="0" style="width:48px">` : '<span class="muted">—</span>'}</td>
        <td>${s.kind === 'out' ? `<select data-k="retrieval"><option value="any"${(s.retrieval || 'any') === 'any' ? ' selected' : ''}>any</option><option value="fifo"${s.retrieval === 'fifo' ? ' selected' : ''}>fifo</option></select>` : '<span class="muted">—</span>'}</td>
        <td><button class="btn sm" data-del="${i}">삭제</button></td></tr>`;
    });
    t.innerHTML = h;
    t.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
      const i = +el.closest('tr').dataset.i, s = App.sc.stations[i], k = el.dataset.k;
      const v = el.type === 'number' ? parseFloat(el.value) : el.value;
      if (el.type === 'number' && !Number.isFinite(v)) return;
      setPath(s, k, v);
      if (k === 'kind') renderStationsTable();
      renderCranesTable(); scenarioChanged();
    }));
    t.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { App.sc.stations.splice(+b.dataset.del, 1); renderStationsTable(); renderCranesTable(); scenarioChanged(); }));
  }
  $('btnAddSt').addEventListener('click', () => {
    const n = App.sc.stations.length + 1;
    App.sc.stations.push({ id: 'ST' + n, name: '스테이션 ' + n, kind: 'in', x: App.sc.rack.x0, y: 0, capacity: 2, arrival: { type: 'takt', ratePerHour: 10, jitterPct: 10 } });
    renderStationsTable(); renderCranesTable(); scenarioChanged();
  });

  /* ---- 크레인·존 표 ---- */
  function renderCranesTable() {
    const t = $('crTable');
    const stOpts = (sel) => '<option value="">(없음)</option>' + App.sc.stations.map(s => `<option value="${esc(s.id)}"${s.id === sel ? ' selected' : ''}>${esc(s.id)}</option>`).join('');
    let h = '<tr><th>id</th><th>x 시작</th><th>x 끝</th><th>y 시작</th><th>y 끝</th><th>home</th><th>x0</th><th>y0</th><th></th></tr>';
    App.sc.cranes.forEach((c, i) => {
      h += `<tr data-i="${i}" data-eid="${esc(c.id)}">
        <td><input type="text" data-k="id" value="${esc(c.id)}" style="width:64px"></td>
        <td><input type="number" data-k="zone.x.0" value="${c.zone.x[0]}" step="0.1" style="width:64px"></td>
        <td><input type="number" data-k="zone.x.1" value="${c.zone.x[1]}" step="0.1" style="width:64px"></td>
        <td><input type="number" data-k="zone.y.0" value="${c.zone.y[0]}" step="0.1" style="width:64px"></td>
        <td><input type="number" data-k="zone.y.1" value="${c.zone.y[1]}" step="0.1" style="width:64px"></td>
        <td><select data-k="home">${stOpts(c.home)}</select></td>
        <td><input type="number" data-k="x0" value="${c.x0 !== undefined ? c.x0 : ''}" step="0.1" style="width:60px"></td>
        <td><input type="number" data-k="y0" value="${c.y0 !== undefined ? c.y0 : ''}" step="0.1" style="width:60px"></td>
        <td><button class="btn sm" data-del="${i}">삭제</button></td></tr>`;
    });
    t.innerHTML = h;
    t.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
      const i = +el.closest('tr').dataset.i, c = App.sc.cranes[i], k = el.dataset.k;
      if (k === 'home') { c.home = el.value || null; const s = App.sc.stations.find(x => x.id === c.home); if (s) { c.x0 = s.x; c.y0 = s.y; renderCranesTable(); } }
      else if (k === 'id') c.id = el.value;
      else { const v = parseFloat(el.value); if (!Number.isFinite(v)) return; setPath(c, k, v); }
      scenarioChanged();
    }));
    t.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { App.sc.cranes.splice(+b.dataset.del, 1); renderCranesTable(); scenarioChanged(); }));
  }
  $('btnAddCr').addEventListener('click', () => {
    const ext = STCOptimizer.extents(App.sc); const n = App.sc.cranes.length + 1;
    App.sc.cranes.push({ id: 'STC' + n, zone: { x: [ext.x[0], ext.x[1]], y: [ext.y[0], ext.y[1]] }, home: null, x0: ext.x[0], y0: ext.y[0] });
    renderCranesTable(); scenarioChanged();
  });

  /* ---- 파일 ---- */
  function download(name, text, type) {
    if (window.STC_ARTIFACT) { showTextOverlay(name, text); return; }   // 아티팩트 샌드박스는 다운로드 차단 → 복사용 표시
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function showTextOverlay(name, text) {
    let ov = document.getElementById('textOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'textOverlay'; ov.className = 'overlay'; document.body.appendChild(ov); }
    ov.innerHTML = '<div class="ovBox"><div class="row"><b>' + esc(name) + '</b><span class="dim small">이 환경에서는 파일 저장이 막혀 있어 내용을 표시합니다. 전체 선택 후 복사하세요.</span><button class="btn sm" id="ovCopy">복사</button><button class="btn sm" id="ovClose">닫기</button></div><textarea id="ovText" spellcheck="false"></textarea></div>';
    ov.querySelector('#ovText').value = text.replace(/^﻿/, '');
    ov.querySelector('#ovClose').addEventListener('click', () => ov.remove());
    ov.querySelector('#ovCopy').addEventListener('click', () => { const ta = ov.querySelector('#ovText'); ta.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } });
  }
  $('btnSave').addEventListener('click', () => download((App.sc.name || 'stc_scenario').replace(/[\\/:*?"<>|]/g, '_') + '.json',
    JSON.stringify({ app: 'stc-asrs-sim', ver: (window.STC_BUILD || {}).version || 'dev', savedAt: new Date().toISOString(), scenario: App.sc }, null, 2)));
  $('btnLoad').addEventListener('click', () => $('fileLoad').click());
  $('fileLoad').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { const d = JSON.parse(rd.result); setScenario(d.scenario || d); } catch (err) { alert('불러오기 실패: ' + err.message); } e.target.value = ''; };
    rd.readAsText(f, 'utf-8');
  });
  $('btnApplyJson').addEventListener('click', applyJson);
  $('btnPreset').addEventListener('click', () => setScenario(STCPresets.get($('presetSel').value)));

  /* ================= 3D 애니메이션 ================= */
  function ensureView() {
    if (!App.view) {
      App.view = new STCView3D.View($('viewport'));
      App.view.onPick = onPick;
      $('stateLegend').innerHTML = STATE_ORDER.map(s => `<div><i style="background:${STCScene.STATE_COLORS[s]}"></i>${esc(STCScene.STATE_LABELS[s])}</div>`).join('');
    }
    if (App.layoutSc !== App.sc) { App.layout = STCScene.layout(App.sc); App.layoutSc = App.sc; App.view.setLayout(App.layout, App.sc); App.sim = null; }
    if (!App.sim) resetSim(); else { App.view.resize(); drawFrame(); }
  }
  function resetSim() {
    pauseAnim();
    const v = STCValidate.validate(App.sc);
    if (!v.ok) { $('animNote').textContent = '시나리오 오류 — ① 모델 탭에서 수정: ' + v.errors[0]; App.sim = null; return; }
    $('animNote').textContent = '';
    App.sim = new STCEngine.Sim(App.sc, { rep: 0 });
    $('cellInfo').hidden = true;
    drawFrame();
  }
  function drawFrame() {
    if (!App.sim || !App.view) return;
    const f = STCScene.frame(App.sim);
    App.view.update(f);
    updateHud(f);
  }
  function updateHud(f) {
    const sim = App.sim;
    $('clock').textContent = hms(f.t);
    $('clockSub').textContent = '/ ' + hms(sim.duration) + ' · 워밍업 ' + hms(sim.warmup) + (f.kpi.counting ? ' · 통계 수집 중' : ' · 워밍업 중');
    $('progFill').style.width = (f.t / sim.duration * 100).toFixed(2) + '%';
    $('progWarm').style.width = (sim.warmup / sim.duration * 100).toFixed(2) + '%';
    const doneIn = sim.stations.filter(s => s.kind === 'in').reduce((a, s) => a + s.arrivalsAll - s.waiting.length, 0);
    const doneOut = sim.stations.filter(s => s.kind === 'out').reduce((a, s) => a + s.arrivalsAll - s.waiting.length, 0);
    $('aIn').textContent = fmt(doneIn, 0); $('aOut').textContent = fmt(doneOut, 0);
    $('aRate').textContent = fmt(f.kpi.ratePerHour, 0);
    $('aFill').textContent = f.kpi.occupied + ' / ' + f.kpi.cells;
    $('craneList').innerHTML = f.cranes.map(c => `<tr><td><span class="dot" style="background:${c.color}"></span>${esc(c.id)}</td><td>${esc(c.label)}</td><td class="n">(${c.x.toFixed(1)}, ${c.y.toFixed(1)})</td><td class="n">대기 ${c.pendingIn}/${c.pendingOut}</td></tr>`).join('');
    $('stationList').innerHTML = f.stations.map(s => `<tr><td>${esc(s.id)} <span class="muted">${s.kind === 'in' ? '입고' : '출고'}</span></td><td class="n">${s.queue}${s.backlog ? ' <span style="color:var(--err)">(정체 ' + s.backlog + ')</span>' : ''}</td><td class="n muted">도착 ${s.arrivals}</td></tr>`).join('');
  }
  function tick(ts) {
    if (!App.anim.playing || !App.sim) return;
    const dt = Math.min(0.1, App.anim.lastTs ? (ts - App.anim.lastTs) / 1000 : 0.016);
    App.anim.lastTs = ts;
    App.sim.advanceTo(Math.min(App.sim.duration, App.sim.now + dt * App.anim.speed));
    drawFrame();
    if (App.sim.finished) { pauseAnim(); App.last = App.sim.result(); setVerdictFromResult(App.last); $('animNote').textContent = '완료 — ③ 통계 탭에 결과가 준비되었습니다.'; return; }
    App.anim.raf = requestAnimationFrame(tick);
  }
  function playAnim() { if (!App.sim) resetSim(); if (!App.sim) return; if (App.sim.finished) resetSim(); App.anim.playing = true; App.anim.lastTs = 0; App.anim.raf = requestAnimationFrame(tick); }
  function pauseAnim() { App.anim.playing = false; if (App.anim.raf) cancelAnimationFrame(App.anim.raf); App.anim.raf = 0; }
  $('btnPlay').addEventListener('click', playAnim);
  $('btnPause').addEventListener('click', pauseAnim);
  $('btnReset').addEventListener('click', resetSim);
  $('btnStep').addEventListener('click', () => { if (!App.sim) resetSim(); if (!App.sim) return; pauseAnim(); App.sim.advanceTo(Math.min(App.sim.duration, App.sim.now + 60)); drawFrame(); });
  $('speedSel').addEventListener('change', () => { App.anim.speed = +$('speedSel').value; });
  document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => { if (App.view) App.view.setCamera(b.dataset.cam); }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) App.anim.lastTs = 0; });
  function onPick(idx) {
    const box = $('cellInfo');
    if (idx < 0 || !App.sim) { box.hidden = true; return; }
    const c = App.sim.cells[idx];
    const st = ['빈 셀', '입고 예약', '점유', '반출 예약'][c.state];
    const age = c.load ? (App.sim.now - c.tStored) / 3600 : null;
    box.hidden = false;
    box.innerHTML = `<h4>셀 #${idx} — bay ${c.bay + 1} · level ${c.level + 1} · ${c.side === 0 ? '앞면' : '뒷면'}</h4>
      <div>좌표 (${c.x.toFixed(2)}, ${c.y.toFixed(2)}) m · 존 ${c.zone >= 0 ? esc(App.sim.cranes[c.zone].id) : '없음'}</div>
      <div>상태 <b>${st}</b>${c.load ? ' · 적재물 ' + esc(c.load.id) + ' · 보관 ' + age.toFixed(2) + ' h' : ''}</div>`;
  }

  /* ================= 단일 실행 · 통계 ================= */
  function setVerdict(v) { const el = $('hdVerdict'); el.className = 'v' + (v === null ? '' : v ? ' ok' : ' ng'); el.textContent = v === null ? '–' : v ? 'OK' : 'NG'; }
  function evaluateResult(r) { return STCOptimizer.evaluate(STCStats.aggregateReps([r]).agg, App.sc.targets); }
  function setVerdictFromResult(r) { setVerdict(evaluateResult(r).feasible); }
  function runSingle() {
    const v = validateNow(); if (!v.ok) { showTab('model'); alert('시나리오 오류: ' + v.errors[0]); return; }
    App.last = STCEngine.runScenario(App.sc, { rep: 0 });
    setVerdictFromResult(App.last);
    showTab('stats'); renderStats();
  }
  $('btnRunSingle').addEventListener('click', runSingle);
  $('btnRunSingle2').addEventListener('click', runSingle);

  function card(id, title, sub, wide) { return `<div class="card${wide ? ' wide' : ''}"><h3>${esc(title)}${sub ? ' <span class="dim">' + esc(sub) + '</span>' : ''}</h3><div class="legend" id="lg_${id}"></div><canvas id="ch_${id}"></canvas></div>`; }
  function renderStats() {
    const r = App.last; if (!r) return;
    $('statsEmpty').hidden = true; $('statsBody').hidden = false;
    const sc = App.sc, k = r.parallelAisles || 1;
    $('statsTitle').textContent = sc.name;
    $('statsMeta').textContent = `seed ${r.seed} · 런 ${hms(r.durationSec)} (워밍업 ${hms(r.warmupSec)} 제외, 통계 ${hms(r.statSec)})${k > 1 ? ' · 통로 ' + k + '개 중 1개 통로 결과 (수요 ÷ ' + k + ')' : ''}`;
    const ev = evaluateResult(r);
    const maxBusy = Math.max(...r.cranes.map(c => c.busy));
    const waitIn = r.stations.filter(s => s.kind === 'in'), waitOut = r.stations.filter(s => s.kind === 'out');
    const wAvg = (arr) => { const n = arr.reduce((a, s) => a + s.served, 0); return n ? arr.reduce((a, s) => a + s.meanWait * s.served, 0) / n : 0; };
    const lineStop = r.stations.reduce((a, s) => a + (s.blockedTime || 0), 0);
    const eta = sc.crane.availability || 1;
    $('kpiRow').innerHTML = `
      <div class="kpi hero"><div class="k">요구 대비 달성률</div><div class="v">${pct(r.throughput.doneRatio)}</div><div class="sub">처리 ${fmt(r.throughput.perHour, 1)} / 요구 ${fmt(r.throughput.demandPerHour, 1)} 건/h</div></div>
      <div class="kpi"><div class="k">입고 처리</div><div class="v">${fmt(r.throughput.inPerHour, 1)}<small>건/h</small></div><div class="sub">요구 ${fmt(r.throughput.demandIn, 1)}</div></div>
      <div class="kpi"><div class="k">출고 처리</div><div class="v">${fmt(r.throughput.outPerHour, 1)}<small>건/h</small></div><div class="sub">요구 ${fmt(r.throughput.demandOut, 1)}</div></div>
      <div class="kpi"><div class="k">크레인 가동률 (최대)</div><div class="v">${pct(maxBusy)}</div><div class="sub">η ${eta} 기준 이용률 ${pct(maxBusy / eta)}</div></div>
      <div class="kpi"><div class="k">평균 대기 입고 / 출고</div><div class="v">${fmt(wAvg(waitIn), 0)}<small>s</small> / ${fmt(wAvg(waitOut), 0)}<small>s</small></div></div>
      <div class="kpi"><div class="k">라인 정지시간 (입고 정체)</div><div class="v">${fmt(lineStop / 60, 1)}<small>min</small></div><div class="sub">최대 대기열 ${Math.max(...r.stations.map(s => s.maxQueue))}</div></div>
      <div class="kpi"><div class="k">재고 (평균 / 종료)</div><div class="v">${pct(r.rack.meanFill, 0)}<small>/ ${pct(r.rack.endFill, 0)}</small></div><div class="sub">${r.rack.endOccupied} / ${r.rack.cells} 셀</div></div>`;
    const vb = $('verdictBox'); vb.className = 'verdict ' + (ev.feasible ? 'ok' : 'ng');
    vb.innerHTML = `<div class="badge">${ev.feasible ? 'OK' : 'NG'}</div><div><div><b>${ev.feasible ? '요구 물동량을 목표 조건 안에서 처리합니다.' : '목표 조건을 만족하지 못합니다.'}</b> <span class="dim small">(달성률 ≥ ${pct(sc.targets.doneRatioMin, 0)} · 최대 가동률 ≤ ${pct(sc.targets.rhoMax, 0)} · 대기열 안정 · 평균 대기열 ≤ ${sc.targets.maxQueue} · 블로킹 없음)</span></div>${ev.reasons.length ? '<ul>' + ev.reasons.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : ''}${r.flags.saturated ? '<div class="small" style="color:var(--err)">포화: 대기열이 증가 추세(×' + r.flags.queueTrend.toFixed(2) + ')</div>' : ''}</div>`;
    const cards = $('statCards');
    const hists = [['waitIn', '입고 대기시간 분포'], ['waitOut', '출고 대기시간 분포'], ['cycleScIn', 'SC-in 사이클타임 분포'], ['cycleScOut', 'SC-out 사이클타임 분포'], ['cycleDc', 'DC 사이클타임 분포']].filter(h => r.hist[h[0]] && r.hist[h[0]].count > 0);
    cards.innerHTML = card('state', '크레인 상태 시간 비율', '통계 구간') + card('donut', '상태 구성 — ' + r.cranes[0].id) +
      card('thr', '시간당 처리 물동량', '빈 ' + (r.ts.binSec / 60) + ' min → 건/h 환산, 점선 = 요구', true) +
      card('queue', '스테이션 대기열 길이', '표본 평균/빈', true) + card('fill', '랙 재고율') + card('busy', '크레인 가동률 추이') +
      hists.map(h => card(h[0], h[1], '')).join('');
    const stateRows = r.cranes.map(c => ({ label: c.id, segments: STATE_ORDER.map(s => ({ key: s, name: STCScene.STATE_LABELS[s], value: c.stateTime[s] || 0, color: STCScene.STATE_COLORS[s] })) }));
    $('lg_state').innerHTML = STCCharts.stackedBars($('ch_state'), { rows: stateRows }).legend;
    $('lg_donut').innerHTML = STCCharts.donut($('ch_donut'), { segments: stateRows[0].segments, center: pct(r.cranes[0].busy, 0), centerLabel: '가동률' }).legend;
    const xs = r.ts.done.map((_, i) => r.ts.t0 + (i + 0.5) * r.ts.binSec);
    const perH = (arr) => arr.map(v => v / r.ts.binSec * 3600);
    $('lg_thr').innerHTML = STCCharts.lineChart($('ch_thr'), { x: xs, series: [{ name: '입고', values: perH(r.ts.doneIn), color: STCCharts.slot(0) }, { name: '출고', values: perH(r.ts.doneOut), color: STCCharts.slot(1) }],
      refLines: [{ value: r.throughput.demandIn, label: '요구 입고', color: STCCharts.slot(0) }, { value: r.throughput.demandOut, label: '요구 출고', color: STCCharts.slot(1) }], unit: ' 건/h', height: 220 }).legend;
    const qSeries = r.stations.map((s, i) => ({ name: s.id, values: r.ts.queue[s.id] || [], color: STCCharts.slot(i) }));
    $('lg_queue').innerHTML = STCCharts.lineChart($('ch_queue'), { x: xs, series: qSeries, unit: ' 건', height: 200, yMin: 0 }).legend;
    $('lg_fill').innerHTML = STCCharts.lineChart($('ch_fill'), { x: xs, series: [{ name: '재고율', values: r.ts.fill.map(v => v * 100), color: STCCharts.slot(2) }], unit: '%', height: 170, yMin: 0, area: true, yFormat: v => fmt(v, 0) + '%' }).legend;
    $('lg_busy').innerHTML = STCCharts.lineChart($('ch_busy'), { x: xs, series: r.cranes.map((c, i) => ({ name: c.id, values: (r.ts.busy[c.id] || []).map(v => v * 100), color: STCCharts.slot(i) })), refLines: [{ value: sc.targets.rhoMax * 100, label: '목표 ρ' }], unit: '%', height: 170, yMin: 0, yFormat: v => fmt(v, 0) + '%' }).legend;
    hists.forEach((h) => { const hs = r.hist[h[0]]; STCCharts.histogram($('ch_' + h[0]), { hist: hs, color: STCCharts.slot(h[0] === 'waitIn' ? 0 : h[0] === 'waitOut' ? 1 : 2), unit: ' s', markers: [{ value: hs.mean, label: '평균' }] }); });
    $('craneTable').innerHTML = '<tr><th class="l">크레인</th><th>가동률</th>' + STATE_ORDER.map(s => '<th>' + esc(STCScene.STATE_LABELS[s]) + '</th>').join('') + '<th>SC-in</th><th>SC-out</th><th>DC</th><th>SC-in 평균 s</th><th>SC-out 평균 s</th><th>DC 평균 s</th><th>주행 km</th><th>승강 km</th></tr>' +
      r.cranes.map(c => `<tr><td class="l">${esc(c.id)}</td><td>${pct(c.busy)}</td>${STATE_ORDER.map(s => '<td>' + pct(c.stateTime[s] || 0) + '</td>').join('')}<td>${c.cycles.scIn}</td><td>${c.cycles.scOut}</td><td>${c.cycles.dc}</td><td>${fmt(c.meanCycle.scIn, 1)}</td><td>${fmt(c.meanCycle.scOut, 1)}</td><td>${fmt(c.meanCycle.dc, 1)}</td><td>${fmt(c.distX / 1000, 2)}</td><td>${fmt(c.distY / 1000, 2)}</td></tr>`).join('');
    $('stationTable').innerHTML = '<tr><th class="l">스테이션</th><th class="l">종류</th><th>요구 건/h</th><th>도착</th><th>처리</th><th>평균 대기열</th><th>최대 대기열</th><th>평균 대기 s</th><th>p95 대기 s</th><th>최대 대기 s</th><th>정체(라인 정지) s</th><th>최대 백로그</th></tr>' +
      r.stations.map(s => `<tr><td class="l">${esc(s.id)}</td><td class="l">${s.kind === 'in' ? '입고' : '출고'}</td><td>${fmt(s.demandPerHour, 1)}</td><td>${s.arrivals}</td><td>${s.served}</td><td>${fmt(s.meanQueue, 2)}</td><td>${s.maxQueue}</td><td>${fmt(s.meanWait, 0)}</td><td>${fmt(s.p95Wait, 0)}</td><td>${fmt(s.maxWait, 0)}</td><td>${fmt(s.blockedTime, 0)}</td><td>${s.backlogMax}</td></tr>`).join('');
  }

  /* ================= 설계공간 UI (실험·최적화 공용) ================= */
  const SPACE_DEF = {
    stationsVariant: { label: '스테이션 변형', items: () => STCOptimizer.stationVariants().map(v => [v.key, v.label]), def: ['asis'] },
    mode: { label: '운전 모드', items: () => [['SC-return', 'SC-return'], ['SC-stay', 'SC-stay'], ['DC', 'DC']], def: ['SC-return', 'DC'] },
    pairing: { label: 'DC 페어링', items: () => [['fifo', 'fifo'], ['nearest', 'nearest']], def: ['nearest'] },
    priority: { label: '우선순위', items: () => [['oldest-first', 'oldest-first'], ['storage-first', 'storage-first'], ['retrieval-first', 'retrieval-first'], ['alternate', 'alternate']], def: ['oldest-first'] },
    storageRule: { label: '저장 위치', items: () => [['random-empty', 'random-empty'], ['closest-open', 'closest-open']], def: ['closest-open'] },
    parallelAisles: { label: '병렬 통로 수', items: () => [[1, '1'], [2, '2'], [3, '3'], [4, '4']], def: [1, 2, 3], num: true },
  };
  function renderDesignSpace(prefix) {
    const root = $(prefix + 'Space'); if (!root) return;
    const prev = {}; root.querySelectorAll('input[type=checkbox]').forEach(cb => { prev[cb.dataset.g + '|' + cb.value] = cb.checked; });
    const chk = (g, v, def) => (prev[g + '|' + v] === undefined ? def : prev[g + '|' + v]) ? ' checked' : '';
    let zon; try { zon = STCOptimizer.zoningOptions(App.sc); } catch (e) { zon = []; }
    let h = '<div><h4>조닝 (1통로 내)</h4>' + zon.map(z => `<label><input type="checkbox" data-g="zoning" value="${esc(z.key)}"${chk('zoning', z.key, z.key === 'single')}>${esc(z.label)}</label>`).join('') + '</div>';
    for (const [g, d] of Object.entries(SPACE_DEF)) h += `<div><h4>${esc(d.label)}</h4>` + d.items().map(it => `<label><input type="checkbox" data-g="${g}" value="${esc(it[0])}"${chk(g, String(it[0]), d.def.map(String).includes(String(it[0])))}>${esc(it[1])}</label>`).join('') + '</div>';
    root.innerHTML = h;
  }
  function readSpace(prefix) {
    const root = $(prefix + 'Space'); const sp = { zoning: [] };
    for (const g of Object.keys(SPACE_DEF)) sp[g] = [];
    root.querySelectorAll('input[type=checkbox]:checked').forEach(cb => { const g = cb.dataset.g; sp[g].push(SPACE_DEF[g] && SPACE_DEF[g].num ? +cb.value : cb.value); });
    for (const g of Object.keys(sp)) if (!sp[g].length) sp[g] = g === 'zoning' ? ['single'] : SPACE_DEF[g].def.slice(0, 1);
    return sp;
  }
  function designLabel(d) { return `${d.zoningLabel.split(' (')[0]} · ${d.variantLabel} · ${d.mode}${d.mode === 'DC' ? '/' + d.pairing : ''} · ${d.priority} · ${d.storageRule} · 통로 ${d.parallelAisles}`; }
  function metricOf(agg, key) { return agg[key] ? agg[key] : { mean: NaN, ci95: 0, n: 0 }; }
  function maxMetric(agg, prefix, suffix) { let m = { mean: -Infinity, ci95: 0 }; for (const k of Object.keys(agg)) if (k.startsWith(prefix) && k.endsWith(suffix) && agg[k].mean > m.mean) m = agg[k]; return Number.isFinite(m.mean) ? m : { mean: NaN, ci95: 0 }; }
  function avgMetric(agg, prefix, suffix) { const xs = []; for (const k of Object.keys(agg)) if (k.startsWith(prefix) && k.endsWith(suffix)) xs.push(agg[k]); if (!xs.length) return { mean: NaN, ci95: 0 }; return { mean: xs.reduce((a, x) => a + x.mean, 0) / xs.length, ci95: xs.reduce((a, x) => a + x.ci95, 0) / xs.length }; }
  const pm = (m, f, unit) => Number.isFinite(m.mean) ? `${f(m.mean)}${unit || ''} <span class="muted">± ${f(m.ci95 || 0)}</span>` : '–';

  async function ensurePool() {
    if (!App.pool) { App.pool = new STCRunner.Pool(); const mode = await App.pool.detect(); $('hdRunner').textContent = mode === 'worker' ? `Web Worker × ${App.pool.size}` : '메인스레드 폴백'; }
    return App.pool;
  }
  function fillRow(row, agg) {
    row.result = agg; const ev = STCOptimizer.evaluate(agg.agg, row.scenario.targets); row.feasible = ev.feasible; row.reasons = ev.reasons; row.metrics = ev.metrics;
    row.m = { thr: metricOf(agg.agg, 'throughput.perHour'), done: metricOf(agg.agg, 'throughput.doneRatio'), busy: maxMetric(agg.agg, 'cranes.', '.busy'), waitIn: avgMetric(agg.agg, 'stations.', '.meanWait'), q: maxMetric(agg.agg, 'stations.', '.meanQueue') };
  }

  /* ================= ④ 실험기 ================= */
  function buildMatrix() {
    App.exp.rows = STCOptimizer.enumerate(App.sc, readSpace('exp')); App.exp.results = null;
    const t = $('expMatrix');
    t.innerHTML = '<tr><th>#</th><th class="l">설계</th><th>총 크레인</th><th>해석식 이용률 (DC)</th><th>해석식 이용률 (SC)</th><th class="l">유효성</th></tr>' +
      App.exp.rows.map((r, i) => `<tr><td>${i + 1}</td><td class="l">${esc(designLabel(r.design))}</td><td>${r.design.totalCranes}</td><td>${r.prefilter ? pct(r.prefilter.U, 0) : '–'}</td><td>${r.prefilter ? pct(r.prefilter.Usc, 0) : '–'}</td><td class="l ${r.valid ? 'ok' : 'ng'}">${r.valid ? '유효' : '무효 — ' + esc(r.invalidReason)}</td></tr>`).join('');
    $('btnExpRun').disabled = !App.exp.rows.some(r => r.valid);
    $('expStatus').textContent = `${App.exp.rows.length}개 설계 (유효 ${App.exp.rows.filter(r => r.valid).length}개)`;
    $('expResults').innerHTML = ''; $('expCharts').innerHTML = ''; $('btnExpCsv').disabled = true; $('btnExpJson').disabled = true;
  }
  async function runExperiments() {
    const valid = App.exp.rows.filter(r => r.valid); if (!valid.length) return;
    const reps = Math.max(2, +$('expReps').value || 10), seed = +$('expSeed').value || 0;
    const pool = await ensurePool();
    const jobs = STCRunner.expandJobs(valid, reps, seed);
    $('btnExpRun').disabled = true; $('btnExpCancel').disabled = false; $('btnExpMatrix').disabled = true;
    const t0 = performance.now();
    const res = await pool.run(jobs, (d, n) => { $('expProg').style.width = (d / n * 100).toFixed(1) + '%'; $('expStatus').textContent = `실행 중 ${d}/${n} (${pool.mode === 'worker' ? 'Worker × ' + pool.size : '메인스레드'})`; });
    const folded = STCRunner.foldResults(res);
    for (const r of valid) if (folded[r.id]) fillRow(r, folded[r.id]);
    App.exp.results = res;
    $('btnExpRun').disabled = false; $('btnExpCancel').disabled = true; $('btnExpMatrix').disabled = false;
    $('expStatus').textContent = `완료 — ${res.length}개 런, ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    renderExpResults();
  }
  function renderExpResults() {
    const rows = App.exp.rows.filter(r => r.result);
    const t = $('expResults');
    t.innerHTML = '<tr><th>#</th><th class="l">설계</th><th>총 크레인</th><th>n</th><th>처리 건/h</th><th>달성률</th><th>최대 가동률</th><th>평균 대기 s</th><th>최대 평균대기열</th><th class="l">판정</th><th></th></tr>' +
      rows.map((r, i) => `<tr><td>${i + 1}</td><td class="l">${esc(designLabel(r.design))}</td><td>${r.design.totalCranes}</td><td>${r.result.n}</td><td>${pm(r.m.thr, v => fmt(v, 1))}</td><td>${pm(r.m.done, v => pct(v, 1))}</td><td>${pm(r.m.busy, v => pct(v, 1))}</td><td>${pm(r.m.waitIn, v => fmt(v, 0))}</td><td>${pm(r.m.q, v => fmt(v, 2))}</td><td class="l ${r.feasible ? 'ok' : 'ng'}">${r.feasible ? 'OK' : 'NG'}${r.reasons.length ? ' <span class="dim small">' + esc(r.reasons.join(' · ')) + '</span>' : ''}</td><td><button class="btn sm" data-play="${esc(r.id)}">3D</button></td></tr>`).join('');
    t.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => { const r = App.exp.rows.find(x => x.id === b.dataset.play); if (r) { setScenario(clone(r.scenario)); showTab('anim'); } }));
    $('btnExpCsv').disabled = !rows.length; $('btnExpJson').disabled = !rows.length;
    const cards = $('expCharts');
    if (!rows.length) { cards.innerHTML = ''; return; }
    cards.innerHTML = card('e_thr', '처리 물동량', '평균 ± 95% CI, 건/h', true) + card('e_busy', '최대 크레인 가동률', '평균 ± 95% CI', true) + card('e_wait', '평균 대기시간', '스테이션 평균, s', true);
    const lab = (r) => designLabel(r.design);
    const demand = rows[0].scenario.stations.reduce((a, s) => a + ((s.arrival && s.arrival.ratePerHour) || 0), 0) / (rows[0].design.parallelAisles || 1);
    STCCharts.ciDots($('ch_e_thr'), { rows: rows.map(r => ({ label: lab(r), mean: r.m.thr.mean, ci: r.m.thr.ci95, n: r.result.n, marker: r.feasible ? 'ok' : 'ng' })), refLine: { value: demand, label: '요구(통로당)' }, unit: ' 건/h', xFormat: v => fmt(v, 0) });
    STCCharts.ciDots($('ch_e_busy'), { rows: rows.map(r => ({ label: lab(r), mean: r.m.busy.mean * 100, ci: r.m.busy.ci95 * 100, n: r.result.n, marker: r.feasible ? 'ok' : 'ng' })), refLine: { value: App.sc.targets.rhoMax * 100, label: '목표 ρ' }, unit: '%', xFormat: v => fmt(v, 0) });
    STCCharts.ciDots($('ch_e_wait'), { rows: rows.map(r => ({ label: lab(r), mean: r.m.waitIn.mean, ci: r.m.waitIn.ci95, n: r.result.n, marker: r.feasible ? 'ok' : 'ng' })), unit: ' s', xFormat: v => fmt(v, 0) });
  }
  function expRowsForExport() {
    return App.exp.rows.filter(r => r.result).map(r => ({ 설계: designLabel(r.design), 조닝: r.design.zoning, 스테이션변형: r.design.stationsVariant, 모드: r.design.mode, 페어링: r.design.pairing, 우선순위: r.design.priority, 저장규칙: r.design.storageRule, 통로수: r.design.parallelAisles, 총크레인: r.design.totalCranes, n: r.result.n,
      처리_건h: r.m.thr.mean, 처리_CI: r.m.thr.ci95, 달성률: r.m.done.mean, 달성률_CI: r.m.done.ci95, 최대가동률: r.m.busy.mean, 최대가동률_CI: r.m.busy.ci95, 평균대기_s: r.m.waitIn.mean, 평균대기_CI: r.m.waitIn.ci95, 최대평균대기열: r.m.q.mean, 판정: r.feasible ? 'OK' : 'NG', 사유: r.reasons.join(' / ') }));
  }
  $('btnExpMatrix').addEventListener('click', buildMatrix);
  $('btnExpRun').addEventListener('click', runExperiments);
  $('btnExpCancel').addEventListener('click', () => { if (App.pool) App.pool.cancel(); });
  $('btnExpCsv').addEventListener('click', () => download('stc_experiments.csv', STCStats.toCsv(expRowsForExport()), 'text/csv;charset=utf-8'));
  $('btnExpJson').addEventListener('click', () => download('stc_experiments.json', JSON.stringify({ app: 'stc-asrs-sim', exportedAt: new Date().toISOString(), base: App.sc, rows: App.exp.rows.filter(r => r.result).map(r => ({ design: r.design, scenario: r.scenario, agg: r.result.agg, n: r.result.n, feasible: r.feasible, reasons: r.reasons })) }, null, 1)));

  /* ================= ⑤ 최적화기 ================= */
  async function runOptimizer() {
    const targets = { ...App.sc.targets, rhoMax: +$('optRho').value, doneRatioMin: +$('optDone').value, maxQueue: +$('optQ').value };
    const base = clone(App.sc); base.targets = targets;
    const rows = STCOptimizer.enumerate(base, readSpace('opt'));
    App.opt.rows = rows; App.opt.ranked = null;
    const R1 = Math.max(1, +$('optR1').value || 5), R2 = Math.max(R1, +$('optR2').value || 20), K = Math.max(1, +$('optK').value || 5);
    const pool = await ensurePool();
    const plan = STCOptimizer.plan(rows, { stage1Reps: R1, stage2Reps: R2, topK: K, seedBase: base.seedBase || 0 });
    if (!plan.stage1.length) { $('optStatus').textContent = '유효한 설계가 없습니다 — 조닝·스테이션 변형 선택을 확인하세요.'; renderOptTable(); return; }
    $('btnOptRun').disabled = true; $('btnOptCancel').disabled = false;
    const byRow = Object.fromEntries(rows.map(r => [r.id, r]));
    const toJobs = (js) => js.map(j => ({ rowId: j.rowId, rep: j.rep, seed: j.seed, scenario: byRow[j.rowId].scenario }));
    const t0 = performance.now();
    const all = [];
    const prog = (label) => (d, n) => { $('optProg').style.width = (d / n * 100).toFixed(1) + '%'; $('optStatus').textContent = `${label} ${d}/${n}`; };
    const res1 = await pool.run(toJobs(plan.stage1), prog(`1단계 스크리닝 (${rows.filter(r => r.valid).length}개 설계 × R₁=${R1})`));
    all.push(...res1);
    let folded = STCRunner.foldResults(all);
    for (const r of rows) if (folded[r.id]) fillRow(r, folded[r.id]);
    let ranked = STCOptimizer.rank(rows);
    if (!pool.cancelled) {
      const s2 = plan.stage2For(ranked.rows);
      if (s2.length) {
        const res2 = await pool.run(toJobs(s2), prog(`2단계 재평가 (상위 ${K}개 × R₂=${R2})`));
        all.push(...res2); folded = STCRunner.foldResults(all);
        for (const r of rows) if (folded[r.id]) fillRow(r, folded[r.id]);
        ranked = STCOptimizer.rank(rows);
      }
    }
    App.opt.ranked = ranked;
    $('btnOptRun').disabled = false; $('btnOptCancel').disabled = true;
    $('optStatus').textContent = `완료 — ${all.length}개 런, ${((performance.now() - t0) / 1000).toFixed(1)} s (${pool.mode === 'worker' ? 'Worker × ' + pool.size : '메인스레드'})`;
    renderOptTable();
  }
  function renderOptTable() {
    const rk = App.opt.ranked; const rows = rk ? rk.rows : [];
    const best = $('optBest');
    if (rk && rk.best) {
      const b = rk.best;
      best.hidden = false;
      best.innerHTML = `<div class="t">추천 설계 (최소 크레인 수, 실행가능)</div><div class="big">${b.design.totalCranes}대</div><div><b>${esc(designLabel(b.design))}</b><div class="k">처리 ${pm(b.m.thr, v => fmt(v, 1), ' 건/h')} · 달성률 ${pm(b.m.done, v => pct(v, 1))} · 최대 가동률 ${pm(b.m.busy, v => pct(v, 1))} · 평균 대기 ${pm(b.m.waitIn, v => fmt(v, 0), ' s')} · n=${b.result.n}</div><div class="k">시뮬레이션은 대기열·페어링·존 제약을 반영한 값입니다. 해석식(⑥)과 나란히 보세요.</div></div>`;
    } else if (rk) { best.hidden = false; best.innerHTML = '<div class="t">추천 설계</div><div class="big">없음</div><div>탐색 공간 안에 실행가능한 설계가 없습니다. 통로 수·조닝·스테이션 변형을 넓히거나 제약을 완화하세요.</div>'; }
    else best.hidden = true;
    $('optByN').textContent = rk ? Object.entries(rk.byN).sort((a, b) => +a[0] - +b[0]).map(([n, s]) => `총 ${n}대: ${s.feasible}/${s.total} 실행가능${s.feasible === 0 ? ' — 주요 실패: ' + Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join(', ') : ''}`).join(' · ') : '';
    const invalid = App.opt.rows.filter(r => !r.valid);
    $('optTable').innerHTML = '<tr><th>순위</th><th class="l">설계</th><th>총 크레인</th><th>n</th><th>처리 건/h</th><th>달성률</th><th>최대 가동률</th><th>평균 대기 s</th><th class="l">판정</th><th></th></tr>' +
      rows.map(r => `<tr class="${rk.best === r ? 'best' : ''}"><td>${r.rank}${r.pareto ? ' <span class="dim small">P</span>' : ''}</td><td class="l">${esc(designLabel(r.design))}</td><td>${r.design.totalCranes}</td><td>${r.result.n}</td><td>${pm(r.m.thr, v => fmt(v, 1))}</td><td>${pm(r.m.done, v => pct(v, 1))}</td><td>${pm(r.m.busy, v => pct(v, 1))}</td><td>${pm(r.m.waitIn, v => fmt(v, 0))}</td><td class="l ${r.feasible ? 'ok' : 'ng'}">${r.feasible ? 'OK' : 'NG'}${r.reasons.length ? ' <span class="dim small">' + esc(r.reasons.join(' · ')) + '</span>' : ''}</td><td><button class="btn sm" data-play="${esc(r.id)}">3D</button></td></tr>`).join('') +
      invalid.map(r => `<tr><td>–</td><td class="l dim">${esc(designLabel(r.design))}</td><td>${r.design.totalCranes}</td><td>–</td><td colspan="4" class="l dim small">무효 — ${esc(r.invalidReason)}</td><td class="l ng">불가</td><td></td></tr>`).join('');
    $('optTable').querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => { const r = App.opt.rows.find(x => x.id === b.dataset.play); if (r) { setScenario(clone(r.scenario)); showTab('anim'); } }));
    const cards = $('optCharts');
    if (rows.length) {
      cards.innerHTML = card('pareto', 'Pareto — 총 크레인 수 vs 평균 대기', '실행가능 = 채운 점, 추천 = 파란 링', true);
      $('lg_pareto').innerHTML = STCCharts.scatter($('ch_pareto'), { points: rows.map(r => ({ x: r.design.totalCranes, y: r.m.waitIn.mean, label: designLabel(r.design), feasible: r.feasible, best: rk.best === r, reason: r.reasons[0] })), xLabel: '총 크레인 수', yLabel: '평균 대기 s', xFormat: v => fmt(v, 0) }).legend;
    } else cards.innerHTML = '';
  }
  $('btnOptRun').addEventListener('click', runOptimizer);
  $('btnOptCancel').addEventListener('click', () => { if (App.pool) App.pool.cancel(); });

  /* ================= ⑥ 해석식 ================= */
  function renderFem() {
    const root = $('femBody'); if (!root) return;
    let f;
    try { f = STCFem.rev0(App.sc); } catch (e) { root.innerHTML = '<div class="section"><h2>해석식</h2><div class="msgs"><div class="err">계산 불가: ' + esc(e.message) + '</div></div></div>'; return; }
    const r = App.last;
    const cr = r ? r.cranes[0] : null;
    const cmp = (simV, femV) => (r && simV > 0 && femV > 0) ? `<td>${fmt(simV, 1)}</td><td class="${Math.abs(simV / femV - 1) <= 0.05 ? 'ok' : (Math.abs(simV / femV - 1) <= 0.10 ? '' : 'ng')}">${((simV / femV - 1) * 100).toFixed(1)}%</td>` : '<td class="muted">–</td><td class="muted">–</td>';
    const ins = f.stations.filter(s => s.kind === 'in' && s.rate > 0), outs = f.stations.filter(s => s.kind === 'out' && s.rate > 0);
    const tm1In = ins.length ? ins.reduce((a, s) => a + s.rate * s.tm1, 0) / ins.reduce((a, s) => a + s.rate, 0) : 0;
    const tm1Out = outs.length ? outs.reduce((a, s) => a + s.rate * s.tm1, 0) / outs.reduce((a, s) => a + s.rate, 0) : 0;
    let h = `<div class="section"><h2>FEM 9.851 준용 해석식 (계산서 Rev.0 방법)</h2>
      <div class="dim small">대표점 P1 (x0+L/5, 2H/3) = (${f.P1.x.toFixed(2)}, ${f.P1.y.toFixed(2)}) m · P2 (x0+2L/3, H/5) = (${f.P2.x.toFixed(2)}, ${f.P2.y.toFixed(2)}) m · 각 leg는 체비셰프 max(tx, ty) · 이재 ${f.forkCycle.toFixed(2)} s/회 · 정지·전환 ${f.tPos} s/개소 · 가동률 η = ${f.eta}${f.parallelAisles > 1 ? ' · 통로 ' + f.parallelAisles + '개 (수요 ÷ ' + f.parallelAisles + ')' : ''}</div></div>`;
    h += `<div style="height:12px"></div><div class="kpis"><div class="kpi hero"><div class="k">이용률 U = D / S</div><div class="v">${pct(f.U, 0)}</div><div class="sub">D = ${fmt(f.D, 0)} s/h · S = 3,600 × η = ${fmt(f.S, 0)} s/h</div></div>
      <div class="kpi"><div class="k">필요 대수 N</div><div class="v">${fmt(f.N, 2)}<small>→ ${Math.ceil(f.N - 1e-9)}대</small></div></div>
      <div class="kpi"><div class="k">1대 처리능력</div><div class="v">${fmt(f.capacityPairs, 1)}<small>쌍/h</small></div><div class="sub">요구 ${fmt(f.pairsTotal, 1)} 쌍/h → 충족률 ${pct(f.fulfillment, 1)}</div></div>
      <div class="kpi"><div class="k">복합사이클 가중평균</div><div class="v">${fmt(f.tAvg, 1)}<small>s</small></div></div>
      <div class="kpi"><div class="k">단독 전용 운전 시 이용률</div><div class="v">${pct(f.scOnly.U, 0)}</div><div class="sub">${fmt(f.scOnly.moves, 0)} moves/h</div></div></div>`;
    h += `<div class="section"><h2>복합사이클 (DC) 구성 <span class="dim">— 입고 E → P1 → P2 → 출고 A + 이재 4회 + 부대 4개소 + 공차 복귀 A → E</span></h2><div class="tblwrap"><table class="tbl"><tr><th class="l">구성</th><th>쌍/h</th><th>E→P1</th><th>P1→P2</th><th>P2→A</th><th>이재 4회</th><th>부대</th><th>공차 복귀</th><th>합계 s</th><th>시뮬 DC 평균 s</th><th>Δ</th></tr>` +
      f.dc.map(d => `<tr><td class="l">${esc(d.inId)} → ${esc(d.outId)}</td><td>${fmt(d.pairs, 1)}</td><td>${fmt(d.legs.eP1, 1)}</td><td>${fmt(d.legs.p1p2, 1)}</td><td>${fmt(d.legs.p2A, 1)}</td><td>${fmt(d.transfers, 1)}</td><td>${fmt(d.aux, 1)}</td><td>${fmt(d.legs.ret, 1)}</td><td><b>${fmt(d.t, 1)}</b></td><td class="muted">–</td><td class="muted">–</td></tr>`).join('') +
      `<tr><td class="l"><b>가중평균 Σ(λ·t)/Σλ</b></td><td>${fmt(f.pairsTotal, 1)}</td><td colspan="6"></td><td><b>${fmt(f.tAvg, 1)}</b></td>${cmp(cr ? cr.meanCycle.dc : 0, f.tAvg)}</tr></table></div>
      ${f.residualIn > 0 ? '<div class="dim small">입고 초과분 ' + fmt(f.residualIn, 1) + ' 건/h는 계산서 관행대로 쌍에 포함(근사).</div>' : ''}${f.residualOut > 0 ? '<div class="dim small">출고 초과분 ' + fmt(f.residualOut, 1) + ' 건/h는 출고 단독사이클로 가산 (' + fmt(f.D_res, 0) + ' s/h).</div>' : ''}</div>`;
    h += `<div class="section"><h2>단독사이클 (SC, 왕복) <span class="dim">— tm1 = t(S,P1) + t(S,P2) + 2·이재 + 2·부대</span></h2><div class="tblwrap"><table class="tbl"><tr><th class="l">스테이션</th><th class="l">종류</th><th>건/h</th><th>t(S,P1)</th><th>t(S,P2)</th><th>tm1 s</th></tr>` +
      f.stations.map(s => `<tr><td class="l">${esc(s.id)}</td><td class="l">${s.kind === 'in' ? '입고' : '출고'}</td><td>${fmt(s.rate, 1)}</td><td>${fmt(s.tP1, 1)}</td><td>${fmt(s.tP2, 1)}</td><td><b>${fmt(s.tm1, 1)}</b></td></tr>`).join('') +
      `<tr><td class="l"><b>입고 가중평균</b></td><td></td><td></td><td></td><td></td><td><b>${fmt(tm1In, 1)}</b></td></tr><tr><td class="l"><b>출고 가중평균</b></td><td></td><td></td><td></td><td></td><td><b>${fmt(tm1Out, 1)}</b></td></tr></table></div></div>`;
    if (r && cr) {
      const eta = App.sc.crane.availability || 1;
      h += `<div class="section"><h2>시뮬레이션 대조 <span class="dim">— PRD §7.1: 계산기 vs 시뮬레이터 사이클타임 &lt; 5%</span></h2><div class="tblwrap"><table class="tbl"><tr><th class="l">항목</th><th>해석식</th><th>시뮬 (${esc(cr.id)})</th><th>Δ</th><th class="l">비고</th></tr>
        <tr><td class="l">SC-in 사이클 s</td><td>${fmt(tm1In, 1)}</td>${cmp(cr.meanCycle.scIn, tm1In)}<td class="l dim small">${cr.cycles.scIn}회 · SC-return이면 home 왕복, SC-stay/DC 폴백이면 접근 leg 포함</td></tr>
        <tr><td class="l">SC-out 사이클 s</td><td>${fmt(tm1Out, 1)}</td>${cmp(cr.meanCycle.scOut, tm1Out)}<td class="l dim small">${cr.cycles.scOut}회</td></tr>
        <tr><td class="l">DC 사이클 s</td><td>${fmt(f.tAvg, 1)}</td>${cmp(cr.meanCycle.dc, f.tAvg)}<td class="l dim small">${cr.cycles.dc}회 · 해석식은 공차 복귀 포함, 시뮬은 다음 작업의 접근 leg가 그 역할</td></tr>
        <tr><td class="l">이용률</td><td>${pct(f.U, 0)}</td><td>${pct(cr.busy / eta, 0)} (busy ${pct(cr.busy, 0)} ÷ η)</td><td>${f.U > 0 ? ((cr.busy / eta / f.U - 1) * 100).toFixed(1) + '%' : '–'}</td><td class="l dim small">포화 시 시뮬 busy는 100%에서 상한 — 해석식 U > 100%와 직접 비교 불가</td></tr>
        </table></div><div class="dim small">소형 랙(5×6)은 P1/P2 연속 균일 가정과 격자 이산화 차이로 5~8% 차이가 정상입니다. 5% 기준은 대형 랙 검증 프리셋(50×15)으로 판정합니다 (⑦ 도움말 검증표).</div></div>`;
    } else h += '<div class="section dim small">단일 실행(③ 통계) 후 시뮬레이션 값과 나란히 비교됩니다.</div>';
    root.innerHTML = h;
  }

  /* ================= ⑦ 도움말 ================= */
  function renderHelp() {
    const b = window.STC_BUILD || {};
    $('helpBody').innerHTML = `
      <h2>이 도구</h2>
      <p>단일 통로 AS/RS 스태커크레인(STC)의 이산사건 시뮬레이터입니다. FlexSim처럼 <b>3D 애니메이션 · 통계 대시보드 · 실험기(시나리오 × 반복, 95% CI) · 최적화기(대수·조닝·디스패치 탐색)</b>를 한 파일에서 제공하며, 같은 물리 모델로 계산한 <b>FEM 9.851 준용 해석식</b>과 나란히 비교합니다. 의존성 없는 단일 HTML(Three.js r128 내장)이며 오프라인에서 동작합니다.</p>
      <h2>모델 가정</h2>
      <ul>
        <li><b>시간 모델</b>: 순수 이산사건(이벤트 힙). 애니메이션은 같은 엔진을 시간 전진시키며 위치를 운동학 프로파일로 보간합니다.</li>
        <li><b>운동학</b>: 축별 사다리꼴/삼각 프로파일(가·감속 분리, 저속 접근·고정 지연 옵션). 주행·승강 동시 동작은 체비셰프 max(tx, ty) + 위치결정 시간. 이동시간은 통합플랫폼 공통 운동학 커널(MHKernel v0.1.0)만 호출합니다.</li>
        <li><b>이재</b>: 포크 신장 + 승강·안착 + 인입, 또는 지정값 t_ü(계산서 Rev.0: 8.0 s/회).</li>
        <li><b>셀</b>: single deep, 상태 empty / 입고 예약 / 점유 / 반출 예약. 초기 충전률만큼 임의 셀에 적재물 배치.</li>
        <li><b>스테이션</b>: 입고는 도착(takt ± 편차 / poisson)마다 작업 생성, 용량 초과분은 백로그(상류 라인 정지시간으로 집계). 출고는 호출(takt/poisson)마다 작업 생성, 재고 ≥ minStock 일 때만 디스패치.</li>
        <li><b>존</b>: 크레인 1대 = 사각 존 1개. 존은 겹치지 않으며(레일 충돌 모델 없음) 스테이션과 셀은 위치로 존에 귀속됩니다. 출고 스테이션이 없는 존은 반출이 불가능하므로 검증에서 오류로 보고합니다.</li>
        <li><b>범위 밖</b>: ABC 클래스 저장, Double Deep 재배치, 크레인 고장·정비(가동률 η는 해석식 환산에만 사용), 통로 간 이송.</li>
      </ul>
      <h2>운영 정책</h2>
      <table><tr><th>변수</th><th>값</th><th>의미</th></tr>
        <tr><td>mode</td><td>SC-return / SC-stay / DC</td><td>단독사이클 후 home 복귀(FEM tm1 대응) / 제자리 대기 / 입고 1 + 출고 1 복합사이클(FEM tm2 대응, 한쪽만 있으면 단독 폴백)</td></tr>
        <tr><td>pairing</td><td>fifo / nearest</td><td>DC에서 반출 셀 선택: 오래된 호출 순 규칙 / 저장 셀 → 반출 셀 → 출고 스테이션 잔여 이동 최소</td></tr>
        <tr><td>priority</td><td>oldest-first / storage-first / retrieval-first / alternate</td><td>단독 디스패치 시 입·출고 선택. agingLimit_s를 두면 반대 클래스가 그 시간 이상 기다리면 우선</td></tr>
        <tr><td>storageRule</td><td>random-empty / closest-open</td><td>저장 셀: 임의 빈 셀 / 입고 스테이션에서 체비셰프 시간 최소</td></tr>
        <tr><td>retrievalCell</td><td>random / fifo / nearest</td><td>반출 셀(any 반출 시): 임의 점유 셀 / 입고순 / 잔여 이동 최소</td></tr></table>
      <h2>KPI 정의</h2>
      <table><tr><th>지표</th><th>정의</th></tr>
        <tr><td>달성률</td><td>통계 구간 완료 작업 ÷ 생성 작업</td></tr>
        <tr><td>가동률(busy)</td><td>공차 주행 + 적재 주행 + 이재 시간 비율 (블로킹·기아·유휴 제외). η 반영 이용률 = busy ÷ η</td></tr>
        <tr><td>대기시간</td><td>입고: 도착 → 크레인 픽업. 출고: 호출 → 출고 스테이션 적치</td></tr>
        <tr><td>사이클타임</td><td>디스패치 → 계획 완료(SC-return은 복귀 포함)</td></tr>
        <tr><td>라인 정지시간</td><td>입고 스테이션 대기 수가 용량을 초과한 시간 합</td></tr>
        <tr><td>포화</td><td>총 대기열의 후반 ¼ 평균이 전반 ¼ 평균의 1.5배 초과(또는 달성률 &lt; 90%이며 대기열이 용량의 2배 초과)</td></tr>
        <tr><td>판정</td><td>달성률 ≥ 목표 ∧ 최대 가동률 ≤ ρ ∧ 대기열 비증가 ∧ 평균 대기열 ≤ 상한 ∧ 처리 불가·블로킹 없음</td></tr></table>
      <h2>실험기 · 최적화기</h2>
      <ul><li>같은 rep 번호는 시나리오 간 같은 난수 스트림(공통난수)을 사용해 정책 차이가 난수 차이에 묻히지 않게 합니다. 95% CI는 t 분포(df = R − 1).</li>
        <li>최적화기는 유효 설계 전부를 R₁회 실행해 순위를 매기고, 상위 k개를 R₂회로 재평가합니다. 목적은 사전식: 총 크레인 수 → 실행가능 → 최대 가동률 → 평균 대기.</li>
        <li><b>parallelAisles</b>(병렬 통로 수)는 동일 배치 통로 k개에 수요를 나눈 것으로, 계산서 Rev.0의 "필요 대수 3대 = 통로 3개"와 동등 비교입니다. 1통로 내 조닝은 대안입니다.</li></ul>
      <h2>검증 (노드 테스트, 빌드 시 배포물에서 재실행)</h2>
      <table><tr><th>항목</th><th>결과</th></tr>
        <tr><td>대형 랙 50×15 SC-return 평균 vs FEM tm1E</td><td>Δ +3.2% (기준 5%)</td></tr>
        <tr><td>대형 랙 DC 평균 vs FEM tm2</td><td>Δ −2.0% (기준 5%)</td></tr>
        <tr><td>Bozer &amp; White 정사각-시간 랙 E(SC)/T = 1 + b²/3</td><td>셀 전수 열거 ±1e-3, 시뮬 표본평균 b=1 +1.1% · b=0.5 −1.0% (기준 2%)</td></tr>
        <tr><td>차체 저장 설비 Rev.0, 1대 DC</td><td>DC 평균 86.2 s vs 계산서 87.7 s (−1.7%), 달성률 45% (계산서 충족률 39.7% ÷ η 0.9 = 44.1%)</td></tr>
        <tr><td>FEM 9.851 표준식 이식</td><td>Python stc_calculator.py 골든 11케이스 1e-6 일치</td></tr>
        <tr><td>결정성·보존식·존 불변식·스텝 전진 = 일괄 실행</td><td>통과</td></tr></table>
      <h2>단축 사용법</h2>
      <ol><li>① 프리셋을 고르거나 JSON을 편집한다 → 검증 메시지 확인.</li><li>② 재생으로 거동 확인(배속·카메라).</li><li>③ 단일 실행으로 KPI·분포 확인, ⑥에서 해석식과 대조.</li><li>④ 변수 조합 × 반복으로 CI 비교, ⑤로 최소 대수·조닝·디스패치 탐색.</li></ol>
      <p class="dim small">빌드 ${esc(b.version || 'dev')} · ${esc(b.builtAt || '')} · three ${esc(b.three || '')}</p>`;
  }

  /* ================= 초기화 ================= */
  document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('presetSel').innerHTML = STCPresets.list.map(p => `<option value="${p.key}">${esc(p.label)}</option>`).join('');
  $('hdBuild').textContent = (window.STC_BUILD && window.STC_BUILD.version) ? 'v' + window.STC_BUILD.version + ' · ' + window.STC_BUILD.builtAt.slice(0, 10) : 'dev';
  renderHelp();
  setScenario(STCPresets.get('carBodyRev0'));
  ensurePool();
  window.STCApp = App;
})();

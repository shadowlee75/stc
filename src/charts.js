'use strict';
/* ============================================================
 * STC 시뮬레이터 — Canvas 2D 차트 (charts.js)
 * 얇은 마크 · 2 px 표면 간격 · 헤어라인 격자 · 범례(2계열 이상) · 선택적 직접 라벨 · 호버 툴팁
 * ============================================================ */
const STCCharts = (() => {
  const T = {
    surface: '#ffffff', ink: '#111111', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
    accent: '#002FA7', good: '#0ca30c', critical: '#d03b3b', warning: '#fab219',
    slots: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    font: '12px "Helvetica Neue", Helvetica, Arial, "Malgun Gothic", "맑은 고딕", sans-serif',
    fontSmall: '11px "Helvetica Neue", Helvetica, Arial, "Malgun Gothic", "맑은 고딕", sans-serif',
  };
  const slot = (i) => T.slots[i % T.slots.length];

  function setup(canvas, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 600);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = '100%'; canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = T.font; ctx.textBaseline = 'middle';
    ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, height);
    return { ctx, w, h: height };
  }

  function niceStep(range, n) {
    const raw = range / Math.max(1, n);
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }
  function ticks(min, max, n) {
    if (!(max > min)) max = min + 1;
    const step = niceStep(max - min, n);
    const t0 = Math.ceil(min / step) * step, out = [];
    for (let v = t0; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function fmtNum(v, d) {
    if (!Number.isFinite(v)) return '–';
    if (d !== undefined) return v.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
    const a = Math.abs(v);
    return v.toLocaleString('ko-KR', { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 });
  }
  function fmtTime(sec) {
    const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + ':' + String(m).padStart(2, '0');
  }
  function textFits(ctx, text, width) { return ctx.measureText(text).width <= width - 8; }
  function inkOn(hex) {   // 채움 위 라벨색: 밝기 기준
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? T.ink : '#ffffff';
  }

  // ---------- 툴팁 ----------
  let tipEl = null;
  function tooltip(show, x, y, html) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'chart-tip'; document.body.appendChild(tipEl); }
    if (!show) { tipEl.style.display = 'none'; return; }
    tipEl.innerHTML = html; tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
  }
  function bindHover(canvas, onMove) {
    if (canvas._hoverOff) canvas._hoverOff();
    const mm = (e) => { const r = canvas.getBoundingClientRect(); onMove(e.clientX - r.left, e.clientY - r.top, e.clientX, e.clientY); };
    const ml = () => { tooltip(false); onMove(null); };
    canvas.addEventListener('mousemove', mm); canvas.addEventListener('mouseleave', ml);
    canvas._hoverOff = () => { canvas.removeEventListener('mousemove', mm); canvas.removeEventListener('mouseleave', ml); };
  }

  function legendHTML(items) {
    return items.map(it => `<span class="lg"><i style="background:${it.color}${it.dashed ? ';height:0;border-top:2px dashed ' + it.color + ';background:none' : ''}"></i>${it.name}</span>`).join('');
  }

  // ---------- 선 차트 (시계열) ----------
  // opt: { x:[], series:[{name, values:[], color}], refLines:[{value,label,color}], shade:{x0,x1,label}, height, yFormat, xFormat, yMin, area:bool, unit }
  function lineChart(canvas, opt) {
    const H = opt.height || 220;
    const { ctx, w, h } = setup(canvas, H);
    const padL = 52, padR = 16, padT = 14, padB = 30;
    const pw = w - padL - padR, ph = h - padT - padB;
    const xs = opt.x || [];
    const n = xs.length;
    const allY = [];
    for (const s of opt.series) for (const v of s.values) if (Number.isFinite(v)) allY.push(v);
    for (const r of (opt.refLines || [])) allY.push(r.value);
    let yMin = opt.yMin !== undefined ? opt.yMin : Math.min(0, ...allY), yMax = Math.max(...allY, 1e-9);
    const yT = ticks(yMin, yMax, 4); yMax = Math.max(yMax, yT[yT.length - 1]); yMin = Math.min(yMin, yT[0]);
    const x0 = n ? xs[0] : 0, x1 = n ? xs[n - 1] : 1;
    const X = (v) => padL + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * pw;
    const Y = (v) => padT + ph - (v - yMin) / (yMax - yMin) * ph;
    const xFormat = opt.xFormat || fmtTime, yFormat = opt.yFormat || fmtNum;

    function draw(hoverI) {
      ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, h);
      if (opt.shade && n) { ctx.fillStyle = 'rgba(0,47,167,0.05)'; ctx.fillRect(X(opt.shade.x0), padT, X(opt.shade.x1) - X(opt.shade.x0), ph); }
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.font = T.fontSmall; ctx.textAlign = 'right';
      for (const t of yT) { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillText(yFormat(t), padL - 6, y); }
      ctx.strokeStyle = T.axis; ctx.beginPath(); ctx.moveTo(padL, padT + ph + 0.5); ctx.lineTo(w - padR, padT + ph + 0.5); ctx.stroke();
      ctx.textAlign = 'center';
      const xt = ticks(x0, x1, Math.max(2, Math.floor(pw / 90)));
      for (const t of xt) if (t >= x0 && t <= x1) ctx.fillText(xFormat(t), X(t), padT + ph + 14);
      for (const r of (opt.refLines || [])) {
        const y = Math.round(Y(r.value)) + 0.5;
        ctx.strokeStyle = r.color || T.ink2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.setLineDash([]);
        if (r.label) { ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.fillText(r.label + ' ' + yFormat(r.value), padL + 4, y - 8); }
      }
      opt.series.forEach((s) => {
        if (opt.area) {
          ctx.fillStyle = s.color; ctx.globalAlpha = 0.1; ctx.beginPath();
          s.values.forEach((v, i) => { const px = X(xs[i]), py = Y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
          ctx.lineTo(X(xs[n - 1]), Y(yMin)); ctx.lineTo(X(xs[0]), Y(yMin)); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
        s.values.forEach((v, i) => { const px = X(xs[i]), py = Y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.stroke();
      });
      // 끝점 라벨 (계열 ≤ 4, 충돌 시 생략)
      if (opt.series.length <= 4 && n) {
        const ends = opt.series.map(s => ({ y: Y(s.values[n - 1]), name: s.name, color: s.color })).sort((a, b) => a.y - b.y);
        let ok = true; for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ok = false;
        if (ok) { ctx.textAlign = 'right'; ctx.font = T.fontSmall; for (const e of ends) { ctx.fillStyle = T.ink2; ctx.fillText(e.name, w - padR - 2, e.y - 8); } }
      }
      if (hoverI !== null && hoverI !== undefined && n) {
        const px = Math.round(X(xs[hoverI])) + 0.5;
        ctx.strokeStyle = T.ink2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ph); ctx.stroke();
        for (const s of opt.series) { const py = Y(s.values[hoverI]); ctx.fillStyle = T.surface; ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    draw(null);
    bindHover(canvas, (mx, my, cx, cy) => {
      if (mx === null || !n) { draw(null); return; }
      if (mx < padL - 12 || mx > w - padR + 12) { draw(null); tooltip(false); return; }
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(X(xs[i]) - mx); if (d < bd) { bd = d; best = i; } }
      draw(best);
      const rows = opt.series.map(s => `<div><i style="background:${s.color}"></i>${s.name} <b>${yFormat(s.values[best])}${opt.unit || ''}</b></div>`).join('');
      tooltip(true, cx, cy, `<div class="tt">${xFormat(xs[best])}</div>${rows}`);
    });
    return { legend: opt.series.length >= 2 ? legendHTML(opt.series.concat((opt.refLines || []).map(r => ({ name: r.label, color: r.color || T.ink2, dashed: true })))) : '' };
  }

  // ---------- 누적 가로 막대 (상태 시간 비율) ----------
  // opt: { rows:[{label, segments:[{key,name,value,color}]}], height }  value = 비율(합 1)
  function stackedBars(canvas, opt) {
    const rowH = 34, H = opt.height || (opt.rows.length * rowH + 16);
    const { ctx, w, h } = setup(canvas, H);
    const padL = Math.min(120, Math.max(60, ...opt.rows.map(r => ctx.measureText(r.label).width + 16))), padR = 12;
    const pw = w - padL - padR;
    const bars = [];
    function draw(hover) {
      ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, h);
      bars.length = 0;
      opt.rows.forEach((row, ri) => {
        const y = 8 + ri * rowH, bh = 22;
        ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.font = T.font; ctx.fillText(row.label, 0, y + bh / 2);
        let x = padL;
        const total = row.segments.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
        row.segments.forEach((s, si) => {
          const wSeg = Math.max(0, s.value) / total * pw;
          if (wSeg <= 0) return;
          const gap = si > 0 ? 2 : 0;
          const bx = x + gap, bw = Math.max(0, wSeg - gap);
          ctx.fillStyle = s.color; ctx.globalAlpha = hover && hover !== s ? 0.55 : 1;
          ctx.fillRect(bx, y, bw, bh); ctx.globalAlpha = 1;
          const label = (s.value * 100).toFixed(0) + '%';
          ctx.font = T.fontSmall;
          if (bw >= 30 && textFits(ctx, label, bw)) { ctx.fillStyle = inkOn(s.color); ctx.textAlign = 'center'; ctx.fillText(label, bx + bw / 2, y + bh / 2); }
          bars.push({ x: bx, y, w: bw, h: bh, seg: s, row });
          x += wSeg;
        });
      });
    }
    draw(null);
    bindHover(canvas, (mx, my, cx, cy) => {
      if (mx === null) { draw(null); return; }
      const hit = bars.find(b => mx >= b.x - 1 && mx <= b.x + b.w + 1 && my >= b.y - 4 && my <= b.y + b.h + 4);
      draw(hit ? hit.seg : null);
      if (hit) tooltip(true, cx, cy, `<div class="tt">${hit.row.label}</div><div><i style="background:${hit.seg.color}"></i>${hit.seg.name} <b>${(hit.seg.value * 100).toFixed(1)}%</b></div>`); else tooltip(false);
    });
    const segs = opt.rows[0] ? opt.rows[0].segments : [];
    return { legend: legendHTML(segs.map(s => ({ name: s.name, color: s.color }))) };
  }

  // ---------- 도넛 (부분-전체, ≤ 6 조각) ----------
  function donut(canvas, opt) {
    const H = opt.height || 160;
    const { ctx, w, h } = setup(canvas, H);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 8, r = R * 0.62;
    const segs = opt.segments.filter(s => s.value > 0);
    const total = segs.reduce((a, s) => a + s.value, 0) || 1;
    const arcs = [];
    function draw(hover) {
      ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, h);
      let a0 = -Math.PI / 2; arcs.length = 0;
      for (const s of segs) {
        const a1 = a0 + s.value / total * Math.PI * 2;
        ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.arc(cx, cy, r, a1, a0, true); ctx.closePath();
        ctx.fillStyle = s.color; ctx.globalAlpha = hover && hover !== s ? 0.55 : 1; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = T.surface; ctx.lineWidth = 2; ctx.stroke();
        arcs.push({ a0, a1, s });
        if (s.value / total >= 0.08) {
          const am = (a0 + a1) / 2, lx = cx + Math.cos(am) * (R + r) / 2, ly = cy + Math.sin(am) * (R + r) / 2;
          ctx.fillStyle = inkOn(s.color); ctx.textAlign = 'center'; ctx.font = T.fontSmall; ctx.fillText((s.value / total * 100).toFixed(0) + '%', lx, ly);
        }
        a0 = a1;
      }
      if (opt.center) { ctx.fillStyle = T.ink; ctx.textAlign = 'center'; ctx.font = 'bold 16px "Helvetica Neue", Helvetica, Arial, sans-serif'; ctx.fillText(opt.center, cx, cy - 6); ctx.font = T.fontSmall; ctx.fillStyle = T.muted; ctx.fillText(opt.centerLabel || '', cx, cy + 10); }
    }
    draw(null);
    bindHover(canvas, (mx, my, cxs, cys) => {
      if (mx === null) { draw(null); return; }
      const dx = mx - cx, dy = my - cy, d = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx); if (ang < -Math.PI / 2) ang += Math.PI * 2;
      const hit = d >= r - 4 && d <= R + 4 ? arcs.find(a => ang >= a.a0 && ang <= a.a1) : null;
      draw(hit ? hit.s : null);
      if (hit) tooltip(true, cxs, cys, `<div><i style="background:${hit.s.color}"></i>${hit.s.name} <b>${(hit.s.value / total * 100).toFixed(1)}%</b></div>`); else tooltip(false);
    });
    return { legend: legendHTML(segs.map(s => ({ name: s.name, color: s.color }))) };
  }

  // ---------- 히스토그램 (고정빈 counts, 마지막 = overflow) ----------
  // opt: { hist:{binSize,maxVal,counts,count,mean}, color, height, unit, xFormat, markers:[{value,label}] }
  function histogram(canvas, opt) {
    const H = opt.height || 170;
    const { ctx, w, h } = setup(canvas, H);
    const padL = 40, padR = 12, padT = 12, padB = 28;
    const pw = w - padL - padR, ph = h - padT - padB;
    const hs = opt.hist || { counts: [], binSize: 1, maxVal: 1, count: 0 };
    const counts = hs.counts || [];
    // 뒤쪽 빈 빈 잘라내기 (overflow는 값이 있을 때만 표시)
    let last = counts.length - 1; while (last > 0 && counts[last] === 0) last--;
    const nb = Math.max(1, last + 1);
    const maxC = Math.max(1, ...counts.slice(0, nb));
    const yT = ticks(0, maxC, 3);
    const yMax = yT[yT.length - 1] || maxC;
    const slotW = pw / nb, bw = Math.min(24, Math.max(2, slotW - 2));
    const bars = [];
    const xf = opt.xFormat || ((v) => fmtNum(v, 0));
    function draw(hover) {
      ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.font = T.fontSmall; ctx.textAlign = 'right';
      for (const t of yT) { const y = Math.round(padT + ph - t / yMax * ph) + 0.5; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillText(fmtNum(t, 0), padL - 6, y); }
      ctx.strokeStyle = T.axis; ctx.beginPath(); ctx.moveTo(padL, padT + ph + 0.5); ctx.lineTo(w - padR, padT + ph + 0.5); ctx.stroke();
      bars.length = 0;
      for (let i = 0; i < nb; i++) {
        const c = counts[i] || 0, bh = c / yMax * ph;
        const x = padL + i * slotW + (slotW - bw) / 2, y = padT + ph - bh;
        ctx.fillStyle = opt.color || T.slots[0]; ctx.globalAlpha = hover !== null && hover !== i ? 0.55 : 1;
        if (bh > 0) { roundTop(ctx, x, y, bw, bh, Math.min(4, bw / 2)); ctx.fill(); }
        ctx.globalAlpha = 1;
        bars.push({ x: padL + i * slotW, w: slotW, i, c });
      }
      const every = Math.max(1, Math.ceil(nb / Math.max(2, Math.floor(pw / 60))));
      ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.font = T.fontSmall;
      for (let i = 0; i <= nb; i += every) {
        const isOver = i === counts.length - 1 && i === nb - 1 && i * hs.binSize >= hs.maxVal;
        ctx.fillText(isOver ? '≥' + xf(hs.maxVal) : xf(i * hs.binSize), padL + i * slotW, padT + ph + 14);
      }
      for (const m of (opt.markers || [])) {
        const x = Math.round(padL + Math.min(nb, m.value / hs.binSize) * slotW) + 0.5;
        ctx.strokeStyle = m.color || T.ink2; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.fillText(m.label + ' ' + xf(m.value), x + 4, padT + 6);
      }
    }
    draw(null);
    bindHover(canvas, (mx, my, cx, cy) => {
      if (mx === null) { draw(null); return; }
      const hit = bars.find(b => mx >= b.x && mx < b.x + b.w);
      draw(hit ? hit.i : null);
      if (hit) tooltip(true, cx, cy, `<div class="tt">${xf(hit.i * hs.binSize)} – ${xf((hit.i + 1) * hs.binSize)}${opt.unit || ''}</div><div><b>${hit.c}</b> 건 (${hs.count ? (hit.c / hs.count * 100).toFixed(1) : 0}%)</div>`); else tooltip(false);
    });
    return { legend: '' };
  }
  function roundTop(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h); ctx.closePath();
  }

  // ---------- 점-수염 (평균 ± CI, 가로) ----------
  // opt: { rows:[{label, mean, ci, color, marker:'ok'|'ng'|null}], height, xFormat, refLine:{value,label}, unit }
  function ciDots(canvas, opt) {
    const rowH = 26, H = opt.height || (opt.rows.length * rowH + 30);
    const { ctx, w, h } = setup(canvas, H);
    const padL = Math.min(260, Math.max(80, ...opt.rows.map(r => ctx.measureText(r.label).width + 12))), padR = 16, padT = 6, padB = 24;
    const pw = w - padL - padR;
    const vals = opt.rows.flatMap(r => [r.mean - (r.ci || 0), r.mean + (r.ci || 0)]).filter(Number.isFinite);
    if (opt.refLine) vals.push(opt.refLine.value);
    let xMin = Math.min(0, ...vals), xMax = Math.max(...vals, 1e-9);
    const xT = ticks(xMin, xMax, Math.max(2, Math.floor(pw / 80))); xMax = Math.max(xMax, xT[xT.length - 1]); xMin = Math.min(xMin, xT[0]);
    const X = (v) => padL + (v - xMin) / (xMax - xMin) * pw;
    const xf = opt.xFormat || fmtNum;
    const dots = [];
    function draw(hover) {
      ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = T.grid; ctx.font = T.fontSmall; ctx.fillStyle = T.muted; ctx.textAlign = 'center';
      for (const t of xT) { const x = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); ctx.fillText(xf(t), x, h - padB + 12); }
      if (opt.refLine) { const x = Math.round(X(opt.refLine.value)) + 0.5; ctx.strokeStyle = T.ink2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.fillText(opt.refLine.label, x + 4, padT + 8); }
      dots.length = 0;
      opt.rows.forEach((r, i) => {
        const y = padT + 10 + i * rowH;
        ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.font = T.font; ctx.fillText(r.label, 0, y);
        if (!Number.isFinite(r.mean)) return;
        const c = r.color || T.slots[0];
        ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.globalAlpha = hover && hover !== r ? 0.5 : 1;
        if (r.ci > 0) { ctx.beginPath(); ctx.moveTo(X(r.mean - r.ci), y); ctx.lineTo(X(r.mean + r.ci), y); ctx.stroke(); for (const e of [r.mean - r.ci, r.mean + r.ci]) { ctx.beginPath(); ctx.moveTo(X(e), y - 4); ctx.lineTo(X(e), y + 4); ctx.stroke(); } }
        ctx.fillStyle = T.surface; ctx.beginPath(); ctx.arc(X(r.mean), y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(r.mean), y, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        if (r.marker) { ctx.fillStyle = r.marker === 'ok' ? T.good : T.critical; ctx.font = 'bold 11px Arial, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(r.marker === 'ok' ? '✓' : '✕', w - padR - 10, y); }
        dots.push({ x: X(r.mean), y, r });
      });
    }
    draw(null);
    bindHover(canvas, (mx, my, cx, cy) => {
      if (mx === null) { draw(null); return; }
      const hit = dots.find(d => Math.abs(d.y - my) <= 12 && mx >= padL - 10);
      draw(hit ? hit.r : null);
      if (hit) tooltip(true, cx, cy, `<div class="tt">${hit.r.label}</div><div>평균 <b>${xf(hit.r.mean)}${opt.unit || ''}</b> ± ${xf(hit.r.ci || 0)} (95% CI, n=${hit.r.n || '–'})</div>`); else tooltip(false);
    });
    return { legend: '' };
  }

  // ---------- 산점 (Pareto) ----------
  // opt: { points:[{x,y,label,feasible,best}], xLabel, yLabel, height, xFormat, yFormat }
  function scatter(canvas, opt) {
    const H = opt.height || 220;
    const { ctx, w, h } = setup(canvas, H);
    const padL = 52, padR = 16, padT = 14, padB = 34;
    const pw = w - padL - padR, ph = h - padT - padB;
    const pts = opt.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    let xMin = Math.min(0, ...xs), xMax = Math.max(...xs, 1) + 0.5, yMin = 0, yMax = Math.max(...ys, 1e-9);
    const yT = ticks(yMin, yMax, 4); yMax = Math.max(yMax, yT[yT.length - 1]);
    const xT = ticks(xMin, xMax, Math.min(8, Math.max(2, Math.round(xMax - xMin))));
    const X = (v) => padL + (v - xMin) / (xMax - xMin) * pw, Y = (v) => padT + ph - (v - yMin) / (yMax - yMin) * ph;
    const xf = opt.xFormat || ((v) => fmtNum(v, 0)), yf = opt.yFormat || fmtNum;
    function draw(hover) {
      ctx.fillStyle = T.surface; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = T.grid; ctx.font = T.fontSmall; ctx.fillStyle = T.muted;
      ctx.textAlign = 'right'; for (const t of yT) { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillText(yf(t), padL - 6, y); }
      ctx.textAlign = 'center'; for (const t of xT) { const x = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke(); ctx.fillText(xf(t), x, padT + ph + 14); }
      ctx.fillStyle = T.ink2; ctx.fillText(opt.xLabel || '', padL + pw / 2, h - 6);
      ctx.save(); ctx.translate(12, padT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(opt.yLabel || '', 0, 0); ctx.restore();
      for (const p of pts) {
        const x = X(p.x), y = Y(p.y);
        ctx.globalAlpha = hover && hover !== p ? 0.45 : 1;
        if (p.feasible) { ctx.fillStyle = T.surface; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = T.slots[0]; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.strokeStyle = T.muted; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.stroke(); }
        if (p.best) { ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.font = T.fontSmall; ctx.fillText('추천', x + 13, y); }
        ctx.globalAlpha = 1;
      }
    }
    draw(null);
    bindHover(canvas, (mx, my, cx, cy) => {
      if (mx === null) { draw(null); return; }
      let hit = null, bd = 14;
      for (const p of pts) { const d = Math.hypot(X(p.x) - mx, Y(p.y) - my); if (d < bd) { bd = d; hit = p; } }
      draw(hit);
      if (hit) tooltip(true, cx, cy, `<div class="tt">${hit.label}</div><div>${opt.xLabel}: <b>${xf(hit.x)}</b> · ${opt.yLabel}: <b>${yf(hit.y)}</b></div><div>${hit.feasible ? '실행가능' : '불가'}${hit.reason ? ' — ' + hit.reason : ''}</div>`); else tooltip(false);
    });
    return { legend: legendHTML([{ name: '실행가능', color: T.slots[0] }, { name: '불가 (테두리)', color: T.muted }]) };
  }

  return { T, slot, fmtNum, fmtTime, lineChart, stackedBars, donut, histogram, ciDots, scatter, legendHTML, tooltip };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCCharts;

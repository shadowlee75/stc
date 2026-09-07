'use strict';
/* ============================================================
 * STC 시뮬레이터 — Three.js r128 3D 뷰 (view3d.js)
 * 흰 바탕의 기술도면 풍 씬: 랙 셀 프레임(에지 라인) · 적재물 인스턴스 · 크레인(마스트·캐리지·포크) ·
 * 스테이션 패드 + 대기열 스택 · 스프라이트 라벨 · 존 경계 · 자체 오빗 카메라 · 셀 피킹
 * 좌표: x 주행, y 높이, z 통로 가로. 단위 m. 전역 THREE 필요.
 * ============================================================ */
const STCView3D = (() => {
  const Sc = (typeof STCScene !== 'undefined') ? STCScene : null;
  const COL = { ground: 0xffffff, grid1: 0xe1e0d9, grid2: 0xf2f1ee, edge: 0x9a9a94, frame: 0xffffff, load: 0x64748b, loadRes: 0xfdba74,
                stIn: 0x2a78d6, stOut: 0xeb6834, mast: 0x52514e, zone: 0x002fa7, queue: 0x94a3b8 };

  function makeLabel(text, opt) {
    opt = opt || {};
    const c = document.createElement('canvas'); const ctx = c.getContext('2d');
    const font = (opt.bold ? 'bold ' : '') + (opt.px || 28) + 'px "Helvetica Neue", Helvetica, Arial, "Malgun Gothic", sans-serif';
    ctx.font = font; const tw = Math.ceil(ctx.measureText(text).width) + 24;
    c.width = Math.max(64, tw); c.height = (opt.px || 28) + 20;
    ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    if (opt.bg) { ctx.fillStyle = opt.bg; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.fillStyle = opt.color || '#111111'; ctx.fillText(text, c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.userData.aspect = c.width / c.height; sp.userData.text = text;
    return sp;
  }

  class View {
    constructor(container, opt) {
      this.container = container; this.opt = opt || {};
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.setClearColor(COL.ground, 1);
      container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.display = 'block';
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 3000);
      this.target = new THREE.Vector3(0, 0, 0);
      this.sph = { theta: -0.75, phi: 1.05, r: 40 };
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d9d3, 0.95));
      const dl = new THREE.DirectionalLight(0xffffff, 0.55); dl.position.set(0.6, 1, 0.8); this.scene.add(dl);
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.labels = []; this.labelScale = 1;
      this.raycaster = new THREE.Raycaster();
      this._bindOrbit(); this._bindResize();
      this.onPick = null;
    }

    // ---------- 정적 레이아웃 ----------
    setLayout(lay, scenario) {
      this.lay = lay;
      while (this.root.children.length) { const o = this.root.children.pop(); disposeDeep(o); }
      this.labels = [];
      const span = Math.max(lay.xMax - lay.xMin, lay.yTop, 10);
      this.labelScale = Math.max(1.2, span / 30);
      // 바닥 + 격자
      const fw = lay.floor.x1 - lay.floor.x0, fd = lay.floor.z1 - lay.floor.z0;
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), new THREE.MeshLambertMaterial({ color: 0xfafaf8 }));
      floor.rotation.x = -Math.PI / 2; floor.position.set((lay.floor.x0 + lay.floor.x1) / 2, -0.02, (lay.floor.z0 + lay.floor.z1) / 2);
      this.root.add(floor);
      const gsize = Math.max(fw, fd); const grid = new THREE.GridHelper(gsize, Math.round(gsize), COL.grid1, COL.grid2);
      grid.position.set((lay.floor.x0 + lay.floor.x1) / 2, -0.01, (lay.floor.z0 + lay.floor.z1) / 2); this.root.add(grid);
      // 랙 셀 프레임 (에지 라인 1개 지오메트리로 병합)
      const cells = lay.cells; const n = cells.length;
      const edges = new Float32Array(n * 12 * 2 * 3);
      let k = 0;
      const pushEdge = (a, b) => { edges.set(a, k); k += 3; edges.set(b, k); k += 3; };
      for (const c of cells) {
        const x0 = c.x - c.w / 2, x1 = c.x + c.w / 2, y0 = c.y - c.h / 2, y1 = c.y + c.h / 2, z0 = c.z - c.d / 2, z1 = c.z + c.d / 2;
        const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) pushEdge(P[a], P[b]);
      }
      const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(edges, 3));
      this.root.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.55 })));
      // 셀 피킹용 투명 인스턴스 + 선반 바닥판
      const shelfGeo = new THREE.BoxGeometry(1, 1, 1);
      const shelf = new THREE.InstancedMesh(shelfGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 }), n);
      shelf.frustumCulled = false;
      const m = new THREE.Matrix4();
      cells.forEach((c, i) => { m.makeScale(c.w, 0.06, c.d); m.setPosition(c.x, c.y - c.h / 2 + 0.03, c.z); shelf.setMatrixAt(i, m); });
      shelf.instanceMatrix.needsUpdate = true; this.root.add(shelf); this.shelf = shelf;
      const pickGeo = new THREE.BoxGeometry(1, 1, 1);
      const pick = new THREE.InstancedMesh(pickGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0, depthWrite: false }), n);
      pick.frustumCulled = false; pick.visible = true;
      cells.forEach((c, i) => { m.makeScale(c.w, c.h, c.d); m.setPosition(c.x, c.y, c.z); pick.setMatrixAt(i, m); });
      pick.instanceMatrix.needsUpdate = true; this.root.add(pick); this.pickMesh = pick;
      // 적재물 인스턴스
      const L = lay.load;
      const loads = new THREE.InstancedMesh(new THREE.BoxGeometry(L.l, L.h, L.w), new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
      loads.frustumCulled = false;
      const col = new THREE.Color(COL.load);
      cells.forEach((c, i) => { m.makeScale(1e-4, 1e-4, 1e-4); m.setPosition(c.x, c.y - c.h / 2 + L.h / 2 + 0.06, c.z); loads.setMatrixAt(i, m); loads.setColorAt(i, col); });
      loads.instanceMatrix.needsUpdate = true; if (loads.instanceColor) loads.instanceColor.needsUpdate = true;
      this.root.add(loads); this.loads = loads; this.loadShown = new Uint8Array(n); this.loadColor = new Uint8Array(n);
      // 스테이션 패드 + 대기열 스택 + 라벨
      this.stations = {};
      for (const s of lay.stations) {
        const g = new THREE.Group();
        const pad = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), new THREE.MeshLambertMaterial({ color: s.kind === 'in' ? COL.stIn : COL.stOut, transparent: true, opacity: 0.85 }));
        pad.position.set(s.x, s.y - s.h / 2, s.z); g.add(pad);
        const qn = 12;
        const q = new THREE.InstancedMesh(new THREE.BoxGeometry(L.l * 0.7, L.h * 0.7, L.w * 0.7), new THREE.MeshLambertMaterial({ color: COL.queue }), qn);
        q.frustumCulled = false; q.count = 0; g.add(q);
        const lab = makeLabel(s.name + '  n=0', { px: 26, bg: 'rgba(255,255,255,0.85)' });
        this._placeLabel(lab, s.x, s.y + Math.max(1.2, L.h * 1.6), s.z, 0.75);
        g.add(lab); this.labels.push(lab);
        this.root.add(g);
        this.stations[s.id] = { g, pad, q, lab, s, lastQ: -1, lastText: '' };
      }
      // 크레인
      this.cranes = {};
      for (const c of lay.cranes) {
        const g = new THREE.Group();
        const mastH = lay.yTop + 0.5;
        const mast = new THREE.Mesh(new THREE.BoxGeometry(c.mastW, mastH, c.mastW), new THREE.MeshLambertMaterial({ color: COL.mast }));
        mast.position.set(0, mastH / 2, 0); g.add(mast);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(c.carriageW * 1.2, 0.12, lay.aisleW * 0.9), new THREE.MeshLambertMaterial({ color: COL.mast }));
        rail.position.set(0, 0.06, 0); g.add(rail);
        const carr = new THREE.Mesh(new THREE.BoxGeometry(c.carriageW, c.carriageH, lay.aisleW * 0.75), new THREE.MeshLambertMaterial({ color: 0x2a78d6 }));
        g.add(carr);
        const forkT = Math.max(0.06, L.h * 0.08);
        const fork = new THREE.Mesh(new THREE.BoxGeometry(L.l * 0.95, forkT, Math.max(L.w * 0.95, lay.depth * 0.9)), new THREE.MeshLambertMaterial({ color: 0x8a8a84 }));
        g.add(fork);
        const load = new THREE.Mesh(new THREE.BoxGeometry(L.l, L.h, L.w), new THREE.MeshLambertMaterial({ color: COL.load }));
        load.visible = false; g.add(load);
        const lab = makeLabel(c.id, { px: 28, bold: true, bg: 'rgba(255,255,255,0.85)' });
        this._placeLabel(lab, 0, mastH + 1.0, 0, 0.85); g.add(lab); this.labels.push(lab);
        const lab2 = makeLabel('유휴', { px: 24, bg: 'rgba(255,255,255,0.85)' });
        this._placeLabel(lab2, 0, mastH + 0.2, 0, 0.7); g.add(lab2); this.labels.push(lab2);
        this.root.add(g);
        this.cranes[c.id] = { g, mast, carr, fork, load, lab, lab2, c, lastState: '', lastText: '' };
        // 존 경계 (Klein blue 헤어라인)
        const z = c.zone; const zg = new THREE.BufferGeometry();
        zg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([z.x[0], z.y[0], 0, z.x[1], z.y[0], 0, z.x[1], z.y[0], 0, z.x[1], z.y[1], 0, z.x[1], z.y[1], 0, z.x[0], z.y[1], 0, z.x[0], z.y[1], 0, z.x[0], z.y[0], 0]), 3));
        this.root.add(new THREE.LineSegments(zg, new THREE.LineBasicMaterial({ color: COL.zone, transparent: true, opacity: 0.5 })));
      }
      // 카메라 초기화
      this.target.set((lay.xMin + lay.xMax) / 2, lay.yTop * 0.4, 0);
      this.sph.r = Math.max(span * 1.15, 12);
      this.setCamera('iso');
      this.resize();
    }

    _placeLabel(sp, x, y, z, hM) {
      const h = hM * this.labelScale; sp.scale.set(h * sp.userData.aspect, h, 1); sp.position.set(x, y, z);
    }
    _setLabelText(entry, key, sp, text, opt) {
      if (entry[key] === text) return;
      entry[key] = text;
      const nl = makeLabel(text, opt);
      sp.material.map.dispose(); sp.material.map = nl.material.map; sp.material.needsUpdate = true;
      sp.userData.aspect = nl.userData.aspect; sp.scale.set(sp.scale.y * nl.userData.aspect, sp.scale.y, 1);
      nl.material.dispose();
    }

    // ---------- 동적 프레임 ----------
    update(frame) {
      if (!this.lay) return;
      const lay = this.lay, L = lay.load, m = new THREE.Matrix4();
      // 적재물
      let dirty = false, cdirty = false;
      for (let i = 0; i < frame.cellShowLoad.length; i++) {
        const show = frame.cellShowLoad[i], st = frame.cellState[i];
        const colKey = st === 3 ? 2 : (st === 1 ? 1 : 0);
        if (show !== this.loadShown[i]) {
          const c = lay.cellIndex[i];
          if (show) m.makeScale(1, 1, 1); else m.makeScale(1e-4, 1e-4, 1e-4);
          m.setPosition(c.x, c.y - c.h / 2 + L.h / 2 + 0.06, c.z);
          this.loads.setMatrixAt(i, m); this.loadShown[i] = show; dirty = true;
        }
        if (colKey !== this.loadColor[i]) { this.loads.setColorAt(i, new THREE.Color(colKey === 2 ? COL.loadRes : COL.load)); this.loadColor[i] = colKey; cdirty = true; }
      }
      if (dirty) this.loads.instanceMatrix.needsUpdate = true;
      if (cdirty && this.loads.instanceColor) this.loads.instanceColor.needsUpdate = true;
      // 크레인
      for (const fc of frame.cranes) {
        const v = this.cranes[fc.id]; if (!v) continue;
        v.g.position.set(fc.x, 0, 0);
        const cy = fc.y + v.c.carriageH / 2 + 0.1;
        v.carr.position.set(0, cy, 0);
        v.carr.material.color.set(fc.color);
        const ext = fc.forkExt * (lay.aisleW / 2 + lay.depth / 2);
        const fx = fc.forkDir.x * ext, fz = fc.forkDir.z * ext;
        v.fork.position.set(fx, fc.y + 0.12, fz);
        v.load.visible = fc.loadOnFork;
        if (fc.loadOnFork) v.load.position.set(fx, fc.y + 0.12 + L.h / 2 + 0.05, fz);
        this._setLabelText(v, 'lastText', v.lab2, fc.label, { px: 24, bg: 'rgba(255,255,255,0.85)', color: fc.state === 'idle' ? '#52514e' : '#111111' });
      }
      // 스테이션 대기열
      for (const fs of frame.stations) {
        const v = this.stations[fs.id]; if (!v) continue;
        const nShow = Math.min(12, fs.queue);
        if (nShow !== v.lastQ) {
          v.lastQ = nShow; v.q.count = nShow;
          const s = v.s; const dir = s.forkDir;
          for (let i = 0; i < nShow; i++) {
            const off = (i + 1) * Math.max(L.l * 0.75, 0.6) * (dir.x !== 0 ? 1 : 0) + (i + 1) * Math.max(L.w * 0.75, 0.5) * (dir.z !== 0 ? 1 : 0);
            m.makeTranslation(s.x + dir.x * off, s.y + L.h * 0.35 + 0.05, s.z + dir.z * off);
            v.q.setMatrixAt(i, m);
          }
          v.q.instanceMatrix.needsUpdate = true;
        }
        this._setLabelText(v, 'lastText', v.lab, `${v.s.name}  n=${fs.queue}${fs.backlog ? ' (정체 ' + fs.backlog + ')' : ''}`, { px: 26, bg: 'rgba(255,255,255,0.85)', color: fs.backlog ? '#d03b3b' : '#111111' });
      }
      this.render();
    }

    render() { this.renderer.render(this.scene, this.camera); }

    // ---------- 카메라 ----------
    setCamera(preset) {
      if (preset === 'iso') { this.sph.theta = -0.75; this.sph.phi = 1.05; }
      else if (preset === 'front') { this.sph.theta = Math.PI / 2; this.sph.phi = Math.PI / 2 - 0.08; }
      else if (preset === 'top') { this.sph.theta = -Math.PI / 2; this.sph.phi = 0.02; }
      else if (preset === 'side') { this.sph.theta = 0; this.sph.phi = Math.PI / 2 - 0.2; }
      this._applyCamera();
    }
    _applyCamera() {
      const s = this.sph;
      s.phi = Math.min(Math.PI / 2 - 0.01, Math.max(0.02, s.phi));
      s.r = Math.max(2, Math.min(3000, s.r));
      this.camera.position.set(this.target.x + s.r * Math.sin(s.phi) * Math.cos(s.theta), this.target.y + s.r * Math.cos(s.phi), this.target.z + s.r * Math.sin(s.phi) * Math.sin(s.theta));
      this.camera.lookAt(this.target);
      this.render();
    }
    _bindOrbit() {
      const el = this.renderer.domElement;
      let drag = null;
      el.addEventListener('contextmenu', e => e.preventDefault());
      el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey, moved: 0 }; el.setPointerCapture(e.pointerId); });
      el.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
        if (drag.btn === 2 || drag.shift) {
          const right = new THREE.Vector3(); const up = new THREE.Vector3();
          this.camera.getWorldDirection(right); right.cross(this.camera.up).normalize(); up.copy(this.camera.up);
          const k = this.sph.r * 0.0016;
          this.target.addScaledVector(right, -dx * k); this.target.addScaledVector(up, dy * k);
        } else { this.sph.theta += dx * 0.006; this.sph.phi -= dy * 0.006; }
        this._applyCamera();
      });
      const end = (e) => {
        if (drag && drag.moved < 4 && drag.btn === 0 && this.onPick) {
          const r = el.getBoundingClientRect();
          const idx = this.pick((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
          this.onPick(idx);
        }
        drag = null;
      };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', () => { drag = null; });
      el.addEventListener('wheel', e => { e.preventDefault(); this.sph.r *= Math.exp(e.deltaY * 0.0012); this._applyCamera(); }, { passive: false });
    }
    pick(nx, ny) {
      if (!this.pickMesh) return -1;
      this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
      const hits = this.raycaster.intersectObject(this.pickMesh, false);
      return hits.length ? hits[0].instanceId : -1;
    }
    _bindResize() {
      if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.container); }
      else window.addEventListener('resize', () => this.resize());
    }
    resize() {
      const w = Math.max(50, this.container.clientWidth), h = Math.max(50, this.container.clientHeight);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.render();
    }
    dispose() { if (this.ro) this.ro.disconnect(); disposeDeep(this.root); this.renderer.dispose(); }
  }

  function disposeDeep(o) {
    o.traverse && o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) { const ms = Array.isArray(n.material) ? n.material : [n.material]; for (const mm of ms) { if (mm.map) mm.map.dispose(); mm.dispose(); } } });
  }

  return { version: '0.1.0', View, makeLabel, COL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCView3D;

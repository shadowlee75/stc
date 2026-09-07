'use strict';
/* ============================================================
 * STC 시뮬레이터 — 난수 스트림 (rng.js)
 * mulberry32 + 목적별 독립 스트림. 시나리오 간 공통난수(CRN)를 위해
 * (seed, 스트림 이름) 조합으로 결정론적 시드를 만든다.
 * ============================================================ */
const STCRng = (() => {

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a 32bit — 스트림 이름을 시드 오프셋으로
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function makeStream(seed, name) {
    const next = mulberry32((seed >>> 0) ^ fnv1a(String(name)));
    const st = {
      name,
      random: next,                                   // [0,1)
      uniform: (lo, hi) => lo + (hi - lo) * next(),
      exp: (rate) => {                                 // 지수분포, rate [1/s]
        if (!(rate > 0)) throw new Error('exp: rate는 양수여야 합니다');
        let u = next(); if (u <= 0) u = 1e-12;
        return -Math.log(u) / rate;
      },
      int: (n) => Math.floor(next() * n),              // 0..n-1
      pick: (arr) => arr[Math.floor(next() * arr.length)],
    };
    return st;
  }

  // 목적별 스트림 묶음. 이름은 사용 시점에 지연 생성(스테이션 수가 가변이므로)
  function makeStreams(seed) {
    const cache = new Map();
    return {
      seed,
      get(name) {
        let s = cache.get(name);
        if (!s) { s = makeStream(seed, name); cache.set(name, s); }
        return s;
      },
    };
  }

  return { version: '0.1.0', mulberry32, fnv1a, makeStream, makeStreams };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = STCRng;

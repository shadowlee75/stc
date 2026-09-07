'use strict';
/* ============================================================
 * 빌드: template.html 마커에 모듈·vendor 인라인 → 단일 HTML
 *       → 배포물에서 모듈 역추출 → 동일 테스트 재실행 (배포 코드 = 테스트 코드)
 * 사용: node src/build.js [출력.html]
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SRC = __dirname;
const ROOT = path.resolve(SRC, '..');
const VENDOR = path.join(ROOT, 'vendor');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist', 'STC_ASRS_시뮬레이터_v0.1.html');
const VERSION = '0.1.0';

const ENGINE = ['kernel.js', 'rng.js', 'kin.js', 'stats.js', 'validate.js', 'presets.js', 'fem9851.js', 'engine.js', 'optimizer.js'];
const APP = ['scene.js', 'charts.js', 'runner.js', 'view3d.js', 'app.js'];
const TESTS = ['kernel.test.js', 'kin.test.js', 'stats.test.js', 'validate.test.js', 'fem9851.test.js', 'engine.test.js', 'optimizer.test.js', 'scene.test.js', 'runner.test.js'];
const EXTRA = ['fem9851.golden.json'];

function fail(msg) { console.error('빌드 실패: ' + msg); process.exit(1); }
function writeRetry(file, data) {
  try { fs.writeFileSync(file, data); }
  catch (e) { if (e.code === 'EBUSY' || e.code === 'EPERM') { console.warn('쓰기 재시도: ' + e.code); fs.writeFileSync(file, data); } else throw e; }
}

// 1) vendor 검증
const threePath = path.join(VENDOR, 'three.min.js');
if (!fs.existsSync(threePath)) fail('vendor/three.min.js 없음');
const three = fs.readFileSync(threePath, 'utf8');
const sha = crypto.createHash('sha256').update(three).digest('hex');
const shaFile = path.join(VENDOR, 'THREE_SHA256.txt');
if (fs.existsSync(shaFile)) {
  const want = fs.readFileSync(shaFile, 'utf8').trim().toLowerCase();
  if (want !== sha) fail(`three.min.js SHA-256 불일치\n  기록 ${want}\n  실제 ${sha}`);
} else { fs.writeFileSync(shaFile, sha + '\n'); console.log('THREE_SHA256.txt 기록'); }
if (/<\/script/i.test(three)) fail('three.min.js에 </script> 문자열이 있습니다');

// 2) 템플릿 + 모듈 인라인
let html = fs.readFileSync(path.join(SRC, 'template.html'), 'utf8');
function inline(marker, code, name) {
  const tag = '/*' + marker + '*/';
  if (!html.includes(tag)) fail('마커 없음: ' + tag);
  if (html.split(tag).length !== 2) fail('마커 중복: ' + tag);
  if (/<\/script/i.test(code)) fail(name + ' 안에 </script> 문자열이 있습니다');
  html = html.split(tag).join(code);
}
inline('__THREE__', three, 'three.min.js');
for (const m of [...ENGINE, ...APP]) {
  const file = path.join(SRC, m);
  if (!fs.existsSync(file)) fail('모듈 없음: ' + m);
  inline('__MODULE:' + m + '__', fs.readFileSync(file, 'utf8'), m);
}
const buildInfo = { version: VERSION, builtAt: new Date().toISOString(), three: 'r128 sha256:' + sha.slice(0, 12), modules: [...ENGINE, ...APP] };
inline('__BUILD__', 'window.STC_BUILD = ' + JSON.stringify(buildInfo) + ';', 'build info');
if (/\/\*__[A-Za-z_:.0-9]+__\*\//.test(html)) fail('치환되지 않은 마커: ' + html.match(/\/\*__[A-Za-z_:.0-9]+__\*\//)[0]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
writeRetry(OUT, html);
console.log(`빌드 완료: ${OUT} (${Math.round(html.length / 1024)} KB)`);
// 아티팩트 변형: 문서 래퍼 제거 + 다운로드 대체 플래그 (claude.ai Artifact는 자체 스켈레톤으로 감싼다)
const ART = OUT.replace(/\.html$/, '.artifact.html');
let art = html.replace(/^[\s\S]*?(<title>)/, '$1').replace(/<\/head>\s*<body>/, '').replace(/<\/body>\s*<\/html>\s*$/, '');
art = art.replace('window.STC_BUILD = ', 'window.STC_ARTIFACT = true; window.STC_BUILD = ');
if (!art.startsWith('<title>') || /<\/html>\s*$/.test(art)) fail('아티팩트 변형 래퍼 제거 실패');
writeRetry(ART, art);
console.log(`아티팩트 변형: ${ART} (${Math.round(art.length / 1024)} KB)`);

// 3) 역추출 → shipcheck 에서 테스트 재실행
const built = fs.readFileSync(OUT, 'utf8');
const re = /<script class="(engine|app)" data-module="([^"]+)">([\s\S]*?)<\/script>/g;
const found = {};
let m;
while ((m = re.exec(built)) !== null) found[m[2]] = m[3];
for (const mod of [...ENGINE, ...APP]) if (found[mod] === undefined) fail('배포물에서 모듈 역추출 실패: ' + mod);
const shipDir = path.join(SRC, 'shipcheck');
fs.mkdirSync(shipDir, { recursive: true });
for (const [mod, code] of Object.entries(found)) {
  const orig = fs.readFileSync(path.join(SRC, mod), 'utf8');
  if (code !== orig) fail('역추출 코드가 원본과 다릅니다: ' + mod);
  writeRetry(path.join(shipDir, mod), code);
}
for (const f of [...TESTS, ...EXTRA]) {
  const p = path.join(SRC, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(shipDir, f));
}
let allOk = true;
for (const t of TESTS) {
  if (!fs.existsSync(path.join(shipDir, t))) { console.log('[배포물 검증] ' + t + ' → (없음, 건너뜀)'); continue; }
  try {
    const out = execSync('node ' + t, { cwd: shipDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('[배포물 검증] ' + t + ' → ' + out.trim().split('\n').pop());
  } catch (e) {
    allOk = false;
    console.error('[배포물 검증 실패] ' + t + '\n' + (e.stdout || '') + (e.stderr || ''));
  }
}
if (!allOk) fail('배포물 테스트 실패');
console.log('배포물 역추출 검증 통과 · three r128 sha256 ' + sha.slice(0, 12));

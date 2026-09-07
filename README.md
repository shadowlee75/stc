# STC AS/RS 시뮬레이터 (stc-asrs-sim)

단일 통로 AS/RS 스태커크레인(STC)의 **이산사건 시뮬레이터**. FlexSim처럼 3D 애니메이션 · 통계 대시보드 · 실험기(시나리오 × 반복, 95% CI) · 최적화기(대수·조닝·디스패치 탐색)를 **의존성 없는 단일 HTML 한 파일**로 제공하고, 같은 물리 모델로 계산한 **FEM 9.851 준용 해석식**과 나란히 비교한다.

| 항목 | 내용 |
|---|---|
| 산출물 | `dist\STC_ASRS_시뮬레이터_v0.1.html` (≈810 KB, Three.js r128 내장, 오프라인 동작) |
| 기본 프리셋 | 차체 저장 설비 Rev.0 — `STC 물동량 계산서(FEM 9.851 준용)_Rev0.docx`(2026-08-26) 수치 |
| 설계 문서 | `..\STC_ASRS_시뮬레이터_구현계획_v1.0_20260907.md` |
| 커널 | `05. 통합 물동량계산\02_rgv_linear\src\kernel.js` v0.1.0 **원본 복사본** (아래 "커널 사본 규칙") |

---

## 빌드 · 테스트

```bash
cd "01. Stacker Crane/stc-asrs-sim"
node src/kernel.test.js && node src/kin.test.js && node src/stats.test.js && node src/validate.test.js
node src/fem9851.test.js && node src/engine.test.js && node src/optimizer.test.js && node src/scene.test.js && node src/runner.test.js
node src/build.js                      # dist/STC_ASRS_시뮬레이터_v0.1.html
node tools/serve.js 8765               # 미리보기 http://localhost:8765/ (file:// 로 열어도 동작)
```

`build.js`는 `template.html`의 마커에 vendor(three)와 모듈을 인라인한 뒤, **배포물에서 `data-module` 속성으로 모듈을 역추출해 같은 테스트를 다시 돌린다**(배포된 코드 = 테스트된 코드). three.min.js는 `vendor/THREE_SHA256.txt`와 대조한다. 테스트는 프레임워크 없이 `node x.test.js`.

FEM 9.851 표준식 골든값(`src/fem9851.golden.json`)은 `fem9851\stc_calculator.py`를 `uv run --no-project python`으로 1회 실행해 만든다(스크립트: 세션 scratchpad `gen_fem_golden.py`, 사양은 저속·지연 0의 "clean" 사다리꼴 — 이 조건에서 레거시 5구간식과 커널이 정확히 일치).

---

## 폴더

```
stc-asrs-sim\
├─ README.md · dist\ · vendor\(three.min.js r128, LICENSE, THREE_SHA256.txt) · tools\serve.js
└─ src\
   ── 엔진 블록 (DOM 無 → 그대로 Web Worker 소스) ──
   kernel.js      공통 운동학 커널 (원본 복사)      rng.js        mulberry32 + 목적별 스트림(공통난수)
   kin.js         위치-시간 posAt, 2축 체비셰프, 포크  stats.js      시간가중·히스토그램·t분위·CI·집계·CSV
   validate.js    스키마·존 비중첩·귀속·존별 물질수지   presets.js    차체 Rev.0 · 범용 20×10 · 검증용 3종
   fem9851.js     표준식 이식 + Rev.0 준용법          engine.js     DES 본체 (힙·계획 실행기·정책·통계)
   optimizer.js   설계공간 열거·판정·순위·Pareto (순수)
   ── 앱 블록 ──
   scene.js(렌더 모델) charts.js(Canvas 차트) runner.js(Worker 풀+폴백) view3d.js(Three.js) app.js(탭·UI)
   template.html  build.js  *.test.js  fem9851.golden.json
```

각 모듈은 IIFE 전역 1개(`MHKernel`, `STCKin`, `STCEngine` …)이며 의존은 `typeof X !== 'undefined' ? X : require('./x.js')`로 해결한다.

---

## 모델

- **시간**: 순수 이산사건(이진힙 `(t, seq)`). 이벤트 `ARRIVAL · CRANE_STEP · SAMPLE · WARMUP_END · END`. 애니메이션은 같은 엔진을 `advanceTo(t)`로 전진시키고 크레인 위치를 운동학 프로파일로 보간한다(FlexSim 방식).
- **운동학**: 축별 사다리꼴/삼각(가·감속 분리, 저속 접근 `creepDist/creepV`, 고정 지연 `tDelay`). 주행·승강 동시 = `max(tx, ty) + tPos`(커널 `chebyshev`). **이동시간은 커널만 호출**(PRD G1). 해석식(`fem9851.js`)도 같은 `STCKin.axisTime`을 써서 "해석식 vs 시뮬" 차이가 순수 DES 효과만 반영한다.
- **이재**: `2 × 신장(stroke) + 승강·안착(tSeat)` 또는 지정값 `tOverride`(Rev.0 t_ü = 8.0 s/회).
- **셀**: single deep, `empty | reservedIn | occupied | reservedOut`. 예약은 디스패치 시점(대기 중 자원 점유 없음 → 데드락 없음).
- **스테이션**: 입고는 도착(`takt` ± jitter% / `poisson` / `csv`)마다 작업 생성, 용량 초과분은 백로그 → **라인 정지시간** KPI. 출고는 호출마다 작업 생성, 재고 ≥ `minStock`일 때만 디스패치. 반출 대상은 `any`(임의 재고, 사용자 확정) 또는 `fifo`.
- **존**: 크레인 1대 = 사각 존 1개. 겹침 불가(레일 충돌 모델 없음), 같은 레일 존은 `bodyWidth` 간격 검사, x 겹침·y 분리 존은 "별도 레일" 경고. 스테이션·셀은 위치로 귀속. **출고 스테이션이 없는 존은 반출 불가 → 검증 오류**(현행 배치의 좌/우·상/하 분할이 모두 여기에 걸린다 — 물리적 한계이며 고장이 아님).
- **정책**: `mode SC-return(↔tm1) | SC-stay | DC(↔tm2)` · `pairing fifo | nearest` · `priority oldest-first | storage-first | retrieval-first | alternate (+agingLimit_s)` · `storageRule random-empty | closest-open` · `retrievalCell random | fifo | nearest`.
- **대안 표현**: `parallelAisles k`(동일 배치 통로 k개, 수요 ÷ k — 계산서 "3대 = 통로 3개"의 동등 비교, 사용자 확정) · 스테이션 변형 `addOutRight`(반대편 출고 추가, 수요는 존별 입고 비중으로 재배분) · `outLift`(출고 스테이션 y→0).
- **통계**: 상태별 시간가중(`idle · moveEmpty · moveLoaded · fork · blocked · starved`), 대기열 시간가중, 대기·사이클 고정빈 히스토그램, 시계열 빈. `WARMUP_END`에서 모든 누적기 리셋. `queueTrend`(후반¼/전반¼), `saturated` 플래그.
- **결정성**: rep seed = `seedBase + rep`, 목적별 RNG 스트림(`arr:<station>`, `cell`, `init`). 같은 seed → 결과 JSON 동일. 엔진은 `Math.random`을 쓰지 않는다(테스트가 stub으로 감시).
- **범위 밖**: ABC 클래스 저장, Double Deep 재배치(`depth>1` 경고), 크레인 고장·정비(η는 해석식 환산에만), 통로 간 이송, 레일 공유 크레인 간 충돌.

### KPI

| 지표 | 정의 |
|---|---|
| 달성률 | 통계 구간 완료 ÷ 생성 |
| busy | 공차·적재 주행 + 이재 비율. η 반영 이용률 = busy ÷ η |
| 대기 | 입고: 도착 → 픽업 / 출고: 호출 → 적치 |
| 사이클 | 디스패치 → 계획 완료(SC-return은 복귀 포함) |
| 라인 정지 | 입고 대기 수 > 용량인 시간 합 |
| 판정 | 달성률 ≥ `doneRatioMin` ∧ max busy ≤ `rhoMax` ∧ queueTrend < 1.5 ∧ 평균 대기열 ≤ `maxQueue` ∧ unservable·블로킹 없음 |

---

## 검증 결과 (2026-09-07, `engine.test.js`·`fem9851.test.js`)

| 항목 | 시뮬 | 해석식/기준 | Δ | 판정 |
|---|---|---|---|---|
| 대형 랙 50×15, SC-return 평균 vs FEM tm1E | 66.75 s | 64.67 s | +3.2% | PRD 5% ✓ |
| 대형 랙 DC 평균 vs FEM tm2 (E=A) | 97.36 s | 99.33 s | −2.0% | ✓ |
| Bozer & White b=1 `E(SC)/T = 4/3` | 134.75 s | 133.33 s (열거 133.330) | +1.1% | 2% ✓ |
| Bozer & White b=0.5 `1 + b²/3` | 107.21 s | 108.33 s | −1.0% | ✓ |
| 차체 Rev.0 1대 DC 평균 | 86.2 s | 87.7 s (계산서 가중평균) | −1.7% | ✓ |
| 차체 Rev.0 1대 달성률 | 45.0% | 39.7% ÷ η 0.9 = 44.1% | — | 정합 |
| 차체 Rev.0 계산서 표 재현 (`STCFem.rev0`) | DC-A 84.9 / DC-B 95.5 / DC-C 95.5 s, 87.7 s, D 8,160 s/h, U 252%, 36.9쌍/h, 39.7% | 계산서 | — | 일치 |
| FEM 9.851 표준식 이식 | Python 골든 11케이스 | 1e-6 | — | 일치 |
| 결정성 · 보존식 · 존 불변식 · 1 s 스텝 = 일괄 · `Math.random` 미사용 | — | — | — | 통과 |

브라우저(Chrome, http://localhost 미리보기): 콘솔 오류 0, Web Worker × (코어−1) 감지, 8 h 런 ≈ 50 ms, 실험기 2 설계 × 3 rep 0.1 s, 최적화기 20런 0.1 s. file:// 직접 열기는 세션의 Browser pane 접근 제한으로 미확인 — Blob Worker가 막히면 메인스레드 폴백으로 동작(노드 테스트로 검증).

---

## 프리셋 "차체 저장 설비 Rev.0" — 확정값과 가정

| 확정(계산서) | 값 |
|---|---|
| 베이 중심 x | 6.0 / 11.65 / 17.3 / 22.95 / 28.6 m (전장 34.6 = 6,000 + 5,650×4 + 6,000) |
| 랙 벽면 | x0 3.175 m, L 28.25 m, H 12.67 m (좌측 체인 1,150+2,770+2,850+2,950+2,950 — 확인 요) |
| E/A | E_L0 (1.5, 0) 68 · A_L8 (1.5, 8) 92 · E_R8 (33.1, 8) 22 · E_R0 (33.1, 0) 3 JPH |
| 속도 | 주행 175 m/min·0.4 · 승강 50·0.5 · 포크 60·0.6 m/s² |
| 이재·부대 | t_ü 8.0 s/회(3.1+3.1+1.8), 정지·전환 1.0 s/개소, η 0.9 |

| 가정(미확정, 계산서 "확인 필요 사항") | 프리셋 값 |
|---|---|
| 랙 편측/양측 (No.4) | 편측 30셀 (계산서 용량 기준) |
| 레벨 좌표 (No.2) | 0 / 1.15 / 3.92 / 6.77 / 9.72 / 12.67 m |
| 초기 충전률 | 0.6 (입출 수지 +1 JPH → 8 h 내 만재 회피) |
| 도착 패턴 | 입고·출고 takt ±10%, Repair poisson, 출고 minStock 1 |

---

## 사용

1. **① 모델** — 프리셋 선택 / JSON 열기·저장. 폼·표 편집은 JSON(정본)에 즉시 반영, 직접 편집은 "JSON 적용". 검증 메시지와 존별 물질수지 표를 확인.
2. **② 3D** — 재생·배속(1~1000×)·+1 min·카메라(ISO/정면/평면/측면), 좌드래그 회전·우드래그 이동·휠 줌, 셀 클릭 정보. 브라우저가 탭을 숨기면 재생이 멈춘다(rAF 정지).
3. **③ 통계** — 단일 실행(seed = seedBase). KPI·판정·상태 누적바·도넛·물동량/대기열/재고/가동률 시계열·대기·사이클 히스토그램·표.
4. **④ 실험기** — 설계변수 체크 → 행렬 생성 → 실행(Worker 풀, 실패 시 메인스레드 폴백). 평균 ± 95% CI 표·점-수염 차트·CSV/JSON. 행의 "3D"로 재생.
5. **⑤ 최적화기** — 2단계 스크리닝(R₁ → 상위 k × R₂). 추천 카드·순위표·"하위 N 실패 사유"·Pareto.
6. **⑥ 해석식** — Rev.0 준용식 표(스테이션별 tm1, DC 구성, U, N, 처리능력) + 단일 실행 후 시뮬 대조.

---

## 커널 사본 규칙

`src/kernel.js`는 `05. 통합 물동량계산\02_rgv_linear\src\kernel.js`(v0.1.0)의 **5번째 사본**이다. `05…\tools\kernel_sync_check.js`의 대상에는 넣지 않았다(사용자 결정). 커널을 고치면 **이 폴더에도 수동으로 복사**하고 `node src/kernel.test.js`·`node src/kin.test.js`·`node src/engine.test.js`를 재실행한다.

## 알려진 한계

- 소형 랙(5×6)에서는 FEM P1/P2(연속 균일 가정)와 격자 이산화 차이로 사이클타임이 5~8% 다를 수 있다. 5% 기준은 대형 랙 프리셋으로 판정한다.
- 포화 상태의 대기시간 히스토그램은 overflow 빈(≥ maxSec)에 몰린다 — `hist.wait.maxSec`를 늘리면 된다.
- `arrivalsCsv`는 `t_sec,stationId` 형식만 지원(적재물 id 미지원).
- three.min.js는 UMD r128 고정(`setColorAt` 사용). 업그레이드 시 `InstancedMesh.setColorAt`·`outputEncoding` API 변경을 확인할 것.

## 공유 링크

- claude.ai Artifact (비공개, 2026-09-07 v0.1): https://claude.ai/code/artifact/bdbcef4c-da0c-47b7-83df-5837b728ce83 — `dist\*.artifact.html` 변형(래퍼 제거, 파일 저장 대신 복사용 표시). 재발행: `node src/build.js` 후 같은 경로를 다시 발행.

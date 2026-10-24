// 기본 운동 목록
// met: 세트 수행 중 동작 강도 (Compendium of Physical Activities를 출발점으로, 아래 연구 값에 맞춰 동작별 보정)
// rom: 1회 반복 시 부하가 이동하는 유효 수직 거리(m) — 45° 레그프레스는 수직 성분, 케이블 운동은 마찰·평형추 감안
// bwFactor: 부하에 더해지는 체중 비율 (맨몸 운동·하체 운동)
// refRatio: 미리보기용 기준 중량 (체중 대비 비율, 기록이 없을 때 사용)
// src: 보정 근거
//
// 보정 기준 (체중 75kg, 10회 수행 중 분당 소모량)
// - 스쿼트 11~18 kcal/분 (1RM 40~70%), 벤치프레스 8~16 kcal/분 — Robergs et al. 2007, J Strength Cond Res
// - 하프 스쿼트·레그 익스텐션이 가장 높고, 바이셉스 컬·랫풀다운은 약 3~4 kcal/분 — Reis et al. 2017, PLOS ONE
const CATEGORIES = ['가슴', '등', '하체', '어깨', '팔', '코어', '유산소', '기타'];

const SRC_R07 = 'Robergs 2007';
const SRC_R17 = 'Reis 2017';
const est = base => `추정: ${base} 기준`;

const DEFAULT_EXERCISES = [
  // 가슴
  { name: '벤치프레스', cat: '가슴', type: 'strength', met: 5.0, rom: 0.40, bwFactor: 0, refRatio: 0.8, src: `연구: ${SRC_R07}, ${SRC_R17}` },
  { name: '인클라인 벤치프레스', cat: '가슴', type: 'strength', met: 5.0, rom: 0.40, bwFactor: 0, refRatio: 0.65, src: `연구: ${SRC_R17}` },
  { name: '덤벨 프레스', cat: '가슴', type: 'strength', met: 5.0, rom: 0.40, bwFactor: 0, refRatio: 0.6, src: est('벤치프레스') },
  { name: '덤벨 플라이', cat: '가슴', type: 'strength', met: 3.5, rom: 0.35, bwFactor: 0, refRatio: 0.3, src: est('고립운동') },
  { name: '체스트 프레스 머신', cat: '가슴', type: 'strength', met: 4.0, rom: 0.35, bwFactor: 0, refRatio: 0.6, src: est('벤치프레스') },
  { name: '푸시업', cat: '가슴', type: 'strength', met: 3.8, rom: 0.30, bwFactor: 0.64, refRatio: 0, src: 'Compendium 맨몸운동' },
  { name: '딥스', cat: '가슴', type: 'strength', met: 5.0, rom: 0.40, bwFactor: 0.95, refRatio: 0, src: est('벤치프레스') },
  // 등
  { name: '데드리프트', cat: '등', type: 'strength', met: 6.0, rom: 0.55, bwFactor: 0.4, refRatio: 1.2, src: 'Compendium 02052 · 스쿼트 기준' },
  { name: '바벨 로우', cat: '등', type: 'strength', met: 4.5, rom: 0.40, bwFactor: 0, refRatio: 0.7, src: est('벤치프레스') },
  { name: '덤벨 로우', cat: '등', type: 'strength', met: 4.0, rom: 0.40, bwFactor: 0, refRatio: 0.35, src: est('바벨 로우') },
  { name: '랫풀다운', cat: '등', type: 'strength', met: 2.0, rom: 0.30, bwFactor: 0, refRatio: 0.6, src: `연구: ${SRC_R17}` },
  { name: '시티드 케이블 로우', cat: '등', type: 'strength', met: 2.5, rom: 0.30, bwFactor: 0, refRatio: 0.6, src: est('랫풀다운') },
  { name: '풀업 (턱걸이)', cat: '등', type: 'strength', met: 4.0, rom: 0.50, bwFactor: 1.0, refRatio: 0, src: est('랫풀다운 + 체중') },
  // 하체
  { name: '바벨 스쿼트', cat: '하체', type: 'strength', met: 5.0, rom: 0.60, bwFactor: 0.8, refRatio: 1.0, src: `연구: ${SRC_R07}, ${SRC_R17}` },
  { name: '레그 프레스', cat: '하체', type: 'strength', met: 5.0, rom: 0.35, bwFactor: 0, refRatio: 1.8, src: `연구: ${SRC_R17} (45° 레그프레스)` },
  { name: '런지', cat: '하체', type: 'strength', met: 4.5, rom: 0.45, bwFactor: 0.8, refRatio: 0.3, src: est('스쿼트') },
  { name: '루마니안 데드리프트', cat: '하체', type: 'strength', met: 5.0, rom: 0.45, bwFactor: 0.4, refRatio: 0.8, src: est('데드리프트') },
  { name: '레그 익스텐션', cat: '하체', type: 'strength', met: 5.0, rom: 0.40, bwFactor: 0, refRatio: 0.5, src: `연구: ${SRC_R17}` },
  { name: '레그 컬', cat: '하체', type: 'strength', met: 4.0, rom: 0.30, bwFactor: 0, refRatio: 0.4, src: est('레그 익스텐션') },
  { name: '힙 쓰러스트', cat: '하체', type: 'strength', met: 5.0, rom: 0.30, bwFactor: 0.5, refRatio: 1.0, src: est('스쿼트') },
  { name: '카프 레이즈', cat: '하체', type: 'strength', met: 3.5, rom: 0.08, bwFactor: 1.0, refRatio: 0.5, src: est('고립운동') },
  // 어깨
  { name: '오버헤드 프레스', cat: '어깨', type: 'strength', met: 5.0, rom: 0.50, bwFactor: 0, refRatio: 0.5, src: est('벤치프레스') },
  { name: '덤벨 숄더 프레스', cat: '어깨', type: 'strength', met: 4.5, rom: 0.45, bwFactor: 0, refRatio: 0.4, src: est('오버헤드 프레스') },
  { name: '사이드 레터럴 레이즈', cat: '어깨', type: 'strength', met: 3.0, rom: 0.50, bwFactor: 0, refRatio: 0.15, src: est('바이셉스 컬') },
  { name: '페이스 풀', cat: '어깨', type: 'strength', met: 2.5, rom: 0.30, bwFactor: 0, refRatio: 0.25, src: est('케이블 운동') },
  // 팔
  { name: '바벨 컬', cat: '팔', type: 'strength', met: 3.0, rom: 0.45, bwFactor: 0, refRatio: 0.35, src: `연구: ${SRC_R17}` },
  { name: '덤벨 컬', cat: '팔', type: 'strength', met: 3.0, rom: 0.45, bwFactor: 0, refRatio: 0.25, src: est('바벨 컬') },
  { name: '해머 컬', cat: '팔', type: 'strength', met: 3.0, rom: 0.45, bwFactor: 0, refRatio: 0.25, src: est('바벨 컬') },
  { name: '트라이셉스 푸시다운', cat: '팔', type: 'strength', met: 2.5, rom: 0.30, bwFactor: 0, refRatio: 0.35, src: est('바벨 컬·케이블 운동') },
  // 코어
  { name: '크런치', cat: '코어', type: 'strength', met: 3.8, rom: 0.15, bwFactor: 0.3, refRatio: 0, src: 'Compendium 맨몸운동' },
  { name: '행잉 레그 레이즈', cat: '코어', type: 'strength', met: 4.0, rom: 0.50, bwFactor: 0.35, refRatio: 0, src: 'Compendium 맨몸운동' },
  { name: '플랭크', cat: '코어', type: 'time', met: 3.8, src: 'Compendium 맨몸운동' },
  // 유산소
  { name: '러닝 (약 10km/h)', cat: '유산소', type: 'time', met: 9.8, src: 'Compendium' },
  { name: '빠르게 걷기', cat: '유산소', type: 'time', met: 4.3, src: 'Compendium' },
  { name: '실내 자전거 (보통)', cat: '유산소', type: 'time', met: 6.8, src: 'Compendium' },
  { name: '로잉 머신 (보통)', cat: '유산소', type: 'time', met: 7.0, src: 'Compendium' },
  { name: '천국의 계단 (스텝밀)', cat: '유산소', type: 'time', met: 9.0, src: 'Compendium' },
  { name: '일립티컬', cat: '유산소', type: 'time', met: 5.0, src: 'Compendium' },
  { name: '줄넘기', cat: '유산소', type: 'time', met: 11.8, src: 'Compendium' },
  { name: '수영 (자유형 보통)', cat: '유산소', type: 'time', met: 5.8, src: 'Compendium' },
];

// 보정 버전: 값이 바뀌면 올려서 기존 사용자 목록·기록에 반영
const CALIB_VERSION = 2;

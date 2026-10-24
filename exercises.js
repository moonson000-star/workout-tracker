// 기본 운동 목록 — 홈트레이닝 (덤벨 2개 최대 24kg + 케틀벨 12kg + 맨몸)
//
// 입력 규칙
// - kg: 덤벨·케틀벨 "1개" 무게. 덤벨 2개를 동시에 드는 운동(dbs: 2)은 앱이 ×2로 계산
// - 회: 한쪽씩 하는 운동(sides: 2)은 "한쪽" 횟수. 앱이 양쪽(×2)으로 계산
//
// 필드
// met: 세트 수행 중 동작 강도 (Compendium을 출발점으로 연구 값에 맞춰 보정)
// rom: 1회 반복 시 부하가 이동하는 유효 수직 거리(m, 키 175cm 기준)
// bwFactor: 부하에 더해지는 체중 비율 (몸이 같이 움직이는 운동)
// dbs: 동시에 드는 기구 개수, sides: 한쪽씩 하면 2
// refKg: 미리보기용 기준 무게 (기구 1개, 기록이 없을 때 사용)
// src: 보정 근거
//
// 보정 기준 (체중 75kg, 수행 중 분당 소모량)
// - 스쿼트 11~18 kcal/분, 벤치프레스 8~16 kcal/분 (1RM 40~70%) — Robergs et al. 2007
// - 하체 운동이 가장 높고, 바이셉스 컬은 약 3 kcal/분 — Reis et al. 2017, PLOS ONE
// - 서킷 트레이닝: 고강도 8.0 MET, 중강도 4.3 MET — Compendium of Physical Activities
const CATEGORIES = ['전신', '가슴', '등', '하체', '어깨', '팔', '코어', '유산소', '기타'];

const SRC_R07 = 'Robergs 2007';
const SRC_R17 = 'Reis 2017';
const est = base => `추정: ${base} 기준`;

// 몸통이 같이 움직이는 복합 동작은 이동거리(rom)를 덤벨 기준으로 잡고,
// 몸의 이동은 bwFactor = (체중 반영 비율 × 몸 이동거리) ÷ 덤벨 이동거리 로 환산
const DEFAULT_EXERCISES = [
  // 전신 (복합·폭발적 동작)
  { name: '덤벨 쓰러스터', cat: '전신', type: 'strength', met: 6.0, rom: 1.00, bwFactor: 0.45, dbs: 2, sides: 1, refKg: 12, src: est('스쿼트 + 숄더 프레스') },
  { name: '데빌 프레스', cat: '전신', type: 'strength', met: 8.0, rom: 1.80, bwFactor: 0.45, dbs: 2, sides: 1, refKg: 12, src: est('버피 + 덤벨 스내치') },
  { name: '덤벨 데드로우 (데드리프트+로우)', cat: '전신', type: 'strength', met: 5.5, rom: 0.90, bwFactor: 0.22, dbs: 2, sides: 1, refKg: 12, src: est('데드리프트 + 로우') },
  { name: '덤벨 클린 앤 프레스', cat: '전신', type: 'strength', met: 6.5, rom: 1.50, bwFactor: 0.3, dbs: 2, sides: 1, refKg: 12, src: est('데드리프트 + 숄더 프레스') },
  { name: '덤벨 스내치 (한 손)', cat: '전신', type: 'strength', met: 7.0, rom: 1.80, bwFactor: 0.2, dbs: 1, sides: 2, refKg: 12, src: est('데드리프트 + 숄더 프레스') },
  { name: '케틀벨 스윙', cat: '전신', type: 'strength', met: 8.0, rom: 0.70, bwFactor: 0.3, dbs: 1, sides: 1, refKg: 12, src: est('고강도 맨몸운동 (Compendium)') },
  { name: '케틀벨 고블릿 스쿼트', cat: '전신', type: 'strength', met: 5.0, rom: 0.55, bwFactor: 0.8, dbs: 1, sides: 1, refKg: 12, src: `연구: ${SRC_R07}, ${SRC_R17} (스쿼트)` },
  { name: '버피', cat: '전신', type: 'strength', met: 8.0, rom: 0.80, bwFactor: 1.0, dbs: 1, sides: 1, refKg: 0, src: 'Compendium 고강도 맨몸운동' },
  // 가슴
  { name: '덤벨 플로어 프레스', cat: '가슴', type: 'strength', met: 4.5, rom: 0.30, bwFactor: 0, dbs: 2, sides: 1, refKg: 16, src: est('벤치프레스 (바닥이라 이동거리 짧음)') },
  { name: '덤벨 벤치 프레스', cat: '가슴', type: 'strength', met: 5.0, rom: 0.40, bwFactor: 0, dbs: 2, sides: 1, refKg: 16, src: `연구: ${SRC_R07}, ${SRC_R17} (벤치프레스)` },
  { name: '덤벨 플라이', cat: '가슴', type: 'strength', met: 3.5, rom: 0.35, bwFactor: 0, dbs: 2, sides: 1, refKg: 8, src: est('고립운동') },
  { name: '푸시업', cat: '가슴', type: 'strength', met: 3.8, rom: 0.30, bwFactor: 0.64, dbs: 1, sides: 1, refKg: 0, src: 'Compendium 맨몸운동' },
  // 등
  { name: '덤벨 벤트오버 로우 (양손)', cat: '등', type: 'strength', met: 4.5, rom: 0.40, bwFactor: 0, dbs: 2, sides: 1, refKg: 14, src: est('바벨 로우') },
  { name: '원암 덤벨 로우', cat: '등', type: 'strength', met: 4.0, rom: 0.40, bwFactor: 0, dbs: 1, sides: 2, refKg: 20, src: est('바벨 로우') },
  { name: '덤벨 데드리프트', cat: '등', type: 'strength', met: 5.5, rom: 0.50, bwFactor: 0.4, dbs: 2, sides: 1, refKg: 20, src: est('데드리프트 (Compendium 02052)') },
  { name: '덤벨 풀오버', cat: '등', type: 'strength', met: 3.5, rom: 0.50, bwFactor: 0, dbs: 1, sides: 1, refKg: 14, src: est('고립운동') },
  // 하체
  { name: '덤벨 스쿼트 (양손)', cat: '하체', type: 'strength', met: 5.0, rom: 0.55, bwFactor: 0.8, dbs: 2, sides: 1, refKg: 16, src: `연구: ${SRC_R07}, ${SRC_R17} (스쿼트)` },
  { name: '덤벨 고블릿 스쿼트', cat: '하체', type: 'strength', met: 5.0, rom: 0.55, bwFactor: 0.8, dbs: 1, sides: 1, refKg: 20, src: `연구: ${SRC_R07}, ${SRC_R17} (스쿼트)` },
  { name: '덤벨 런지', cat: '하체', type: 'strength', met: 4.5, rom: 0.45, bwFactor: 0.8, dbs: 2, sides: 2, refKg: 10, src: est('스쿼트') },
  { name: '불가리안 스플릿 스쿼트', cat: '하체', type: 'strength', met: 5.0, rom: 0.45, bwFactor: 0.8, dbs: 2, sides: 2, refKg: 10, src: est('스쿼트') },
  { name: '덤벨 루마니안 데드리프트', cat: '하체', type: 'strength', met: 5.0, rom: 0.45, bwFactor: 0.4, dbs: 2, sides: 1, refKg: 16, src: est('데드리프트') },
  { name: '덤벨 글루트 브릿지', cat: '하체', type: 'strength', met: 4.0, rom: 0.25, bwFactor: 0.5, dbs: 1, sides: 1, refKg: 20, src: est('힙 쓰러스트') },
  { name: '덤벨 카프 레이즈', cat: '하체', type: 'strength', met: 3.5, rom: 0.08, bwFactor: 1.0, dbs: 2, sides: 1, refKg: 16, src: est('고립운동') },
  // 어깨
  { name: '덤벨 숄더 프레스', cat: '어깨', type: 'strength', met: 4.5, rom: 0.45, bwFactor: 0, dbs: 2, sides: 1, refKg: 12, src: est('오버헤드 프레스') },
  { name: '덤벨 사이드 레터럴 레이즈', cat: '어깨', type: 'strength', met: 3.0, rom: 0.50, bwFactor: 0, dbs: 2, sides: 1, refKg: 4, src: est('바이셉스 컬') },
  { name: '덤벨 리어 델트 플라이', cat: '어깨', type: 'strength', met: 3.0, rom: 0.40, bwFactor: 0, dbs: 2, sides: 1, refKg: 4, src: est('바이셉스 컬') },
  { name: '케틀벨 프레스 (한 손)', cat: '어깨', type: 'strength', met: 4.0, rom: 0.45, bwFactor: 0, dbs: 1, sides: 2, refKg: 12, src: est('오버헤드 프레스') },
  // 팔
  { name: '덤벨 컬', cat: '팔', type: 'strength', met: 3.0, rom: 0.45, bwFactor: 0, dbs: 2, sides: 1, refKg: 10, src: `연구: ${SRC_R17} (바이셉스 컬)` },
  { name: '덤벨 해머 컬', cat: '팔', type: 'strength', met: 3.0, rom: 0.45, bwFactor: 0, dbs: 2, sides: 1, refKg: 10, src: est('바이셉스 컬') },
  { name: '덤벨 오버헤드 트라이셉스 익스텐션', cat: '팔', type: 'strength', met: 2.5, rom: 0.40, bwFactor: 0, dbs: 1, sides: 1, refKg: 14, src: est('바이셉스 컬') },
  { name: '덤벨 킥백', cat: '팔', type: 'strength', met: 2.5, rom: 0.30, bwFactor: 0, dbs: 1, sides: 2, refKg: 6, src: est('바이셉스 컬') },
  // 코어
  { name: '크런치', cat: '코어', type: 'strength', met: 3.8, rom: 0.15, bwFactor: 0.3, dbs: 1, sides: 1, refKg: 0, src: 'Compendium 맨몸운동' },
  { name: '레그 레이즈', cat: '코어', type: 'strength', met: 3.8, rom: 0.40, bwFactor: 0.35, dbs: 1, sides: 1, refKg: 0, src: 'Compendium 맨몸운동' },
  { name: '덤벨 러시안 트위스트', cat: '코어', type: 'strength', met: 3.8, rom: 0.20, bwFactor: 0.2, dbs: 1, sides: 1, refKg: 8, src: 'Compendium 맨몸운동' },
  { name: '플랭크', cat: '코어', type: 'time', met: 3.8, src: 'Compendium 맨몸운동' },
  // 유산소
  { name: '러닝 (약 10km/h)', cat: '유산소', type: 'time', met: 9.8, src: 'Compendium' },
  { name: '빠르게 걷기', cat: '유산소', type: 'time', met: 4.3, src: 'Compendium' },
  { name: '줄넘기', cat: '유산소', type: 'time', met: 11.8, src: 'Compendium' },
  { name: '실내 자전거 (보통)', cat: '유산소', type: 'time', met: 6.8, src: 'Compendium' },
];

// 이전 버전(헬스장 기준) 기본 운동 이름 — 홈트 목록으로 바꿀 때 직접 추가한 운동과 구분하는 데 사용
const LEGACY_DEFAULT_NAMES = [
  '벤치프레스', '인클라인 벤치프레스', '덤벨 프레스', '덤벨 플라이', '체스트 프레스 머신', '푸시업', '딥스',
  '데드리프트', '바벨 로우', '덤벨 로우', '랫풀다운', '시티드 케이블 로우', '풀업 (턱걸이)',
  '바벨 스쿼트', '레그 프레스', '런지', '루마니안 데드리프트', '레그 익스텐션', '레그 컬', '힙 쓰러스트', '카프 레이즈',
  '오버헤드 프레스', '덤벨 숄더 프레스', '사이드 레터럴 레이즈', '페이스 풀',
  '바벨 컬', '덤벨 컬', '해머 컬', '트라이셉스 푸시다운',
  '크런치', '행잉 레그 레이즈', '플랭크',
  '러닝 (약 10km/h)', '빠르게 걷기', '실내 자전거 (보통)', '로잉 머신 (보통)', '천국의 계단 (스텝밀)', '일립티컬', '줄넘기', '수영 (자유형 보통)',
];

// 서킷 강도 (Compendium: circuit training)
const CIRCUIT_INTENSITIES = [
  { met: 8.0, label: '고강도 · 휴식 거의 없음 (MET 8.0)' },
  { met: 4.3, label: '중강도 · 동작 사이 짧은 휴식 (MET 4.3)' },
];

// 보정 버전: 값이 바뀌면 올려서 기존 사용자 목록·기록에 반영
// 2: 동작별 연구 값 보정, 3: 홈트레이닝 목록으로 교체
const CALIB_VERSION = 3;

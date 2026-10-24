// 칼로리 추정 로직 (브라우저 전역 + Node 테스트 겸용)
const REST_MET = 1.5;
const GRAVITY = 9.81;
const KCAL_PER_JOULE = 1 / 4184;
const REF_HEIGHT_CM = 175; // 운동별 ROM 기본값의 기준 키

// 한 동작 1회(set의 reps 전체)의 역학적 일(J)
// kg은 기구 1개 무게, dbs는 동시에 드는 기구 수, sides가 2면 reps는 한쪽 기준
function workJoules(move, kg, reps, bw, romScale) {
  const dbs = Number(move.dbs) || 1, sides = Number(move.sides) || 1;
  const load = (Number(kg) || 0) * dbs + bw * (move.bwFactor || 0);
  return load * GRAVITY * (move.rom || 0) * romScale * Number(reps) * sides;
}

const liftedVolume = (move, kg, reps) =>
  (Number(kg) || 0) * (Number(move.dbs) || 1) * Number(reps) * (Number(move.sides) || 1);

// entry: { type: 'strength', met, rom, bwFactor, dbs, sides, sets:[{kg,reps}] }
//      | { type: 'time', met, minutes }
//      | { type: 'circuit', met, minutes, rounds, moves:[{rom, bwFactor, dbs, sides, kg, reps}] }
// s: { bodyWeight, heightCm, secPerRep, restSec, volumeCorrection, efficiencyPct }
function estimateEntry(entry, s) {
  const bw = Number(s.bodyWeight) || 70;
  const efficiency = (Number(s.efficiencyPct) || 25) / 100;
  // 이동거리는 팔·다리 길이에 비례하므로 키로 보정 (키 미입력 시 기준값 그대로)
  const romScale = Number(s.heightCm) > 0 ? Number(s.heightCm) / REF_HEIGHT_CM : 1;

  if (entry.type === 'time') {
    const minutes = Number(entry.minutes) || 0;
    const base = entry.met * bw * minutes / 60;
    return { base, bonus: 0, total: base, minutes, volume: 0, sets: 0 };
  }

  // 서킷: 쉬지 않고 이어서 하므로 실제 운동 시간 × 서킷 MET + 라운드 전체의 중량 보정
  if (entry.type === 'circuit') {
    const minutes = Number(entry.minutes) || 0;
    const rounds = Number(entry.rounds) || 0;
    const moves = (entry.moves || []).filter(m => Number(m.reps) > 0);
    const base = (Number(entry.met) || 8) * bw * minutes / 60;
    const joules = rounds * moves.reduce((a, m) => a + workJoules(m, m.kg, m.reps, bw, romScale), 0);
    const bonus = s.volumeCorrection ? joules / efficiency * KCAL_PER_JOULE : 0;
    const volume = rounds * moves.reduce((a, m) => a + liftedVolume(m, m.kg, m.reps), 0);
    return { base, bonus, total: base + bonus, minutes, volume, sets: rounds };
  }

  const sets = (entry.sets || []).filter(x => Number(x.reps) > 0);
  const sides = Number(entry.sides) || 1;
  const totalReps = sets.reduce((a, x) => a + Number(x.reps) * sides, 0);
  const activeSec = totalReps * s.secPerRep;
  const restSec = sets.length * s.restSec;
  const base = (entry.met * bw * activeSec + REST_MET * bw * restSec) / 3600;

  let bonus = 0;
  if (s.volumeCorrection) {
    const joules = sets.reduce((a, x) => a + workJoules(entry, x.kg, x.reps, bw, romScale), 0);
    bonus = joules / efficiency * KCAL_PER_JOULE;
  }

  const volume = sets.reduce((a, x) => a + liftedVolume(entry, x.kg, x.reps), 0);
  return {
    base, bonus, total: base + bonus,
    minutes: (activeSec + restSec) / 60,
    volume, sets: sets.length,
  };
}

// 기초대사량 (Mifflin-St Jeor, kcal/일). 체중·키·나이·성별이 모두 있어야 계산
function estimateBMR(s) {
  const w = Number(s.bodyWeight), h = Number(s.heightCm), a = Number(s.ageYears);
  if (!w || !h || !a || !s.sex) return null;
  return 10 * w + 6.25 * h - 5 * a + (s.sex === 'female' ? -161 : 5);
}

// Epley 공식 추정 1RM
function estimate1RM(kg, reps) {
  if (!kg || !reps) return 0;
  return reps === 1 ? kg : kg * (1 + reps / 30);
}

if (typeof module !== 'undefined') module.exports = { estimateEntry, estimateBMR, estimate1RM };

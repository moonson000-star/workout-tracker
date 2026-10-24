// 칼로리 추정 로직 (브라우저 전역 + Node 테스트 겸용)
const REST_MET = 1.5;
const GRAVITY = 9.81;
const KCAL_PER_JOULE = 1 / 4184;
const REF_HEIGHT_CM = 175; // 운동별 ROM 기본값의 기준 키

// entry: { type, met, rom, bwFactor, sets:[{kg,reps}], minutes }
// s: { bodyWeight, heightCm, secPerRep, restSec, volumeCorrection, efficiencyPct }
function estimateEntry(entry, s) {
  const bw = Number(s.bodyWeight) || 70;
  if (entry.type === 'time') {
    const minutes = Number(entry.minutes) || 0;
    const base = entry.met * bw * minutes / 60;
    return { base, bonus: 0, total: base, minutes, volume: 0, sets: 0 };
  }

  const sets = (entry.sets || []).filter(x => Number(x.reps) > 0);
  const totalReps = sets.reduce((a, x) => a + Number(x.reps), 0);
  const activeSec = totalReps * s.secPerRep;
  const restSec = sets.length * s.restSec;
  const base = (entry.met * bw * activeSec + REST_MET * bw * restSec) / 3600;

  let bonus = 0;
  if (s.volumeCorrection) {
    const efficiency = (Number(s.efficiencyPct) || 25) / 100;
    // 이동거리는 팔·다리 길이에 비례하므로 키로 보정 (키 미입력 시 기준값 그대로)
    const romScale = Number(s.heightCm) > 0 ? Number(s.heightCm) / REF_HEIGHT_CM : 1;
    const joules = sets.reduce((a, x) => {
      const load = (Number(x.kg) || 0) + bw * (entry.bwFactor || 0);
      return a + load * GRAVITY * (entry.rom || 0) * romScale * Number(x.reps);
    }, 0);
    bonus = joules / efficiency * KCAL_PER_JOULE;
  }

  const volume = sets.reduce((a, x) => a + (Number(x.kg) || 0) * Number(x.reps), 0);
  return {
    base, bonus, total: base + bonus,
    minutes: (activeSec + restSec) / 60,
    volume, sets: sets.length,
  };
}

// Epley 공식 추정 1RM
function estimate1RM(kg, reps) {
  if (!kg || !reps) return 0;
  return reps === 1 ? kg : kg * (1 + reps / 30);
}

if (typeof module !== 'undefined') module.exports = { estimateEntry, estimate1RM };

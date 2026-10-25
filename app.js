'use strict';

const STORAGE_KEY = 'workout-tracker-v1';
const DEFAULT_SETTINGS = {
  bodyWeight: null, heightCm: null, ageYears: null, sex: null, secPerRep: 3, restSec: 90, volumeCorrection: true, efficiencyPct: 25,
  timerSound: true, keepAwake: true, stepCalc: 'steps',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_EVERY_DAYS = 7;
const newBackupState = () => ({ lastAt: null, snoozeUntil: null, since: Date.now() });

// ---------- 상태 ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function normalizeState(s) {
  if (!s) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      exercises: DEFAULT_EXERCISES.map(e => ({ id: uid(), ...e })),
      logs: {},
      routines: [],
      activity: {},
      backup: newBackupState(),
      calibVersion: CALIB_VERSION,
    };
  }
  return {
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    exercises: s.exercises || [],
    logs: s.logs || {},
    routines: s.routines || [],
    activity: s.activity || {},
    backup: { ...newBackupState(), ...s.backup },
    calibVersion: s.calibVersion || 1,
  };
}

// 기본 운동의 계수가 바뀌면 운동 목록과 지난 기록에 반영 (이름이 같은 기본 운동만)
// 버전 3에서는 기본 목록을 홈트레이닝용으로 교체 (직접 추가한 운동은 유지)
// 지난 기록은 계수(MET·이동거리)만 갱신하고, 무게 입력 방식(dbs·sides)은 바꾸지 않음
function applyCalibration(s) {
  if (s.calibVersion >= CALIB_VERSION) return false;
  const byName = Object.fromEntries(DEFAULT_EXERCISES.map(e => [e.name, e]));
  if (s.calibVersion < 3) {
    const idByName = Object.fromEntries(s.exercises.map(e => [e.name, e.id]));
    const custom = s.exercises.filter(e => !LEGACY_DEFAULT_NAMES.includes(e.name) && !byName[e.name]);
    s.exercises = [...DEFAULT_EXERCISES.map(d => ({ id: idByName[d.name] || uid(), ...d })), ...custom];
  } else {
    s.exercises = s.exercises.map(e => {
      const d = byName[e.name];
      return d && d.type === e.type ? { ...e, ...d, id: e.id } : e;
    });
  }
  for (const list of Object.values(s.logs)) {
    list.forEach((en, i) => {
      const d = byName[en.name];
      if (d && d.type === en.type) list[i] = { ...en, met: d.met, rom: d.rom || 0, bwFactor: d.bwFactor || 0 };
    });
  }
  s.calibVersion = CALIB_VERSION;
  return true;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) { console.error(e); }
  return normalizeState(null);
}

let state = loadState();
applyCalibration(state);

// ---------- 저장 ----------
// 기기 저장(localStorage)을 기본으로 하고, claude.ai에서 열면 계정 저장소(db)에 동기화
// db 구조: data/users/<id>/meta (설정·운동목록·루틴), data/users/<id>/log-YYYY-MM (월별 기록·걸음)
let cloud = null; // { db, col, ids:Set, writes:{} }

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 저장 불가 환경 */ }
}

// what: 'meta' | 'all' | 'YYYY-MM-DD' (변경된 날짜)
function save(what) {
  saveLocal();
  if (!cloud) return;
  if (what === 'meta' || what === 'all') {
    cloudWrite('meta', {
      settings: state.settings, exercises: state.exercises, routines: state.routines,
      backup: state.backup, calibVersion: state.calibVersion,
    });
  }
  if (what === 'all') {
    const months = new Set([...Object.keys(state.logs), ...Object.keys(state.activity)].map(d => d.slice(0, 7)));
    months.forEach(m => cloudWrite(`log-${m}`, monthDoc(m)));
    [...cloud.ids].filter(id => id.startsWith('log-') && !months.has(id.slice(4)))
      .forEach(id => cloudWrite(id, null));
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(what)) {
    const m = what.slice(0, 7);
    cloudWrite(`log-${m}`, monthDoc(m));
  }
}

function monthDoc(m) {
  const days = {}, activity = {};
  for (const [d, list] of Object.entries(state.logs)) if (d.startsWith(m) && list.length) days[d] = list;
  for (const [d, a] of Object.entries(state.activity)) if (d.startsWith(m)) activity[d] = a;
  return { days, activity };
}

// 문서별로 한 번에 하나씩 순서대로 기록
function cloudWrite(id, body) {
  const ref = cloud.db.collection(cloud.col).doc(id);
  const empty = body && body.days && !Object.keys(body.days).length && !Object.keys(body.activity || {}).length;
  cloud.writes[id] = (cloud.writes[id] || Promise.resolve())
    .then(() => (body && !empty ? ref.set(body) : ref.delete()))
    .catch(e => {
      console.error(e);
      toast(e && e.code === 'quota_exceeded' ? '저장 공간이 가득 찼습니다' : '계정에 저장하지 못했습니다. 기기에는 저장되어 있습니다');
    });
}

async function initCloud() {
  if (!window.claude || !window.claude.use) return;
  const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
  if (!db || !user) return;
  const id = await user.id();
  if (!id) return;
  cloud = { db, col: `data/users/${id}`, ids: new Set(), writes: {} };
  let synced = false;
  db.collection(cloud.col).onSnapshot(snap => {
    cloud.ids = new Set(snap.docs.map(d => d.id));
    if (snap.empty) {
      // 계정에 아직 데이터가 없으면 이 기기의 기록을 올림
      if (!synced && !snap.metadata.fromCache) { synced = true; save('all'); }
      return;
    }
    synced = true;
    const logs = {}, activity = {};
    for (const d of snap.docs) {
      const body = d.data();
      if (d.id === 'meta') {
        state.settings = { ...DEFAULT_SETTINGS, ...body.settings };
        if (Array.isArray(body.exercises)) state.exercises = JSON.parse(JSON.stringify(body.exercises));
        state.calibVersion = body.calibVersion || 1;
        state.routines = JSON.parse(JSON.stringify(body.routines || []));
        state.backup = { ...newBackupState(), ...body.backup };
      } else if (d.id.startsWith('log-')) {
        Object.assign(logs, JSON.parse(JSON.stringify(body.days || {})));
        Object.assign(activity, JSON.parse(JSON.stringify(body.activity || {})));
      }
    }
    state.logs = logs;
    state.activity = activity;
    if (applyCalibration(state)) save('all');
    else saveLocal();
    render();
  }, e => console.error('sync', e));
}

saveLocal();

const calcSettings = () => ({ ...state.settings, bodyWeight: state.settings.bodyWeight || 70 });

// ---------- 유틸 ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: d });
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), Math.max(1800, msg.length * 70));
}

function dayTotals(date) {
  const s = calcSettings();
  return (state.logs[date] || []).reduce((acc, e) => {
    const r = estimateEntry(e, s);
    acc.kcal += r.total; acc.volume += r.volume; acc.sets += r.sets; acc.minutes += r.minutes;
    return acc;
  }, { kcal: 0, volume: 0, sets: 0, minutes: 0 });
}

// 브라우저 confirm() 대신 화면 안에서 확인 (claude.ai 안에서는 confirm()이 동작하지 않음)
function ask(message) {
  return new Promise(resolve => {
    const box = $('#ask');
    $('#ask-text').textContent = message;
    box.classList.remove('hidden');
    const done = ok => { box.classList.add('hidden'); resolve(ok); };
    $('#ask-ok').onclick = () => done(true);
    $('#ask-cancel').onclick = () => done(false);
    $('#ask-ok').focus();
  });
}

// ---------- 화면 전환 ----------
const VIEW_TITLES = { day: '오늘의 운동', stats: '통계', routines: '루틴', exercises: '운동 목록', settings: '설정' };
let currentView = 'day';

function showView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${v}`));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#view-title').textContent = VIEW_TITLES[v];
  render();
}

function render() {
  if (currentView === 'day') renderDay();
  if (currentView === 'stats') renderStats();
  if (currentView === 'routines') renderRoutines();
  if (currentView === 'exercises') renderExerciseManage();
  if (currentView === 'settings') renderSettings();
}

// ---------- 날짜별 기록 ----------
let currentDate = ymd(new Date());

function renderDay() {
  const d = parseYmd(currentDate);
  const isToday = currentDate === ymd(new Date());
  $('#date-text').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})${isToday ? ' · 오늘' : ''}`;
  $('#date-input').value = currentDate;
  $('#view-title').textContent = isToday ? '오늘의 운동' : '운동 기록';
  $('#weight-banner').classList.toggle('hidden', !!state.settings.bodyWeight);
  renderBackupBanner();

  const t = dayTotals(currentDate);
  $('#day-summary').innerHTML = `
    <div><b>${fmt(t.kcal)}</b><span>kcal</span></div>
    <div><b>${fmt(t.volume)}</b><span>볼륨 kg</span></div>
    <div><b>${fmt(t.sets)}</b><span>세트</span></div>
    <div><b>${fmt(t.minutes)}</b><span>분(추정)</span></div>`;
  renderBmrLine(t);

  const entries = state.logs[currentDate] || [];
  $('#day-empty').classList.toggle('hidden', entries.length > 0);
  $('#save-routine-btn').classList.toggle('hidden', !entries.length);
  $('#load-routine-btn').classList.toggle('hidden', !state.routines.length);
  renderRoutineSuggest(entries, d.getDay());
  const s = calcSettings();
  $('#entry-list').innerHTML = entries.map(e => {
    const r = estimateEntry(e, s);
    let detail;
    if (e.type === 'time') {
      detail = `<span class="set-chip">${fmt(e.minutes, 1)}분${e.km ? ` · ${fmt(e.km, 2)}km` : ''}</span>`;
    } else if (e.type === 'circuit') {
      detail = `<span class="set-chip done">${e.rounds}라운드 · ${fmt(e.minutes, 1)}분</span>` +
        (e.moves || []).map(m => `<span class="set-chip">${esc(m.name)} ${setLabel(m, m.kg, m.reps)}</span>`).join('');
    } else {
      const done = e.sets.filter(x => x.done).length;
      detail = (done ? `<span class="set-chip done">✓ ${done}/${e.sets.length}</span>` : '') +
        groupSets(e.sets).map(g =>
          `<span class="set-chip">${setLabel(e, g.kg, g.reps)}${g.count > 1 ? ` × ${g.count}세트` : ''}</span>`).join('');
    }
    return `<li class="entry card" data-id="${e.id}">
      <div class="entry-head">
        <div><span class="cat-tag">${esc(e.cat)}</span><b>${esc(e.name)}</b></div>
        <div class="kcal">${fmt(r.total)} kcal</div>
      </div>
      <div class="set-chips">${detail}</div>
      ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    </li>`;
  }).join('');
}

// 기록에 복사해 두는 운동 계수 (운동 목록을 나중에 바꿔도 지난 기록은 그대로)
const exParams = ex => ({
  name: ex.name, cat: ex.cat, type: ex.type, met: ex.met, rom: ex.rom || 0,
  bwFactor: ex.bwFactor || 0, dbs: ex.dbs || 1, sides: ex.sides || 1,
});

// "12kg×2 × 10회(한쪽)" — kg은 기구 1개, 양손이면 ×2 표시
function setLabel(e, kg, reps) {
  return `${fmt(kg, 2)}kg${(e.dbs || 1) === 2 ? '×2' : ''} × ${reps}회${(e.sides || 1) === 2 ? '(한쪽)' : ''}`;
}

const circuitSummary = c => (c.moves || []).map(m => `${m.name} ${fmt(m.kg, 2)}kg×${m.reps}`).join(' · ');

// 기초대사량 + 운동 순소모 (운동 중 어차피 쓰는 기초대사분은 빼서 중복 방지)
function renderBmrLine(t) {
  renderActivityCard();
  const bmr = estimateBMR(state.settings);
  $('#bmr-line').classList.toggle('hidden', !bmr);
  if (!bmr) return;
  const net = Math.max(0, t.kcal - (bmr / 1440) * t.minutes);
  const a = state.activity[currentDate];
  const walk = a ? activityKcal(a, calcSettings()).kcal : 0;
  $('#bmr-line').innerHTML = `
    <div class="bmr-eq">
      <span><small>기초대사</small><b>${fmt(bmr)}</b></span><i>+</i>
      <span><small>운동(순)</small><b>${fmt(net)}</b></span><i>+</i>
      <span><small>걸음</small><b>${a ? fmt(walk) : '–'}</b></span><i>=</i>
      <span class="sum"><small>오늘 소모</small><b>${fmt(bmr + net + walk)}</b></span>
    </div>
    <small class="muted">kcal · ${a ? '걸음 외 일상 활동(서 있기·집안일 등)은 제외' : '걸음 수를 입력하면 일상 걸음도 더해집니다'}</small>`;
}

// ---------- 걸음 · 일상 활동 ----------
// 웹앱은 건강 앱(HealthKit·Health Connect)을 직접 읽을 수 없어서,
// 단축어가 복사한 텍스트를 붙여넣거나 직접 입력하는 방식으로 가져옴
const STRIDE_PER_HEIGHT = 0.415; // 보폭 ≈ 키 × 0.415
const WALK_NET_KCAL_PER_KG_KM = 0.5; // ACSM 걷기 공식의 순산소비용 0.1 ml/kg/m ≈ 0.5 kcal/kg/km

// 걸음 순소모: 건강 앱 활동 에너지를 쓰도록 설정했고 값이 있으면 그 값, 아니면 걸음 수로 계산
function activityKcal(a, s) {
  const stride = ((Number(s.heightCm) || 170) * STRIDE_PER_HEIGHT) / 100;
  const km = ((Number(a.steps) || 0) * stride) / 1000;
  const fromSteps = WALK_NET_KCAL_PER_KG_KM * (Number(s.bodyWeight) || 70) * km;
  const useHealth = s.stepCalc === 'health' && Number(a.activeKcal) > 0;
  return { kcal: useHealth ? Number(a.activeKcal) : fromSteps, km, fromSteps, useHealth };
}

function renderActivityCard() {
  const a = state.activity[currentDate];
  const box = $('#activity-card');
  if (!a) {
    box.innerHTML = `<div class="act-empty">
      <div class="act-empty-head"><span>🚶 걸음 수</span>
        <button class="chip" data-act="open">직접 입력</button></div>
      <textarea class="act-quick" rows="1" aria-label="단축어 결과 붙여넣기"
        placeholder="길게 눌러 붙여넣기 → 바로 저장"></textarea>
      <small class="muted">단축어를 먼저 실행한 뒤 붙여넣으세요</small>
    </div>`;
    return;
  }
  const r = activityKcal(a, calcSettings());
  box.innerHTML = `<button class="act-row" data-act="open" aria-label="걸음 수 수정">
    <span class="act-main">🚶 <b>${fmt(a.steps)}</b>걸음 <small class="muted">약 ${fmt(r.km, 1)}km</small></span>
    <span class="act-kcal"><b>${fmt(r.kcal)}</b> kcal<small>${r.useHealth ? '건강 앱 활동 에너지' : '걸음 기준 순소모'}</small></span>
  </button>`;
}

let actDate = null;
function openActivitySheet() {
  actDate = currentDate;
  const a = state.activity[actDate] || {};
  $('#act-date').textContent = actDate;
  $('#act-steps').value = a.steps ?? '';
  $('#act-kcal').value = a.activeKcal ?? '';
  $('#act-paste').value = '';
  $('#act-delete').classList.toggle('hidden', !state.activity[actDate]);
  updateActivityPreview();
  openSheet('#activity-sheet');
}

function updateActivityPreview() {
  const a = { steps: Number($('#act-steps').value) || 0, activeKcal: Number($('#act-kcal').value) || 0 };
  const r = activityKcal(a, calcSettings());
  $('#act-preview').innerHTML = a.steps || a.activeKcal
    ? `걸음 기준 순소모 <b>${fmt(r.fromSteps)} kcal</b> (약 ${fmt(r.km, 1)}km)${a.activeKcal ? ` · 건강 앱 활동 에너지 ${fmt(a.activeKcal)} kcal` : ''}<br>
       <small>오늘 소모에는 <b>${r.useHealth ? '건강 앱 활동 에너지' : '걸음 기준 값'}</b>을 사용합니다 (설정에서 변경)</small>`
    : '';
}

// 단축어 결과 예: "wt;date=2026-10-24;steps=8234;kcal=312.5" (순서·구분자 무관, 쉼표·단위 허용)
// 날짜는 아이폰 기본 형식("2026. 10. 24.")이나 "2026년 10월 24일"도 인식
function parseHealthText(text) {
  // 단축어 텍스트에 [ ] 괄호나 따옴표가 같이 들어가도 읽히도록 제거
  const t = String(text || '').replace(/[[\]()"'“”]/g, '').replace(/(\d),(?=\d{3})/g, '$1');
  const num = keys => {
    const m = t.match(new RegExp(`(?:${keys})\\s*[=:]\\s*([\\d.]+)`, 'i'));
    return m ? Number(m[1]) : null;
  };
  const d = t.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  return {
    date: d ? ymd(new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]))) : null,
    steps: num('steps|걸음'),
    kcal: num('kcal|칼로리|에너지|energy'),
  };
}

function applyHealthText(text) {
  const r = parseHealthText(text);
  if (r.steps == null && r.kcal == null) {
    toast(/[가-힣]{2,}\s*[가-힣]*\]/.test(text) || /현재 날짜|합계\]/.test(text)
      ? '숫자 대신 글자가 들어 있습니다. 단축어의 텍스트에서 해당 부분을 파란 변수로 바꿔주세요'
      : '걸음 수를 찾지 못했습니다. 단축어 결과를 그대로 붙여넣어 주세요');
    return false;
  }
  if (r.date) { actDate = r.date; $('#act-date').textContent = actDate; }
  if (r.steps != null) $('#act-steps').value = Math.round(r.steps);
  if (r.kcal != null) $('#act-kcal').value = Math.round(r.kcal);
  updateActivityPreview();
  return true;
}

async function pasteFromClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    $('#act-paste').focus();
    return toast('클립보드를 읽지 못했습니다. 아래 빈 칸을 길게 눌러 "붙여넣기"를 눌러주세요');
  }
  if (!text || !text.trim()) return toast('클립보드가 비어 있습니다. 단축어를 먼저 실행해주세요');
  $('#act-paste').value = text;
  if (applyHealthText(text)) toast('가져왔습니다. 숫자를 확인하고 저장을 누르세요');
}

function saveActivity() {
  // 붙여넣기 칸에만 글자가 있고 숫자 칸이 비어 있으면 먼저 읽어 들임
  const pasted = $('#act-paste').value.trim();
  if (pasted && !$('#act-steps').value && !$('#act-kcal').value && !applyHealthText(pasted)) return;
  const steps = Number($('#act-steps').value) || 0;
  const activeKcal = Number($('#act-kcal').value) || 0;
  if (!steps && !activeKcal) return toast('걸음 수를 입력하세요');
  state.activity[actDate] = { steps, activeKcal: activeKcal || null, at: Date.now() };
  save(actDate);
  currentDate = actDate;
  closeSheets();
  renderDay();
  toast('걸음 수를 저장했습니다');
}

// 기록 화면 걸음 카드에서 바로 붙여넣기 → 저장
function quickSaveActivity(text) {
  const r = parseHealthText(text);
  if (r.steps == null && r.kcal == null) {
    toast('걸음 수를 찾지 못했습니다. 단축어를 실행한 뒤 다시 붙여넣어 주세요');
    return false;
  }
  const date = r.date || currentDate;
  state.activity[date] = { steps: Math.round(r.steps || 0), activeKcal: r.kcal ? Math.round(r.kcal) : null, at: Date.now() };
  save(date);
  currentDate = date;
  document.activeElement && document.activeElement.blur();
  renderDay();
  toast(`${date.slice(5).replace('-', '/')} 걸음 ${fmt(r.steps || 0)}보를 저장했습니다. 카드를 누르면 수정할 수 있어요`);
  return true;
}

async function deleteActivity() {
  if (!await ask('이 날의 걸음 기록을 삭제할까요?')) return;
  delete state.activity[actDate];
  save(actDate);
  closeSheets();
  renderDay();
}

// 주소로 넘겨받기 (안드로이드 자동화 앱 등): ?steps=8234&kcal=312&date=2026-10-24
function importActivityFromUrl() {
  let params;
  try { params = new URLSearchParams(location.search); } catch (e) { return; }
  if (!params.has('steps') && !params.has('kcal')) return;
  const r = parseHealthText(`steps=${params.get('steps') || ''};kcal=${params.get('kcal') || ''};${params.get('date') || ''}`);
  const date = r.date || ymd(new Date());
  if (r.steps != null || r.kcal != null) {
    state.activity[date] = { steps: r.steps || 0, activeKcal: r.kcal || null, at: Date.now() };
    save(date);
    currentDate = date;
    toast(`${date} 걸음 ${fmt(r.steps || 0)}보를 가져왔습니다`);
  }
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* 주소 정리 불가 */ }
}

// 연속된 동일 세트를 묶어서 "60kg × 10회 × 3세트" 형태로 표시
function groupSets(sets) {
  const out = [];
  for (const x of sets || []) {
    const last = out[out.length - 1];
    if (last && last.kg === Number(x.kg) && last.reps === Number(x.reps)) last.count++;
    else out.push({ kg: Number(x.kg), reps: Number(x.reps), count: 1 });
  }
  return out;
}

// ---------- 바텀시트 ----------
function openSheet(id) {
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
  $('#backdrop').classList.remove('hidden');
  $(id).classList.remove('hidden');
}
function closeSheets() {
  const inRoutineChild = editorMode === 'routine' &&
    ['#pick-sheet', '#entry-sheet', '#circuit-sheet'].some(id => !$(id).classList.contains('hidden'));
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
  if (inRoutineChild) { backToRoutineSheet(); return; }
  editorMode = 'log';
  routineDraft = null;
  $('#backdrop').classList.add('hidden');
}

function catChips(container, selected, onPick) {
  const cats = ['전체', ...CATEGORIES.filter(c => state.exercises.some(e => e.cat === c))];
  container.innerHTML = cats.map(c =>
    `<button class="chip ${c === selected ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  container.onclick = ev => {
    const b = ev.target.closest('[data-cat]');
    if (b) onPick(b.dataset.cat);
  };
}

function filterExercises(query, cat) {
  const q = query.trim().toLowerCase();
  return state.exercises.filter(e =>
    (cat === '전체' || e.cat === cat) && (!q || e.name.toLowerCase().includes(q)));
}

// 운동별 미리보기: 10회 1세트(근력), 유산소 30분, 기타 시간형 1분 예상 kcal
// 중량은 최근 기록의 최고 중량, 기록이 없으면 체중 × 기준 비율
function previewKcal(ex) {
  const s = calcSettings();
  if (ex.type === 'time') {
    const minutes = ex.cat === '유산소' ? 30 : 1;
    return { kcal: estimateEntry({ ...ex, minutes }, s).total, label: `${minutes}분` };
  }
  const last = lastEntryFor(ex.id, '9999-12-31');
  const kg = last
    ? Math.max(0, ...last.entry.sets.map(x => Number(x.kg) || 0))
    : (ex.refKg ?? Math.round(((ex.refRatio || 0) * s.bodyWeight) / 2.5) * 2.5);
  const kcal = estimateEntry({ ...ex, sets: [{ kg, reps: 10 }] }, s).total;
  return { kcal, label: `${kg ? setLabel(ex, kg, 10) : `맨몸 × 10회${(ex.sides || 1) === 2 ? '(한쪽)' : ''}`}${last ? ' (최근)' : ''}` };
}

// 운동 선택 시트
let pickCat = '전체';
function renderPickList() {
  catChips($('#pick-cat-chips'), pickCat, c => { pickCat = c; renderPickList(); });
  const list = filterExercises($('#pick-search').value, pickCat);
  const recent = recentExerciseIds();
  list.sort((a, b) => (recent.indexOf(a.id) + 1 || 999) - (recent.indexOf(b.id) + 1 || 999));
  $('#pick-list').innerHTML = `
    <li data-circuit="1" class="circuit-pick"><div><b>⚡ 서킷 · 타바타</b><br>
    <small class="muted">여러 동작을 1라운드로 묶고, 라운드 수와 총 시간으로 기록</small></div></li>` + list.map(e => `
    <li data-id="${e.id}"><div><span class="cat-tag">${esc(e.cat)}</span>${esc(e.name)}
    ${recent.includes(e.id) ? '<small class="muted">최근</small>' : ''}</div>
    <small class="muted nowrap">≈${fmt(previewKcal(e).kcal, 1)} kcal</small></li>`).join('')
    || '<li class="muted">검색 결과가 없습니다. 운동목록 탭에서 직접 추가할 수 있어요.</li>';
}

function recentExerciseIds() {
  const ids = [];
  for (const date of Object.keys(state.logs).sort().reverse()) {
    for (const e of state.logs[date]) if (e.exId && !ids.includes(e.exId)) ids.push(e.exId);
    if (ids.length >= 8) break;
  }
  return ids;
}

function lastEntryFor(exId, beforeDate) {
  for (const date of Object.keys(state.logs).sort().reverse()) {
    if (date >= beforeDate) continue;
    const e = state.logs[date].find(x => x.exId === exId);
    if (e) return { date, entry: e };
  }
  return null;
}

// 세트 입력 시트
let draft = null; // 편집 중인 entry
let editorMode = 'log'; // 'log': 날짜별 기록, 'routine': 루틴 항목

function openEntryEditor(entry, isNew) {
  draft = JSON.parse(JSON.stringify(entry));
  draft.isNew = isNew;
  const inRoutine = editorMode === 'routine';
  $('#entry-title').textContent = inRoutine ? `${draft.name} · 루틴` : draft.name;
  $('#entry-sheet').classList.toggle('routine-mode', inRoutine);
  $('#entry-note-wrap').classList.toggle('hidden', inRoutine);
  $('#entry-note').value = draft.note || '';
  $('#entry-delete').classList.toggle('hidden', isNew);
  const isTime = draft.type === 'time';
  $('#strength-form').classList.toggle('hidden', isTime);
  $('#time-form').classList.toggle('hidden', !isTime);

  const hints = [];
  if (!isTime && (draft.dbs || 1) === 2) hints.push('kg은 덤벨 1개 무게 (양손 ×2 자동 계산)');
  else if (!isTime && draft.bwFactor < 1) hints.push('kg은 덤벨·케틀벨 1개 무게');
  if (!isTime && (draft.sides || 1) === 2) hints.push('회는 한쪽 기준 (양쪽 ×2 자동 계산)');
  $('#entry-hint').textContent = hints.join(' · ');
  if (isTime) {
    $('#t-minutes').value = draft.minutes || '';
    $('#t-km').value = draft.km || '';
  } else {
    const last = lastEntryFor(draft.exId, currentDate);
    if (last) {
      const g = groupSets(last.entry.sets).map(x => `${fmt(x.kg, 2)}kg×${x.reps}${x.count > 1 ? `×${x.count}` : ''}`).join(', ');
      $('#last-record').textContent = `지난 기록 (${last.date}): ${g}`;
    } else {
      $('#last-record').textContent = '';
    }
    if (isNew && last) draft.sets = last.entry.sets.map(x => ({ kg: x.kg, reps: x.reps }));
    const first = draft.sets[0];
    $('#q-kg').value = first ? first.kg : '';
    $('#q-reps').value = first ? first.reps : 10;
    $('#q-sets').value = draft.sets.length || 3;
    renderSets();
  }
  updateEstimate();
  openSheet('#entry-sheet');
}

function renderSets() {
  $('#sets-body').innerHTML = draft.sets.map((x, i) => `
    <tr data-i="${i}">
      <td>${i + 1}</td>
      <td><input type="number" inputmode="decimal" step="0.5" min="0" data-f="kg" value="${x.kg}"></td>
      <td><input type="number" inputmode="numeric" min="0" data-f="reps" value="${x.reps}"></td>
      <td class="chk-col"><button class="chk ${x.done ? 'on' : ''}" aria-label="${i + 1}세트 완료" aria-pressed="${!!x.done}">✓</button></td>
      <td><button class="icon-btn del-set" aria-label="세트 삭제">✕</button></td>
    </tr>`).join('');
}

function updateEstimate() {
  if (!draft) return;
  if (draft.type === 'time') {
    draft.minutes = Number($('#t-minutes').value) || 0;
    draft.km = Number($('#t-km').value) || 0;
  }
  const r = estimateEntry(draft, calcSettings());
  const extra = draft.type === 'time'
    ? ''
    : ` <small>(기본 ${fmt(r.base, 1)} + 중량보정 ${fmt(r.bonus, 1)})</small><br><small>볼륨 ${fmt(r.volume)}kg · 약 ${fmt(r.minutes)}분</small>`;
  $('#entry-estimate').innerHTML = `예상 소모: <b>${fmt(r.total)} kcal</b>${extra}`;
}

function validDraft() {
  if (draft.type === 'time') {
    if (!draft.minutes) { toast('운동 시간을 입력하세요'); return false; }
  } else if (!draft.sets.some(x => Number(x.reps) > 0)) {
    toast('최소 1세트를 입력하세요');
    return false;
  }
  return true;
}

// 기록 모드에서 현재 편집 내용을 그날 기록에 반영 (시트는 그대로)
function persistDraft() {
  draft.note = $('#entry-note').value.trim();
  const { isNew, ...entry } = draft;
  entry.sets = (entry.sets || []).filter(x => Number(x.reps) > 0);
  const list = state.logs[currentDate] || (state.logs[currentDate] = []);
  const i = list.findIndex(x => x.id === entry.id);
  if (i < 0) list.push(entry);
  else list[i] = entry;
  draft.isNew = false;
  $('#entry-delete').classList.remove('hidden');
  save(currentDate);
  renderDay();
}

function saveDraft() {
  if (!validDraft()) return;
  if (editorMode === 'routine') return saveRoutineItem();
  persistDraft();
  closeSheets();
  draft = null;
  toast('저장했습니다');
}

async function deleteDraft() {
  if (editorMode === 'routine') return deleteRoutineItem();
  if (!await ask('이 운동 기록을 삭제할까요?')) return;
  const list = state.logs[currentDate] || [];
  state.logs[currentDate] = list.filter(x => x.id !== draft.id);
  if (!state.logs[currentDate].length) delete state.logs[currentDate];
  save(currentDate);
  closeSheets();
  draft = null;
  renderDay();
}

// ---------- 통계 ----------
let statRange = 7;
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();

// ---------- 기간·부위별 통계 ----------
// 주는 월요일 시작. 서킷은 동작별로 부위를 나누고, 칼로리·시간은 동작별 일(J) 비율로 배분
const METRICS = {
  sets: { label: '세트', unit: '세트', digits: 0 },
  volume: { label: '볼륨', unit: 'kg', digits: 0 },
  kcal: { label: '칼로리', unit: 'kcal', digits: 0 },
  minutes: { label: '시간', unit: '분', digits: 0 },
};
let statPeriod = 'week';
let statOffset = 0;
let statMetric = 'sets';

function weekStart(date) {
  const d = parseYmd(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
}

function periodRange(kind, offset) {
  const today = ymd(new Date());
  if (kind === 'week') {
    const from = addDays(weekStart(today), offset * 7);
    const to = addDays(from, 6);
    const f = parseYmd(from), t = parseYmd(to);
    const label = offset === 0 ? '이번 주' : offset === -1 ? '지난주' : `${f.getMonth() + 1}/${f.getDate()}~${t.getMonth() + 1}/${t.getDate()}`;
    return { from, to, label };
  }
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: ymd(first), to: ymd(last), label: `${first.getFullYear()}년 ${first.getMonth() + 1}월` };
}

function aggregate(from, to) {
  const s = calcSettings();
  const out = { days: 0, kcal: 0, steps: 0, sets: 0, volume: 0, minutes: 0, cats: {} };
  const bucket = c => out.cats[c] || (out.cats[c] = { sets: 0, volume: 0, kcal: 0, minutes: 0 });
  for (const [date, list] of Object.entries(state.logs)) {
    if (date < from || date > to || !list.length) continue;
    out.days++;
    for (const e of list) {
      const r = estimateEntry(e, s);
      out.kcal += r.total;
      out.volume += r.volume;
      out.minutes += r.minutes;
      const moves = e.type === 'circuit' ? (e.moves || []).filter(m => Number(m.reps) > 0) : [];
      if (!moves.length) {
        const b = bucket(e.cat || '기타');
        b.sets += r.sets; b.volume += r.volume; b.kcal += r.total; b.minutes += r.minutes;
        continue;
      }
      const rounds = Number(e.rounds) || 0;
      const works = moves.map(m => workJoules(m, m.kg, m.reps, s.bodyWeight, 1) || 1);
      const totalWork = works.reduce((a, w) => a + w, 0);
      moves.forEach((m, i) => {
        const b = bucket(m.cat || e.cat || '전신');
        const share = works[i] / totalWork;
        b.sets += rounds;
        b.volume += rounds * liftedVolume(m, m.kg, m.reps);
        b.kcal += r.total * share;
        b.minutes += r.minutes * share;
      });
    }
  }
  out.sets = Object.values(out.cats).reduce((a, b) => a + b.sets, 0);
  for (const [date, a] of Object.entries(state.activity || {})) {
    if (date >= from && date <= to) out.steps += Number(a.steps) || 0;
  }
  return out;
}

function deltaBadge(cur, prev) {
  if (!prev) return cur ? '<small class="delta new">새 기록</small>' : '<small class="delta">–</small>';
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return '<small class="delta">변화 없음</small>';
  return pct > 0
    ? `<small class="delta up">▲ ${fmt(pct)}%</small>`
    : `<small class="delta down">▼ ${fmt(-pct)}%</small>`;
}

function renderPeriodStats() {
  const cur = periodRange(statPeriod, statOffset);
  const prev = periodRange(statPeriod, statOffset - 1);
  const a = aggregate(cur.from, cur.to), b = aggregate(prev.from, prev.to);
  $('#period-label').textContent = cur.label;
  $('#period-next').disabled = statOffset >= 0;
  document.querySelectorAll('#period-seg button').forEach(x => x.classList.toggle('active', x.dataset.p === statPeriod));
  const tiles = [
    ['운동한 날', a.days, b.days, '일', 0],
    ['운동 칼로리', a.kcal, b.kcal, 'kcal', 0],
    ['걸음', a.steps, b.steps, '보', 0],
    ['세트', a.sets, b.sets, '세트', 0],
    ['볼륨', a.volume, b.volume, 'kg', 0],
    ['운동 시간', a.minutes, b.minutes, '분', 0],
  ];
  $('#kpi-grid').innerHTML = tiles.map(([label, v, pv, unit, d]) => `
    <div class="kpi"><span>${label}</span><b>${fmt(v, d)}<small>${unit}</small></b>${deltaBadge(v, pv)}</div>`).join('');
  $('#kpi-note').textContent = `${statPeriod === 'week' ? '지난 기간' : '전월'}(${prev.label}) 대비 · 서킷은 동작 × 라운드를 세트로 셉니다`;
  renderCategoryBars(a, cur.label);
}

function renderCategoryBars(a, label) {
  const m = METRICS[statMetric];
  document.querySelectorAll('#metric-seg button').forEach(x => x.classList.toggle('active', x.dataset.m === statMetric));
  $('#cat-period').textContent = `${label} · ${m.label}`;
  const rows = Object.entries(a.cats).map(([cat, v]) => [cat, v[statMetric]]).filter(([, v]) => v > 0)
    .sort((x, y) => y[1] - x[1]);
  const total = rows.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(1, ...rows.map(([, v]) => v));
  $('#cat-bars').innerHTML = rows.map(([cat, v]) => `
    <li><span class="cat-name">${esc(cat)}</span>
      <span class="cat-track"><i style="width:${(v / max) * 100}%"></i></span>
      <span class="cat-val"><b>${fmt(v, m.digits)}</b> ${m.unit}<small>${fmt((v / total) * 100)}%</small></span></li>`).join('')
    || `<li class="muted">${label}에 기록된 ${m.label}이(가) 없습니다.</li>`;
}

// 최근 12주: 위는 주간 합계 막대, 아래는 부위 × 주 히트맵 (한 가지 색의 진하기로 양 표현)
function renderTrend() {
  const m = METRICS[statMetric];
  const thisWeek = weekStart(ymd(new Date()));
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const from = addDays(thisWeek, -7 * i);
    weeks.push({ from, to: addDays(from, 6), agg: aggregate(from, addDays(from, 6)) });
  }
  const totals = weeks.map(w => Object.values(w.agg.cats).reduce((s, c) => s + c[statMetric], 0));
  const tmax = Math.max(1, ...totals);
  const cats = CATEGORIES.filter(c => weeks.some(w => (w.agg.cats[c] || {})[statMetric] > 0));
  const cmax = Math.max(1, ...weeks.flatMap(w => cats.map(c => (w.agg.cats[c] || {})[statMetric] || 0)));
  const wlabel = w => { const d = parseYmd(w.from); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const info = (w, what, v) => `${wlabel(w)} 주 · ${what} · ${fmt(v, m.digits)} ${m.unit}`;

  let html = '<span class="tl"></span>' + weeks.map((w, i) => `
    <button class="tbar" data-info="${esc(info(w, '합계', totals[i]))}" aria-label="${esc(info(w, '합계', totals[i]))}">
      <i style="height:${(totals[i] / tmax) * 100}%"></i></button>`).join('');
  for (const c of cats) {
    html += `<span class="tl">${esc(c)}</span>` + weeks.map(w => {
      const v = (w.agg.cats[c] || {})[statMetric] || 0;
      const level = v ? Math.max(1, Math.ceil((v / cmax) * 5)) : 0;
      return `<button class="hcell h${level}" data-info="${esc(info(w, c, v))}" aria-label="${esc(info(w, c, v))}"></button>`;
    }).join('');
  }
  html += '<span class="tl"></span>' + weeks.map((w, i) =>
    `<span class="wk">${i === 11 ? '이번' : i % 3 === 2 ? wlabel(w) : ''}</span>`).join('');
  $('#trend').innerHTML = cats.length ? html : '<p class="muted">최근 12주 기록이 쌓이면 표시됩니다.</p>';
  $('#trend-unit').textContent = `· ${m.label} (${m.unit})`;
}

function renderStats() {
  renderPeriodStats();
  renderTrend();
  const today = ymd(new Date());
  const days = [];
  for (let i = statRange - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    days.push({ date, ...dayTotals(date) });
  }
  const max = Math.max(1, ...days.map(d => d.kcal));
  $('#kcal-chart').innerHTML = days.map(d => {
    const dt = parseYmd(d.date);
    const label = statRange === 7 ? WEEKDAYS[dt.getDay()] : (dt.getDate() % 5 === 0 || dt.getDate() === 1 ? dt.getDate() : '');
    return `<div class="bar-col" data-date="${d.date}" title="${d.date}: ${fmt(d.kcal)} kcal">
      ${statRange === 7 && d.kcal ? `<small>${fmt(d.kcal)}</small>` : ''}
      <div class="bar" style="height:${(d.kcal / max) * 100}%"></div>
      <span>${label}</span></div>`;
  }).join('');

  const active = days.filter(d => d.kcal > 0);
  const sum = k => days.reduce((a, d) => a + d[k], 0);
  $('#range-summary').innerHTML = `
    <div><span>운동한 날</span><b>${active.length}일</b></div>
    <div><span>총 소모</span><b>${fmt(sum('kcal'))} kcal</b></div>
    <div><span>운동일 평균</span><b>${fmt(active.length ? sum('kcal') / active.length : 0)} kcal</b></div>
    <div><span>총 볼륨</span><b>${fmt(sum('volume'))} kg</b></div>`;

  renderCalendar();
  renderPRs();
}

function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('#cal-title').textContent = `${y}년 ${m + 1}월`;
  const startPad = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = ymd(new Date());
  let html = WEEKDAYS.map(w => `<div class="cal-w">${w}</div>`).join('');
  html += '<div></div>'.repeat(startPad);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = ymd(new Date(y, m, d));
    const has = (state.logs[date] || []).length > 0;
    const kcal = has ? dayTotals(date).kcal : 0;
    html += `<button class="cal-d ${has ? 'has' : ''} ${date === today ? 'today' : ''}" data-date="${date}">
      ${d}${has ? `<small>${fmt(kcal)}</small>` : ''}</button>`;
  }
  $('#calendar').innerHTML = html;
}

function renderPRs() {
  const best = {};
  for (const [date, list] of Object.entries(state.logs)) {
    for (const e of list) {
      if (e.type !== 'strength') continue;
      for (const x of e.sets) {
        const kg = Number(x.kg), reps = Number(x.reps);
        const b = best[e.name] || (best[e.name] = { maxKg: 0, maxDate: '', rm: 0 });
        if (kg > b.maxKg) { b.maxKg = kg; b.maxDate = date; }
        b.rm = Math.max(b.rm, estimate1RM(kg, reps));
      }
    }
  }
  const rows = Object.entries(best).filter(([, b]) => b.maxKg > 0).sort((a, b) => b[1].rm - a[1].rm);
  $('#pr-list').innerHTML = rows.map(([name, b]) =>
    `<li><span>${esc(name)}</span><span><b>${fmt(b.maxKg, 2)}kg</b> <small class="muted">${b.maxDate.slice(5)} · 1RM≈${fmt(b.rm, 1)}</small></span></li>`).join('')
    || '<li class="muted">중량 기록이 쌓이면 표시됩니다.</li>';
}

// ---------- 운동 목록 관리 ----------
let manageCat = '전체';
let editingExId = null;

function renderExerciseManage() {
  catChips($('#ex-cat-chips'), manageCat, c => { manageCat = c; renderExerciseManage(); });
  const list = filterExercises($('#ex-search').value, manageCat)
    .map(e => ({ e, p: previewKcal(e) }));
  const max = Math.max(1, ...list.filter(x => x.e.type === 'strength').map(x => x.p.kcal));
  $('#ex-manage-list').innerHTML = list.map(({ e, p }) => `
    <li data-id="${e.id}" class="ex-row">
      <div class="ex-main">
        <div><span class="cat-tag">${esc(e.cat)}</span>${esc(e.name)}</div>
        <small class="muted">${esc(p.label)} · MET ${e.met}${e.type === 'time' ? '' : ` · ROM ${e.rom ?? 0}m${e.bwFactor ? ` · 체중×${e.bwFactor}` : ''}`}${(e.dbs || 1) === 2 ? ' · 양손' : ''}${(e.sides || 1) === 2 ? ' · 한쪽씩' : ''}</small>
        <small class="src">${esc(e.src || '직접 입력')}</small>
        ${e.type === 'strength' ? `<div class="meter"><i style="width:${Math.min(100, (p.kcal / max) * 100)}%"></i></div>` : ''}
      </div>
      <div class="ex-kcal"><b>${fmt(p.kcal, 1)}</b><small>kcal</small></div>
    </li>`).join('') || '<li class="muted">운동이 없습니다.</li>';
}

function openExerciseEditor(ex) {
  editingExId = ex ? ex.id : null;
  const f = $('#ex-form');
  f.cat.innerHTML = CATEGORIES.map(c => `<option>${c}</option>`).join('');
  f.exName.value = ex ? ex.name : '';
  f.cat.value = ex ? ex.cat : (manageCat !== '전체' ? manageCat : '기타');
  f.type.value = ex ? ex.type : 'strength';
  f.met.value = ex ? ex.met : 4.0;
  f.rom.value = ex ? (ex.rom ?? 0.4) : 0.4;
  f.bwFactor.value = ex ? (ex.bwFactor ?? 0) : 0;
  f.dbs.value = String(ex ? (ex.dbs || 1) : 1);
  f.sides.checked = ex ? (ex.sides || 1) === 2 : false;
  $('#ex-sheet-title').textContent = ex ? '운동 수정' : '운동 추가';
  $('#ex-src').textContent = ex ? `근거 · ${ex.src || '직접 입력'}` : '';
  $('#ex-delete').classList.toggle('hidden', !ex);
  toggleStrengthFields();
  openSheet('#ex-sheet');
}

function toggleStrengthFields() {
  $('#ex-form .strength-only').classList.toggle('hidden', $('#ex-form').type.value !== 'strength');
}

function saveExercise(ev) {
  ev.preventDefault();
  const f = ev.target;
  const data = {
    name: f.exName.value.trim(), cat: f.cat.value, type: f.type.value, met: Number(f.met.value),
  };
  if (data.type === 'strength') {
    data.rom = Number(f.rom.value) || 0;
    data.bwFactor = Number(f.bwFactor.value) || 0;
    data.dbs = Number(f.dbs.value) || 1;
    data.sides = f.sides.checked ? 2 : 1;
  }
  if (!data.name) return;
  if (state.exercises.some(e => e.name === data.name && e.id !== editingExId)) return toast('같은 이름의 운동이 있습니다');
  if (editingExId) {
    const i = state.exercises.findIndex(e => e.id === editingExId);
    const old = state.exercises[i];
    const changed = ['met', 'rom', 'bwFactor', 'dbs', 'sides'].some(k => (old[k] || 0) !== (data[k] || 0));
    state.exercises[i] = { ...old, ...data, src: changed ? '직접 입력' : old.src };
  } else {
    state.exercises.push({ id: uid(), ...data, src: '직접 입력' });
  }
  save('meta');
  closeSheets();
  renderExerciseManage();
  toast('저장했습니다 (기존 기록에는 영향 없음)');
}

async function deleteExercise() {
  if (!await ask('이 운동을 목록에서 삭제할까요? (기존 기록은 유지됩니다)')) return;
  state.exercises = state.exercises.filter(e => e.id !== editingExId);
  save('meta');
  closeSheets();
  renderExerciseManage();
}

// ---------- 설정 · 백업 ----------
function renderSettings() {
  const f = $('#settings-form'), s = state.settings;
  f.bodyWeight.value = s.bodyWeight ?? '';
  f.heightCm.value = s.heightCm ?? '';
  f.ageYears.value = s.ageYears ?? '';
  f.sex.value = s.sex || '';
  f.timerSound.checked = s.timerSound;
  f.keepAwake.checked = s.keepAwake;
  f.stepCalc.value = s.stepCalc || 'steps';
  renderWakeStatus();
  f.secPerRep.value = s.secPerRep;
  f.restSec.value = s.restSec;
  f.volumeCorrection.checked = s.volumeCorrection;
  f.efficiencyPct.value = s.efficiencyPct;
}

function saveSettings(ev) {
  ev.preventDefault();
  const f = ev.target;
  state.settings = {
    bodyWeight: Number(f.bodyWeight.value) || null,
    heightCm: Number(f.heightCm.value) || null,
    ageYears: Number(f.ageYears.value) || null,
    sex: f.sex.value || null,
    timerSound: f.timerSound.checked,
    keepAwake: f.keepAwake.checked,
    stepCalc: f.stepCalc.value,
    secPerRep: Number(f.secPerRep.value) || DEFAULT_SETTINGS.secPerRep,
    restSec: Number(f.restSec.value) >= 0 ? Number(f.restSec.value) : DEFAULT_SETTINGS.restSec,
    volumeCorrection: f.volumeCorrection.checked,
    efficiencyPct: Number(f.efficiencyPct.value) || DEFAULT_SETTINGS.efficiencyPct,
  };
  save('meta');
  if (state.settings.keepAwake) keepScreenOn();
  else releaseScreen();
  renderBmrLine(dayTotals(currentDate));
  toast('설정을 저장했습니다');
}

// 저장에 성공하면 true
// claude.ai 안에서는 downloads 기능, 휴대폰은 공유 시트('파일에 저장'), 그 밖에는 다운로드 링크
async function download(filename, text, type) {
  const dl = window.claude && window.claude.use ? await claude.use('downloads') : null;
  if (dl) {
    try { await dl.save({ filename, data: text }); return true; } catch (e) {
      if (e && e.code !== 'declined') toast('파일을 저장하지 못했습니다');
      return false;
    }
  }
  const file = typeof File === 'function' ? new File([text], filename, { type }) : null;
  const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

async function exportJson() {
  const ok = await download(`workout-backup-${ymd(new Date())}.json`, JSON.stringify(state, null, 2), 'application/json');
  if (ok) {
    state.backup = { ...state.backup, lastAt: Date.now(), snoozeUntil: null };
    save('meta');
    render();
    toast('백업했습니다');
  }
}

// ---------- 백업 알림 ----------
// 기기에만 저장되는 단독 앱에서, 마지막 백업(또는 사용 시작) 후 7일이 지나면 표시
function backupDueDays() {
  if (cloud || !Object.keys(state.logs).length) return 0;
  const b = state.backup, now = Date.now();
  if (b.snoozeUntil && now < b.snoozeUntil) return 0;
  const days = Math.floor((now - (b.lastAt || b.since || now)) / DAY_MS);
  return days >= BACKUP_EVERY_DAYS ? days : 0;
}

function renderBackupBanner() {
  const days = backupDueDays();
  $('#backup-banner').classList.toggle('hidden', !days);
  if (!days) return;
  $('#backup-text').innerHTML = state.backup.lastAt
    ? `마지막 백업 후 <b>${days}일</b>이 지났습니다. 기록은 이 기기에만 저장되니 백업 파일을 받아두세요.`
    : '아직 백업한 적이 없습니다. 기록은 이 기기에만 저장되니 백업 파일을 받아두세요.';
}

function exportCsv() {
  const s = calcSettings();
  const rows = [['날짜', '부위', '운동', '세트', 'kg', '회', '분', 'km', '추정kcal(운동별)', '메모']];
  for (const date of Object.keys(state.logs).sort()) {
    for (const e of state.logs[date]) {
      const kcal = estimateEntry(e, s).total.toFixed(1);
      if (e.type === 'time') rows.push([date, e.cat, e.name, '', '', '', e.minutes, e.km || '', kcal, e.note || '']);
      else if (e.type === 'circuit') rows.push([date, e.cat, e.name, `${e.rounds}라운드`, '', '', e.minutes, '', kcal, [circuitSummary(e), e.note].filter(Boolean).join(' / ')]);
      else e.sets.forEach((x, i) => rows.push([date, e.cat, e.name, i + 1, x.kg, x.reps, '', '', i === 0 ? kcal : '', i === 0 ? e.note || '' : '']));
    }
  }
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  download(`workout-${ymd(new Date())}.csv`, '﻿' + csv, 'text/csv');
}

function importJson(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.logs || !data.exercises) throw new Error('형식 오류');
      if (!await ask('현재 데이터를 백업 파일로 덮어쓸까요?')) return;
      state = normalizeState(data);
      save('all');
      render();
      toast('가져오기 완료');
    } catch (e) {
      toast('올바른 백업 파일이 아닙니다');
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
}

async function resetAll() {
  if (!await ask('모든 기록과 설정을 삭제합니다. 계속할까요?')) return;
  state = normalizeState(null);
  save('all');
  render();
  toast('초기화했습니다');
}

// ---------- 휴식 타이머 ----------
const timer = { endAt: 0, iv: null, hideT: null, audio: null };
const fmtClock = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

function startTimer(sec = Number(state.settings.restSec) || 90) {
  primeAudio();
  clearTimeout(timer.hideT);
  timer.endAt = Date.now() + sec * 1000;
  $('#timer').classList.remove('hidden', 'done');
  $('#timer-label').textContent = '휴식';
  clearInterval(timer.iv);
  timer.iv = setInterval(tickTimer, 250);
  tickTimer();
}

function stopTimer() {
  clearInterval(timer.iv);
  clearTimeout(timer.hideT);
  timer.iv = null;
  timer.endAt = 0;
  $('#timer').classList.add('hidden');
}

function adjustTimer(delta) {
  const left = timer.iv ? Math.ceil((timer.endAt - Date.now()) / 1000) : 0;
  if (left + delta > 0) startTimer(left + delta);
  else if (timer.iv) finishTimer();
}

function tickTimer() {
  const left = Math.ceil((timer.endAt - Date.now()) / 1000);
  if (left <= 0) return finishTimer();
  $('#timer-time').textContent = fmtClock(left);
}

function finishTimer() {
  clearInterval(timer.iv);
  timer.iv = null;
  $('#timer-time').textContent = '0:00';
  $('#timer-label').textContent = '휴식 끝!';
  $('#timer').classList.add('done');
  alertTimer();
  timer.hideT = setTimeout(stopTimer, 6000);
}

// 브라우저는 사용자가 버튼을 누른 순간에만 소리를 허용하므로, 타이머를 시작할 때 미리 준비
function primeAudio() {
  if (!state.settings.timerSound) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!timer.audio && AC) timer.audio = new AC();
    if (timer.audio && timer.audio.state === 'suspended') timer.audio.resume();
  } catch (e) { timer.audio = null; }
}

// tones: [[주파수Hz, 시작 오프셋초, 길이초], ...]
function playTones(tones, vibrate) {
  if (!state.settings.timerSound) return;
  try { if (vibrate && navigator.vibrate) navigator.vibrate(vibrate); } catch (e) { /* 진동 미지원 */ }
  const ctx = timer.audio;
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    for (const [freq, offset, len] of tones) {
      const at = t0 + offset;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + len + 0.05);
    }
  } catch (e) { /* 소리 재생 불가 */ }
}

const SOUNDS = {
  tick: [[[660, 0, 0.12]], null],
  go: [[[990, 0, 0.45]], [300]],
  rest: [[[440, 0, 0.45]], [150, 80, 150]],
  end: [[[880, 0, 0.25], [880, 0.35, 0.25], [1175, 0.7, 0.5]], [250, 120, 250, 120, 400]],
};
const sound = name => playTones(...SOUNDS[name]);

function alertTimer() {
  playTones([[880, 0, 0.25], [880, 0.35, 0.25], [880, 0.7, 0.25]], [250, 120, 250, 120, 250]);
}

// ---------- 루틴 ----------
let routineDraft = null; // 편집 중인 루틴 { id, name, days, items, isNew }
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월~일

function routineItemFromEntry(e) {
  if (e.type === 'circuit') {
    const { note, routineId, isNew, ...c } = JSON.parse(JSON.stringify(e));
    return { ...c, id: uid() };
  }
  return {
    id: uid(), exId: e.exId, ...exParams(e), minutes: e.minutes || 0,
    sets: (e.sets || []).filter(x => Number(x.reps) > 0).map(x => ({ kg: Number(x.kg) || 0, reps: Number(x.reps) })),
  };
}

const routineKcal = r => r.items.reduce((a, it) => a + estimateEntry(it, calcSettings()).total, 0);
const daysLabel = days => (days && days.length
  ? WEEK_ORDER.filter(d => days.includes(d)).map(d => WEEKDAYS[d]).join('·')
  : '요일 미지정');

function itemSummary(it) {
  if (it.type === 'time') return `${fmt(it.minutes, 1)}분`;
  if (it.type === 'circuit') return `${it.rounds}라운드 · ${fmt(it.minutes, 1)}분`;
  return groupSets(it.sets).map(g => `${setLabel(it, g.kg, g.reps)}${g.count > 1 ? `×${g.count}` : ''}`).join(', ');
}

function renderRoutines() {
  $('#routine-empty').classList.toggle('hidden', state.routines.length > 0);
  $('#routine-list').innerHTML = state.routines.map(r => `
    <li class="card routine-card" data-id="${r.id}">
      <div class="entry-head">
        <div><b>${esc(r.name)}</b> <span class="cat-tag">${esc(daysLabel(r.days))}</span></div>
        <div class="kcal">≈${fmt(routineKcal(r))} kcal</div>
      </div>
      <ul class="routine-lines">${r.items.map(it =>
        `<li><span>${esc(it.name)}</span><small class="muted">${esc(itemSummary(it))}</small></li>`).join('')}</ul>
      <div class="btn-row"><button class="btn primary grow" data-load="${r.id}">오늘 기록에 불러오기</button></div>
    </li>`).join('');
}

// 기록이 없는 날, 그 요일로 지정된 루틴을 추천
function renderRoutineSuggest(entries, weekday) {
  const matches = entries.length ? [] : state.routines.filter(r => (r.days || []).includes(weekday));
  $('#routine-suggest').innerHTML = matches.map(r => `
    <div class="card suggest">
      <div class="entry-head">
        <div><small class="muted">${WEEKDAYS[weekday]}요일 루틴</small><br><b>${esc(r.name)}</b></div>
        <div class="kcal">≈${fmt(routineKcal(r))} kcal</div>
      </div>
      <div class="set-chips">${r.items.map(it => `<span class="set-chip">${esc(it.name)}</span>`).join('')}</div>
      <div class="btn-row"><button class="btn primary grow" data-load="${r.id}">불러오기</button></div>
    </div>`).join('');
}

function openRoutinePicker() {
  const wd = parseYmd(currentDate).getDay();
  const list = [...state.routines].sort((a, b) =>
    Number((b.days || []).includes(wd)) - Number((a.days || []).includes(wd)));
  $('#routine-pick-list').innerHTML = list.map(r => `
    <li data-load="${r.id}"><div><b>${esc(r.name)}</b><br>
    <small class="muted">${esc(daysLabel(r.days))} · ${r.items.length}개 운동</small></div>
    <small class="muted nowrap">≈${fmt(routineKcal(r))} kcal</small></li>`).join('');
  openSheet('#routine-pick-sheet');
}

// 루틴의 운동을 그날 기록으로 추가 (운동 계수는 현재 운동목록 기준)
async function loadRoutine(id, date) {
  const r = state.routines.find(x => x.id === id);
  if (!r) return false;
  const list = state.logs[date] || [];
  if (list.some(e => e.routineId === id) &&
      !await ask(`'${r.name}' 루틴을 이미 불러왔습니다. 한 번 더 추가할까요?`)) return false;
  for (const it of r.items) {
    if (it.type === 'circuit') {
      list.push({ ...JSON.parse(JSON.stringify(it)), id: uid(), note: '', routineId: r.id });
      continue;
    }
    const ex = state.exercises.find(e => e.id === it.exId) || state.exercises.find(e => e.name === it.name);
    list.push({
      id: uid(), exId: ex ? ex.id : it.exId, ...exParams(ex || it),
      sets: (it.sets || []).map(x => ({ kg: x.kg, reps: x.reps })),
      minutes: it.minutes || 0, km: 0, note: '', routineId: r.id,
    });
  }
  state.logs[date] = list;
  save(date);
  closeSheets();
  render();
  toast(`'${r.name}' 루틴을 불러왔습니다. 하지 않은 운동은 눌러서 삭제하세요`);
  return true;
}

function openRoutineEditor(r) {
  routineDraft = r
    ? { ...JSON.parse(JSON.stringify(r)), isNew: false }
    : { id: uid(), name: '', days: [], items: [], isNew: true };
  routineDraft.days = routineDraft.days || [];
  $('#routine-name').value = routineDraft.name;
  $('#routine-sheet-title').textContent = routineDraft.isNew ? '루틴 만들기' : '루틴 수정';
  $('#routine-delete').classList.toggle('hidden', routineDraft.isNew);
  renderRoutineSheet();
  openSheet('#routine-sheet');
}

function renderRoutineSheet() {
  const r = routineDraft;
  $('#routine-days').innerHTML = WEEK_ORDER.map(d => `
    <button class="chip ${r.days.includes(d) ? 'active' : ''}" data-d="${d}" aria-pressed="${r.days.includes(d)}">${WEEKDAYS[d]}</button>`).join('');
  $('#routine-items').innerHTML = r.items.map(it => `
    <li data-id="${it.id}"><div><span class="cat-tag">${esc(it.cat)}</span>${esc(it.name)}</div>
    <small class="muted">${esc(itemSummary(it))}</small></li>`).join('')
    || '<li class="muted">＋ 운동 추가로 루틴에 넣을 운동을 고르세요.</li>';
  $('#routine-estimate').innerHTML = r.items.length
    ? `루틴 전체 예상 소모: <b>${fmt(routineKcal(r))} kcal</b> <small>(${r.items.length}개 운동)</small>`
    : '';
}

function backToRoutineSheet() {
  editorMode = 'log';
  draft = null;
  renderRoutineSheet();
  openSheet('#routine-sheet');
}

function saveRoutineItem() {
  const item = { ...routineItemFromEntry(draft), id: draft.id };
  const i = routineDraft.items.findIndex(x => x.id === draft.id);
  if (i < 0) routineDraft.items.push(item);
  else routineDraft.items[i] = item;
  backToRoutineSheet();
}

function deleteRoutineItem() {
  routineDraft.items = routineDraft.items.filter(x => x.id !== draft.id);
  backToRoutineSheet();
}

function saveRoutine() {
  const r = routineDraft;
  r.name = $('#routine-name').value.trim() || `루틴 ${state.routines.length + 1}`;
  if (!r.items.length) return toast('운동을 1개 이상 추가하세요');
  const { isNew, ...routine } = r;
  const i = state.routines.findIndex(x => x.id === routine.id);
  if (i < 0) state.routines.push(routine);
  else state.routines[i] = routine;
  save('meta');
  closeSheets();
  render();
  toast('루틴을 저장했습니다');
}

async function deleteRoutine() {
  if (!await ask(`'${routineDraft.name || '이'}' 루틴을 삭제할까요? (불러온 기록은 유지됩니다)`)) return;
  state.routines = state.routines.filter(x => x.id !== routineDraft.id);
  save('meta');
  closeSheets();
  render();
}

function saveDayAsRoutine() {
  const d = parseYmd(currentDate);
  openRoutineEditor(null);
  routineDraft.name = `${d.getMonth() + 1}/${d.getDate()} 루틴`;
  routineDraft.days = [d.getDay()];
  routineDraft.items = (state.logs[currentDate] || []).map(routineItemFromEntry);
  $('#routine-name').value = routineDraft.name;
  renderRoutineSheet();
}

// ---------- 서킷 · 타바타 ----------
// 여러 동작을 1라운드로 묶어 라운드 수 × 총 시간으로 기록 (쉬지 않고 이어서 하는 운동)
let cdraft = null;

function lastCircuit() {
  for (const date of Object.keys(state.logs).sort().reverse()) {
    const c = state.logs[date].filter(e => e.type === 'circuit').pop();
    if (c) return c;
  }
  return null;
}

function openCircuitEditor(entry) {
  const isNew = !entry;
  const base = entry || lastCircuit();
  cdraft = base
    ? { ...JSON.parse(JSON.stringify(base)), id: isNew ? uid() : base.id, note: isNew ? '' : (base.note || '') }
    : { id: uid(), type: 'circuit', name: '덤벨 서킷', cat: '전신', met: 8, minutes: 20, rounds: 5, moves: [], note: '' };
  delete cdraft.routineId;
  cdraft.isNew = isNew;
  const inRoutine = editorMode === 'routine';
  $('#circuit-title').textContent = inRoutine ? '서킷 · 루틴' : '서킷 · 타바타';
  $('#c-name').value = cdraft.name;
  $('#c-rounds').value = cdraft.rounds;
  $('#c-minutes').value = cdraft.minutes;
  $('#c-met').innerHTML = CIRCUIT_INTENSITIES.map(x =>
    `<option value="${x.met}" ${Number(cdraft.met) === x.met ? 'selected' : ''}>${x.label}</option>`).join('');
  $('#c-note').value = cdraft.note;
  $('#c-note-wrap').classList.toggle('hidden', inRoutine);
  $('#c-delete').classList.toggle('hidden', isNew);
  if (!cdraft.moves.length) addCircuitMove();
  renderCircuitMoves();
  openSheet('#circuit-sheet');
}

function addCircuitMove() {
  const last = cdraft.moves[cdraft.moves.length - 1];
  const ex = state.exercises.find(e => e.type === 'strength' && !cdraft.moves.some(m => m.exId === e.id))
    || state.exercises.find(e => e.type === 'strength');
  if (!ex) return;
  cdraft.moves.push({ exId: ex.id, ...exParams(ex), kg: last ? last.kg : (ex.refKg || 0), reps: last ? last.reps : 5 });
}

function renderCircuitMoves() {
  const groups = CATEGORIES.map(cat => [cat, state.exercises.filter(e => e.type === 'strength' && e.cat === cat)])
    .filter(([, list]) => list.length);
  $('#c-moves').innerHTML = cdraft.moves.map((m, i) => `
    <tr data-i="${i}">
      <td class="move-cell"><select data-f="exId" aria-label="${i + 1}번째 동작">${groups.map(([cat, list]) =>
        `<optgroup label="${esc(cat)}">${list.map(e =>
          `<option value="${e.id}" ${e.id === m.exId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>`).join('')}
        ${state.exercises.some(e => e.id === m.exId) ? '' : `<option value="${esc(m.exId || '')}" selected>${esc(m.name)}</option>`}
      </select><small class="muted">${(m.dbs || 1) === 2 ? '덤벨 1개 무게 · 양손' : '1개 무게'}${(m.sides || 1) === 2 ? ' · 한쪽 횟수' : ''}</small></td>
      <td><input type="number" inputmode="decimal" step="0.5" min="0" data-f="kg" value="${m.kg}" aria-label="kg"></td>
      <td><input type="number" inputmode="numeric" min="0" data-f="reps" value="${m.reps}" aria-label="회"></td>
      <td><button class="icon-btn del-move" aria-label="동작 삭제">✕</button></td>
    </tr>`).join('');
  updateCircuitEstimate();
}

function updateCircuitEstimate() {
  cdraft.name = $('#c-name').value.trim() || '서킷';
  cdraft.rounds = Number($('#c-rounds').value) || 0;
  cdraft.minutes = Number($('#c-minutes').value) || 0;
  cdraft.met = Number($('#c-met').value) || 8;
  const r = estimateEntry(cdraft, calcSettings());
  const perMin = cdraft.minutes ? r.total / cdraft.minutes : 0;
  $('#c-estimate').innerHTML = `예상 소모: <b>${fmt(r.total)} kcal</b>
    <small>(시간 기준 ${fmt(r.base)} + 중량보정 ${fmt(r.bonus)})</small><br>
    <small>분당 ${fmt(perMin, 1)} kcal · 총 볼륨 ${fmt(r.volume)}kg · ${cdraft.rounds}라운드</small>`;
}

function saveCircuit() {
  updateCircuitEstimate();
  cdraft.moves = cdraft.moves.filter(m => Number(m.reps) > 0);
  if (!cdraft.moves.length) return toast('동작을 1개 이상 입력하세요');
  if (!cdraft.rounds || !cdraft.minutes) return toast('라운드 수와 총 시간을 입력하세요');
  cdraft.note = $('#c-note').value.trim();
  const { isNew, ...entry } = cdraft;
  if (editorMode === 'routine') {
    const i = routineDraft.items.findIndex(x => x.id === entry.id);
    const { note, ...item } = entry;
    if (i < 0) routineDraft.items.push(item);
    else routineDraft.items[i] = item;
    cdraft = null;
    return backToRoutineSheet();
  }
  const list = state.logs[currentDate] || (state.logs[currentDate] = []);
  const i = list.findIndex(x => x.id === entry.id);
  if (i < 0) list.push(entry);
  else list[i] = entry;
  save(currentDate);
  cdraft = null;
  closeSheets();
  renderDay();
  toast('저장했습니다');
}

async function deleteCircuit() {
  if (editorMode === 'routine') {
    routineDraft.items = routineDraft.items.filter(x => x.id !== cdraft.id);
    cdraft = null;
    return backToRoutineSheet();
  }
  if (!await ask('이 서킷 기록을 삭제할까요?')) return;
  state.logs[currentDate] = (state.logs[currentDate] || []).filter(x => x.id !== cdraft.id);
  if (!state.logs[currentDate].length) delete state.logs[currentDate];
  save(currentDate);
  cdraft = null;
  closeSheets();
  renderDay();
}

// ---------- 라운드 타이머 ----------
// 시작 시각 기준으로 경과 시간을 계산하므로, 화면이 잠깐 가려져도 시간은 정확
const RT_PREP_SEC = 10;
const RT_MODES = {
  fortime: {
    desc: '정해진 라운드를 쉬지 않고 최대한 빨리. 한 라운드를 마칠 때마다 ＋1을 누르세요. 목표 라운드에 도달하면 자동으로 끝납니다 (0이면 직접 종료).',
    fields: [['rounds', '목표 라운드', 7, '라운드']],
  },
  amrap: {
    desc: '정해진 시간 동안 최대한 많은 라운드. 한 라운드를 마칠 때마다 ＋1을 누르세요.',
    fields: [['minutes', '총 시간', 20, '분']],
  },
  emom: {
    desc: '간격이 시작될 때마다 정해진 동작을 하고, 남은 시간은 쉽니다. 매 간격 시작에 알림음.',
    fields: [['interval', '간격', 60, '초'], ['rounds', '라운드', 10, '라운드']],
  },
  tabata: {
    desc: '운동과 휴식을 번갈아 반복합니다. 기본은 20초 운동 / 10초 휴식 × 8라운드.',
    fields: [['work', '운동', 20, '초'], ['rest', '휴식', 10, '초'], ['rounds', '라운드', 8, '라운드']],
  },
};
let rt = null; // 진행 중인 타이머

function rtConfig() {
  const saved = state.settings.roundTimer || {};
  const mode = RT_MODES[saved.mode] ? saved.mode : 'fortime';
  const cfgs = {};
  for (const [m, def] of Object.entries(RT_MODES)) {
    cfgs[m] = Object.fromEntries(def.fields.map(([k, , d]) => [k, (saved.cfgs && saved.cfgs[m] && saved.cfgs[m][k]) ?? d]));
  }
  const last = lastCircuit();
  if (last && !(saved.cfgs && saved.cfgs.fortime)) cfgs.fortime.rounds = last.rounds;
  return { mode, cfgs };
}

function openRoundTimer() {
  closeSheets();
  rtSetup = rtConfig();
  showRtPanel('setup');
  renderRtSetup();
  $('#rt').classList.remove('hidden');
  document.body.classList.add('rt-open');
  keepScreenOn();
}

let rtSetup = null;
function renderRtSetup() {
  const { mode, cfgs } = rtSetup;
  document.querySelectorAll('#rt-modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#rt-desc').textContent = RT_MODES[mode].desc;
  $('#rt-fields').innerHTML = RT_MODES[mode].fields.map(([k, label, , unit]) => `
    <label class="field">${label} <small class="muted">${unit}</small>
      <input type="number" inputmode="numeric" min="0" max="999" data-k="${k}" value="${cfgs[mode][k]}"></label>`).join('');
}

function showRtPanel(name) {
  ['setup', 'run', 'done'].forEach(n => $(`#rt-${n}`).classList.toggle('hidden', n !== name));
}

function startRoundTimer() {
  primeAudio();
  const { mode, cfgs } = rtSetup;
  state.settings.roundTimer = rtSetup;
  save('meta');
  rt = { mode, cfg: { ...cfgs[mode] }, startAt: Date.now(), pausedAt: 0, pausedTotal: 0, rounds: 0, lastKey: '', lastCount: 0, cur: {} };
  const tapping = mode === 'fortime' || mode === 'amrap';
  $('#rt-tap').classList.toggle('hidden', !tapping);
  $('#rt-undo').classList.toggle('hidden', !tapping);
  $('#rt-pause').textContent = '일시정지';
  showRtPanel('run');
  clearInterval(rt.iv);
  rt.iv = setInterval(rtTick, 200);
  rtTick();
}

function rtElapsed() {
  const paused = rt.pausedTotal + (rt.pausedAt ? Date.now() - rt.pausedAt : 0);
  return (Date.now() - rt.startAt - paused) / 1000;
}

// 현재 상태 계산: phase(prep/run/work/rest), 표시할 초, 라운드
function rtState() {
  const e = rtElapsed(), c = rt.cfg;
  if (e < RT_PREP_SEC) return { phase: 'prep', remain: RT_PREP_SEC - e, t: 0 };
  const t = e - RT_PREP_SEC;
  if (rt.mode === 'fortime') {
    const done = c.rounds > 0 && rt.rounds >= c.rounds;
    return { phase: 'run', up: t, t, done };
  }
  if (rt.mode === 'amrap') {
    const total = c.minutes * 60;
    return { phase: 'run', remain: total - t, t: Math.min(t, total), done: t >= total };
  }
  if (rt.mode === 'emom') {
    const total = c.interval * c.rounds;
    const idx = Math.min(Math.floor(t / c.interval), c.rounds - 1);
    return { phase: 'work', remain: c.interval - (t - idx * c.interval), round: idx + 1, completed: idx + 1, t: Math.min(t, total), done: t >= total };
  }
  const cycle = c.work + c.rest;
  const total = cycle * c.rounds - c.rest; // 마지막 휴식은 생략
  const idx = Math.floor(t / cycle);
  const within = t - idx * cycle;
  const work = within < c.work;
  return {
    phase: work ? 'work' : 'rest', remain: work ? c.work - within : cycle - within,
    round: Math.min(idx + 1, c.rounds), completed: Math.min(idx + (work ? 0 : 1), c.rounds),
    t: Math.min(t, total), done: t >= total,
  };
}

const PHASE_LABEL = { prep: '준비', run: '진행 중', work: '운동', rest: '휴식' };

function rtTick() {
  if (!rt || rt.pausedAt) return;
  const st = rtState();
  rt.cur = st;
  if (st.done) return finishRoundTimer();
  const key = `${st.phase}-${st.round || 0}`;
  if (key !== rt.lastKey) {
    if (rt.lastKey) sound(st.phase === 'rest' ? 'rest' : 'go');
    rt.lastKey = key;
    rt.lastCount = 0;
  }
  if (st.remain !== undefined) {
    const s = Math.ceil(st.remain);
    if (s <= 3 && s >= 1 && s !== rt.lastCount) { sound('tick'); rt.lastCount = s; }
  }
  renderRtRun(st);
}

function renderRtRun(st) {
  const c = rt.cfg;
  $('#rt-face').dataset.phase = st.phase;
  $('#rt-phase').textContent = PHASE_LABEL[st.phase];
  $('#rt-clock').textContent = fmtClock(Math.max(0, st.up !== undefined ? Math.floor(st.up) : Math.ceil(st.remain)));
  let round = '', next = '';
  if (st.phase === 'prep') round = rt.mode === 'tabata' || rt.mode === 'emom' ? `총 ${c.rounds}라운드` : '';
  else if (rt.mode === 'fortime') round = `${rt.rounds}${c.rounds ? ` / ${c.rounds}` : ''} 라운드 완료`;
  else if (rt.mode === 'amrap') round = `${rt.rounds} 라운드 완료`;
  else round = `${st.round} / ${c.rounds} 라운드`;
  if (rt.mode === 'amrap' && st.phase === 'run') next = `경과 ${fmtClock(Math.floor(st.t))}`;
  if (rt.mode === 'fortime' && rt.rounds > 0 && st.phase === 'run') next = `라운드 평균 ${fmtClock(Math.round(st.t / rt.rounds))}`;
  $('#rt-round').textContent = round;
  $('#rt-next').textContent = next;
}

function tapRound(delta) {
  if (!rt || rt.pausedAt || rt.cur.phase === 'prep') return;
  rt.rounds = Math.max(0, rt.rounds + delta);
  if (delta > 0) sound('tick');
  rtTick();
}

function togglePause() {
  if (!rt) return;
  if (rt.pausedAt) {
    rt.pausedTotal += Date.now() - rt.pausedAt;
    rt.pausedAt = 0;
    $('#rt-pause').textContent = '일시정지';
    rtTick();
  } else {
    rt.pausedAt = Date.now();
    $('#rt-pause').textContent = '계속';
    $('#rt-phase').textContent = '일시정지';
  }
}

function finishRoundTimer() {
  clearInterval(rt.iv);
  if (rt.pausedAt) { rt.pausedTotal += Date.now() - rt.pausedAt; rt.pausedAt = 0; }
  const st = rtState();
  const tapped = rt.mode === 'fortime' || rt.mode === 'amrap';
  rt.result = { seconds: Math.round(st.t), rounds: tapped ? rt.rounds : (st.completed || 0) };
  sound('end');
  $('#rt-done-time').textContent = fmtClock(rt.result.seconds);
  $('#rt-done-rounds').textContent = `${rt.result.rounds} 라운드`;
  showRtPanel('done');
}

async function stopRoundTimer() {
  if (!rt) return;
  if (rt.cur.phase === 'prep') { clearInterval(rt.iv); rt = null; return showRtPanel('setup'); }
  if (!await ask('여기서 끝내고 결과를 볼까요?')) return;
  finishRoundTimer();
}

async function closeRoundTimer() {
  if (rt && !rt.result && rt.cur.phase !== 'prep' && !await ask('진행 중인 타이머를 끝낼까요? 결과는 저장되지 않습니다.')) return;
  if (rt) clearInterval(rt.iv);
  rt = null;
  $('#rt').classList.add('hidden');
  document.body.classList.remove('rt-open');
}

// 결과를 서킷 기록으로: 라운드 수와 시간(분)을 채워서 서킷 입력 화면을 염
function logRoundTimer() {
  const { seconds, rounds } = rt.result;
  rt = null;
  $('#rt').classList.add('hidden');
  document.body.classList.remove('rt-open');
  editorMode = 'log';
  openCircuitEditor(null);
  $('#c-rounds').value = rounds;
  $('#c-minutes').value = Math.round((seconds / 60) * 10) / 10;
  updateCircuitEstimate();
}

// ---------- 화면 꺼짐 방지 ----------
// Screen Wake Lock: 앱이 화면에 보이는 동안만 유지되고, 다른 앱으로 가면 자동 해제 → 돌아오면 다시 요청
let wakeLock = null;

async function keepScreenOn() {
  if (!state.settings.keepAwake || !('wakeLock' in navigator) || document.hidden) return;
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; renderWakeStatus(); });
  } catch (e) {
    wakeLock = null;
  }
  renderWakeStatus();
}

function releaseScreen() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
  renderWakeStatus();
}

function renderWakeStatus() {
  const el = $('#wake-status');
  if (!el) return;
  el.textContent = !('wakeLock' in navigator)
    ? '이 브라우저는 화면 꺼짐 방지를 지원하지 않습니다. 휴대폰의 화면 자동 잠금 시간을 늘려주세요.'
    : !state.settings.keepAwake ? '꺼짐'
      : wakeLock ? '동작 중: 앱이 열려 있는 동안 화면이 꺼지지 않습니다.'
        : '화면을 한 번 터치하면 켜집니다.';
}

// ---------- 새 버전 알림 ----------
// 아이폰 홈 화면 앱은 닫지 않으면 예전 화면을 계속 띄우므로, 다시 볼 때 새 버전이 있는지 확인
const APP_VERSION = '2026-10-25.1';
let updateCheckedAt = 0;

async function checkForUpdate() {
  if (window.claude || location.protocol === 'file:' || Date.now() - updateCheckedAt < 60 * 1000) return;
  updateCheckedAt = Date.now();
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await res.json();
    $('#update-banner').classList.toggle('hidden', !version || version === APP_VERSION);
  } catch (e) { /* 오프라인 */ }
}

// ---------- 이벤트 ----------
document.querySelector('.tabbar').onclick = ev => {
  const b = ev.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
};

$('#prev-day').onclick = () => { currentDate = addDays(currentDate, -1); renderDay(); };
$('#next-day').onclick = () => { currentDate = addDays(currentDate, 1); renderDay(); };
$('#today-btn').onclick = () => { currentDate = ymd(new Date()); renderDay(); };
$('#date-input').onchange = ev => { if (ev.target.value) { currentDate = ev.target.value; renderDay(); } };

$('#add-entry-btn').onclick = () => {
  editorMode = 'log';
  $('#pick-search').value = '';
  renderPickList();
  openSheet('#pick-sheet');
};
$('#pick-search').oninput = renderPickList;
$('#pick-list').onclick = ev => {
  if (ev.target.closest('[data-circuit]')) return openCircuitEditor(null);
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const ex = state.exercises.find(e => e.id === li.dataset.id);
  openEntryEditor({
    id: uid(), exId: ex.id, ...exParams(ex), sets: [], minutes: 0, km: 0, note: '',
  }, true);
};

$('#entry-list').onclick = ev => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const entry = (state.logs[currentDate] || []).find(e => e.id === li.dataset.id);
  editorMode = 'log';
  if (entry && entry.type === 'circuit') openCircuitEditor(entry);
  else if (entry) openEntryEditor(entry, false);
};

$('#q-apply').onclick = () => {
  const kg = Number($('#q-kg').value) || 0;
  const reps = Number($('#q-reps').value) || 0;
  const n = Math.min(30, Math.max(1, Number($('#q-sets').value) || 1));
  if (!reps) return toast('횟수를 입력하세요');
  draft.sets = Array.from({ length: n }, () => ({ kg, reps }));
  renderSets();
  updateEstimate();
};
$('#add-set-btn').onclick = () => {
  const last = draft.sets[draft.sets.length - 1] || { kg: Number($('#q-kg').value) || 0, reps: Number($('#q-reps').value) || 10 };
  draft.sets.push({ kg: last.kg, reps: last.reps });
  renderSets();
  updateEstimate();
};
$('#sets-body').oninput = ev => {
  const tr = ev.target.closest('tr');
  if (!tr || !ev.target.dataset.f) return;
  draft.sets[tr.dataset.i][ev.target.dataset.f] = Number(ev.target.value) || 0;
  updateEstimate();
};
$('#sets-body').onclick = ev => {
  const chk = ev.target.closest('.chk');
  if (chk) {
    // 세트 완료 체크: 바로 저장하고 휴식 타이머 시작
    const x = draft.sets[Number(chk.closest('tr').dataset.i)];
    x.done = !x.done;
    renderSets();
    updateEstimate();
    if (x.done) {
      if (Number(x.reps) > 0) persistDraft();
      startTimer();
    } else if (!draft.isNew) {
      persistDraft();
    }
    return;
  }
  if (!ev.target.classList.contains('del-set')) return;
  draft.sets.splice(Number(ev.target.closest('tr').dataset.i), 1);
  renderSets();
  updateEstimate();
};
$('#t-minutes').oninput = updateEstimate;
$('#t-km').oninput = updateEstimate;
$('#entry-save').onclick = saveDraft;
$('#entry-delete').onclick = deleteDraft;

$('#backdrop').onclick = closeSheets;
document.querySelectorAll('.close-sheet').forEach(b => { b.onclick = closeSheets; });

$('#period-seg').onclick = ev => {
  const b = ev.target.closest('[data-p]');
  if (!b) return;
  statPeriod = b.dataset.p;
  statOffset = 0;
  renderPeriodStats();
};
$('#period-prev').onclick = () => { statOffset--; renderPeriodStats(); };
$('#period-next').onclick = () => { if (statOffset < 0) { statOffset++; renderPeriodStats(); } };
$('#metric-seg').onclick = ev => {
  const b = ev.target.closest('[data-m]');
  if (!b) return;
  statMetric = b.dataset.m;
  renderPeriodStats();
  renderTrend();
};
$('#trend').onclick = ev => {
  const c = ev.target.closest('[data-info]');
  if (!c) return;
  document.querySelectorAll('#trend .sel').forEach(x => x.classList.remove('sel'));
  c.classList.add('sel');
  $('#trend-info').textContent = c.dataset.info;
};

$('#range-seg').onclick = ev => {
  const b = ev.target.closest('button[data-range]');
  if (!b) return;
  statRange = Number(b.dataset.range);
  document.querySelectorAll('#range-seg button').forEach(x => x.classList.toggle('active', x === b));
  renderStats();
};
const goToDate = date => { currentDate = date; showView('day'); };
$('#kcal-chart').onclick = ev => { const c = ev.target.closest('[data-date]'); if (c) goToDate(c.dataset.date); };
$('#calendar').onclick = ev => { const c = ev.target.closest('[data-date]'); if (c) goToDate(c.dataset.date); };
$('#cal-prev').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); };
$('#cal-next').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); };

$('#ex-search').oninput = renderExerciseManage;
$('#add-ex-btn').onclick = () => openExerciseEditor(null);
$('#ex-manage-list').onclick = ev => {
  const li = ev.target.closest('li[data-id]');
  if (li) openExerciseEditor(state.exercises.find(e => e.id === li.dataset.id));
};
$('#ex-form').onsubmit = saveExercise;
$('#ex-form').type.onchange = toggleStrengthFields;
$('#ex-delete').onclick = deleteExercise;

$('#timer-btn').onclick = () => (timer.iv ? stopTimer() : startTimer());
$('#timer-stop').onclick = stopTimer;
$('#timer-plus').onclick = () => adjustTimer(15);
$('#timer-minus').onclick = () => adjustTimer(-15);
$('#rest-btn').onclick = () => startTimer();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (timer.iv) tickTimer();
  if (rt && rt.iv && !rt.result) rtTick();
  keepScreenOn();
  checkForUpdate();
});
// 일부 브라우저(iOS Safari)는 사용자가 화면을 누른 순간에만 화면 꺼짐 방지를 허용
document.addEventListener('pointerdown', () => keepScreenOn(), { passive: true });

$('#backup-now').onclick = exportJson;
$('#backup-later').onclick = () => {
  state.backup = { ...state.backup, snoozeUntil: Date.now() + DAY_MS };
  save('meta');
  renderDay();
};

$('#load-routine-btn').onclick = openRoutinePicker;
$('#save-routine-btn').onclick = saveDayAsRoutine;
$('#routine-suggest').onclick = ev => {
  const b = ev.target.closest('[data-load]');
  if (b) loadRoutine(b.dataset.load, currentDate);
};
$('#routine-pick-list').onclick = ev => {
  const li = ev.target.closest('[data-load]');
  if (li) loadRoutine(li.dataset.load, currentDate);
};
$('#routine-list').onclick = async ev => {
  const b = ev.target.closest('[data-load]');
  if (b) {
    const today = ymd(new Date());
    if (await loadRoutine(b.dataset.load, today)) goToDate(today);
    return;
  }
  const card = ev.target.closest('li.routine-card');
  if (card) openRoutineEditor(state.routines.find(r => r.id === card.dataset.id));
};
$('#add-routine-btn').onclick = () => openRoutineEditor(null);
$('#routine-name').oninput = ev => { routineDraft.name = ev.target.value; };
$('#routine-days').onclick = ev => {
  const b = ev.target.closest('[data-d]');
  if (!b) return;
  const d = Number(b.dataset.d);
  routineDraft.days = routineDraft.days.includes(d) ? routineDraft.days.filter(x => x !== d) : [...routineDraft.days, d];
  renderRoutineSheet();
};
$('#routine-items').onclick = ev => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const it = routineDraft.items.find(x => x.id === li.dataset.id);
  editorMode = 'routine';
  if (it.type === 'circuit') openCircuitEditor(it);
  else openEntryEditor({ ...it, km: 0, note: '' }, false);
};
$('#routine-add-ex').onclick = () => {
  editorMode = 'routine';
  $('#pick-search').value = '';
  renderPickList();
  openSheet('#pick-sheet');
};
$('#routine-save').onclick = saveRoutine;
$('#routine-delete').onclick = deleteRoutine;

$('#c-moves').onchange = ev => {
  const tr = ev.target.closest('tr');
  if (!tr || ev.target.dataset.f !== 'exId') return;
  const m = cdraft.moves[tr.dataset.i];
  const ex = state.exercises.find(e => e.id === ev.target.value);
  if (ex) Object.assign(m, { exId: ex.id, ...exParams(ex) });
  renderCircuitMoves();
};
$('#c-moves').oninput = ev => {
  const tr = ev.target.closest('tr');
  const f = ev.target.dataset.f;
  if (!tr || (f !== 'kg' && f !== 'reps')) return;
  cdraft.moves[tr.dataset.i][f] = Number(ev.target.value) || 0;
  updateCircuitEstimate();
};
$('#c-moves').onclick = ev => {
  if (!ev.target.classList.contains('del-move')) return;
  cdraft.moves.splice(Number(ev.target.closest('tr').dataset.i), 1);
  renderCircuitMoves();
};
$('#c-add-move').onclick = () => { addCircuitMove(); renderCircuitMoves(); };
['#c-name', '#c-rounds', '#c-minutes'].forEach(id => { $(id).oninput = updateCircuitEstimate; });
$('#c-met').onchange = updateCircuitEstimate;
$('#c-save').onclick = saveCircuit;
$('#c-timer').onclick = openRoundTimer;

$('#rt-open-btn').onclick = openRoundTimer;
$('#rt-close').onclick = closeRoundTimer;
$('#rt-modes').onclick = ev => {
  const b = ev.target.closest('[data-mode]');
  if (!b) return;
  rtSetup.mode = b.dataset.mode;
  renderRtSetup();
};
$('#rt-fields').oninput = ev => {
  const k = ev.target.dataset.k;
  if (k) rtSetup.cfgs[rtSetup.mode][k] = Math.max(0, Number(ev.target.value) || 0);
};
$('#rt-start').onclick = () => {
  const c = rtSetup.cfgs[rtSetup.mode];
  const bad = RT_MODES[rtSetup.mode].fields.some(([k]) => k !== 'rounds' && k !== 'rest' && !c[k])
    || (rtSetup.mode !== 'fortime' && !c.rounds && 'rounds' in c);
  if (bad) return toast('시간과 라운드를 입력하세요');
  startRoundTimer();
};
$('#rt-tap').onclick = () => tapRound(1);
$('#rt-undo').onclick = () => tapRound(-1);
$('#rt-pause').onclick = togglePause;
$('#rt-stop').onclick = stopRoundTimer;
$('#rt-log').onclick = logRoundTimer;
$('#rt-again').onclick = () => { rt = null; showRtPanel('setup'); renderRtSetup(); };
$('#c-delete').onclick = deleteCircuit;

$('#activity-card').onclick = ev => { if (ev.target.closest('[data-act]')) openActivitySheet(); };
$('#activity-card').addEventListener('paste', ev => {
  if (!ev.target.classList.contains('act-quick')) return;
  const text = ev.clipboardData && ev.clipboardData.getData('text');
  if (!text) return; // 일부 브라우저는 붙여넣은 뒤 input 이벤트로 처리
  ev.preventDefault();
  if (!quickSaveActivity(text)) ev.target.value = text;
});
$('#activity-card').addEventListener('input', ev => {
  if (!ev.target.classList.contains('act-quick')) return;
  const v = ev.target.value;
  if (/=\s*\[?\s*\d/.test(v) && /steps|kcal|걸음/i.test(v)) quickSaveActivity(v);
});
$('#act-clip').onclick = pasteFromClipboard;
$('#act-paste').oninput = ev => { if (ev.target.value.trim()) applyHealthText(ev.target.value); };
$('#act-paste').onpaste = ev => {
  const text = ev.clipboardData && ev.clipboardData.getData('text');
  if (!text) return;
  ev.preventDefault();
  ev.target.value = text;
  if (applyHealthText(text)) toast('가져왔습니다. 숫자를 확인하고 저장을 누르세요');
};
$('#act-steps').oninput = updateActivityPreview;
$('#act-kcal').oninput = updateActivityPreview;
$('#act-save').onclick = saveActivity;
$('#act-delete').onclick = deleteActivity;

$('#settings-form').onsubmit = saveSettings;
$('#export-btn').onclick = exportJson;
$('#csv-btn').onclick = exportCsv;
$('#import-input').onchange = importJson;
$('#reset-btn').onclick = resetAll;

importActivityFromUrl();
render();
initCloud();
$('#update-now').onclick = () => location.reload();
$('#app-version').textContent = APP_VERSION;
setTimeout(checkForUpdate, 2000);

// 단독 PWA로 열 때만 오프라인 캐시 사용 (claude.ai 안에서는 window.claude가 있음)
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.claude) {
  navigator.serviceWorker.register('sw.js').catch(console.error);
}

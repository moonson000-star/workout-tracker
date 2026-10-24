'use strict';

const STORAGE_KEY = 'workout-tracker-v1';
const DEFAULT_SETTINGS = {
  bodyWeight: null, heightCm: null, ageYears: null, sex: null, secPerRep: 3, restSec: 90, volumeCorrection: true, efficiencyPct: 25,
  timerSound: true, keepAwake: true,
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
      backup: newBackupState(),
      calibVersion: CALIB_VERSION,
    };
  }
  return {
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    exercises: s.exercises || [],
    logs: s.logs || {},
    routines: s.routines || [],
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
// db 구조: data/users/<id>/meta (설정·운동목록·루틴), data/users/<id>/log-YYYY-MM (월별 기록)
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
    const months = new Set(Object.keys(state.logs).map(d => d.slice(0, 7)));
    months.forEach(m => cloudWrite(`log-${m}`, monthDoc(m)));
    [...cloud.ids].filter(id => id.startsWith('log-') && !months.has(id.slice(4)))
      .forEach(id => cloudWrite(id, null));
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(what)) {
    const m = what.slice(0, 7);
    cloudWrite(`log-${m}`, monthDoc(m));
  }
}

function monthDoc(m) {
  const days = {};
  for (const [d, list] of Object.entries(state.logs)) if (d.startsWith(m) && list.length) days[d] = list;
  return { days };
}

// 문서별로 한 번에 하나씩 순서대로 기록
function cloudWrite(id, body) {
  const ref = cloud.db.collection(cloud.col).doc(id);
  const empty = body && body.days && !Object.keys(body.days).length;
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
    const logs = {};
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
      }
    }
    state.logs = logs;
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
  const bmr = estimateBMR(state.settings);
  $('#bmr-line').classList.toggle('hidden', !bmr);
  if (!bmr) return;
  const net = Math.max(0, t.kcal - (bmr / 1440) * t.minutes);
  $('#bmr-line').innerHTML = `
    <div class="bmr-eq">
      <span><small>기초대사</small><b>${fmt(bmr)}</b></span><i>+</i>
      <span><small>운동(순)</small><b>${fmt(net)}</b></span><i>=</i>
      <span class="sum"><small>오늘 소모</small><b>${fmt(bmr + net)}</b></span>
    </div>
    <small class="muted">kcal · 출퇴근·집안일 등 일상 활동은 제외</small>`;
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

function renderStats() {
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

function alertTimer() {
  if (!state.settings.timerSound) return;
  try { if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 250]); } catch (e) { /* 진동 미지원 */ }
  const ctx = timer.audio;
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const at = t0 + i * 0.35;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.3);
    }
  } catch (e) { /* 소리 재생 불가 */ }
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
  keepScreenOn();
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
$('#c-delete').onclick = deleteCircuit;

$('#settings-form').onsubmit = saveSettings;
$('#export-btn').onclick = exportJson;
$('#csv-btn').onclick = exportCsv;
$('#import-input').onchange = importJson;
$('#reset-btn').onclick = resetAll;

render();
initCloud();

// 단독 PWA로 열 때만 오프라인 캐시 사용 (claude.ai 안에서는 window.claude가 있음)
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.claude) {
  navigator.serviceWorker.register('sw.js').catch(console.error);
}

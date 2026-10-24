'use strict';

const STORAGE_KEY = 'workout-tracker-v1';
const DEFAULT_SETTINGS = {
  bodyWeight: null, secPerRep: 3, restSec: 90, volumeCorrection: true, efficiencyPct: 25,
};

// ---------- 상태 ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function normalizeState(s) {
  if (!s) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      exercises: DEFAULT_EXERCISES.map(e => ({ id: uid(), ...e })),
      logs: {},
      calibVersion: CALIB_VERSION,
    };
  }
  return {
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    exercises: s.exercises || [],
    logs: s.logs || {},
    calibVersion: s.calibVersion || 1,
  };
}

// 기본 운동의 계수가 바뀌면 운동 목록과 지난 기록에 반영 (이름이 같은 기본 운동만)
function applyCalibration(s) {
  if (s.calibVersion >= CALIB_VERSION) return false;
  const byName = Object.fromEntries(DEFAULT_EXERCISES.map(e => [e.name, e]));
  s.exercises = s.exercises.map(e => {
    const d = byName[e.name];
    return d && d.type === e.type
      ? { ...e, met: d.met, rom: d.rom, bwFactor: d.bwFactor, refRatio: d.refRatio, src: d.src }
      : e;
  });
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
// db 구조: data/users/<id>/meta (설정·운동목록), data/users/<id>/log-YYYY-MM (월별 기록)
let cloud = null; // { db, col, ids:Set, writes:{} }

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 저장 불가 환경 */ }
}

// what: 'meta' | 'all' | 'YYYY-MM-DD' (변경된 날짜)
function save(what) {
  saveLocal();
  if (!cloud) return;
  if (what === 'meta' || what === 'all') {
    cloudWrite('meta', { settings: state.settings, exercises: state.exercises, calibVersion: state.calibVersion });
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
  toast.timer = setTimeout(() => t.classList.add('hidden'), 1800);
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
const VIEW_TITLES = { day: '오늘의 운동', stats: '통계', exercises: '운동 목록', settings: '설정' };
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

  const t = dayTotals(currentDate);
  $('#day-summary').innerHTML = `
    <div><b>${fmt(t.kcal)}</b><span>kcal</span></div>
    <div><b>${fmt(t.volume)}</b><span>볼륨 kg</span></div>
    <div><b>${fmt(t.sets)}</b><span>세트</span></div>
    <div><b>${fmt(t.minutes)}</b><span>분(추정)</span></div>`;

  const entries = state.logs[currentDate] || [];
  $('#day-empty').classList.toggle('hidden', entries.length > 0);
  const s = calcSettings();
  $('#entry-list').innerHTML = entries.map(e => {
    const r = estimateEntry(e, s);
    let detail;
    if (e.type === 'time') {
      detail = `<span class="set-chip">${fmt(e.minutes, 1)}분${e.km ? ` · ${fmt(e.km, 2)}km` : ''}</span>`;
    } else {
      detail = groupSets(e.sets).map(g =>
        `<span class="set-chip">${fmt(g.kg, 2)}kg × ${g.reps}회${g.count > 1 ? ` × ${g.count}세트` : ''}</span>`).join('');
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
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
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
    : Math.round(((ex.refRatio || 0) * s.bodyWeight) / 2.5) * 2.5;
  const kcal = estimateEntry({ ...ex, sets: [{ kg, reps: 10 }] }, s).total;
  return { kcal, label: `${kg ? `${fmt(kg, 1)}kg` : '맨몸'} × 10회${last ? ' (최근)' : ''}` };
}

// 운동 선택 시트
let pickCat = '전체';
function renderPickList() {
  catChips($('#pick-cat-chips'), pickCat, c => { pickCat = c; renderPickList(); });
  const list = filterExercises($('#pick-search').value, pickCat);
  const recent = recentExerciseIds();
  list.sort((a, b) => (recent.indexOf(a.id) + 1 || 999) - (recent.indexOf(b.id) + 1 || 999));
  $('#pick-list').innerHTML = list.map(e => `
    <li data-id="${e.id}"><div><span class="cat-tag">${esc(e.cat)}</span>${esc(e.name)}
    ${recent.includes(e.id) ? '<small class="muted">최근</small>' : ''}</div>
    <small class="muted nowrap">≈${fmt(previewKcal(e).kcal, 1)} kcal</small></li>`).join('')
    || '<li class="muted">검색 결과가 없습니다. 운동목록 탭에서 직접 추가할 수 있어요.</li>';
}

function recentExerciseIds() {
  const ids = [];
  for (const date of Object.keys(state.logs).sort().reverse()) {
    for (const e of state.logs[date]) if (!ids.includes(e.exId)) ids.push(e.exId);
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

function openEntryEditor(entry, isNew) {
  draft = JSON.parse(JSON.stringify(entry));
  draft.isNew = isNew;
  $('#entry-title').textContent = draft.name;
  $('#entry-note').value = draft.note || '';
  $('#entry-delete').classList.toggle('hidden', isNew);
  const isTime = draft.type === 'time';
  $('#strength-form').classList.toggle('hidden', isTime);
  $('#time-form').classList.toggle('hidden', !isTime);

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
    if (isNew && last) draft.sets = last.entry.sets.map(x => ({ ...x }));
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

function saveDraft() {
  draft.note = $('#entry-note').value.trim();
  if (draft.type === 'time') {
    if (!draft.minutes) return toast('운동 시간을 입력하세요');
  } else {
    draft.sets = draft.sets.filter(x => Number(x.reps) > 0);
    if (!draft.sets.length) return toast('최소 1세트를 입력하세요');
  }
  const { isNew, ...entry } = draft;
  const list = state.logs[currentDate] || (state.logs[currentDate] = []);
  if (isNew) list.push(entry);
  else list[list.findIndex(x => x.id === entry.id)] = entry;
  save(currentDate);
  closeSheets();
  draft = null;
  renderDay();
  toast('저장했습니다');
}

async function deleteDraft() {
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
        <small class="muted">${esc(p.label)} · MET ${e.met}${e.type === 'time' ? '' : ` · ROM ${e.rom ?? 0}m${e.bwFactor ? ` · 체중×${e.bwFactor}` : ''}`}</small>
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
  }
  if (!data.name) return;
  if (state.exercises.some(e => e.name === data.name && e.id !== editingExId)) return toast('같은 이름의 운동이 있습니다');
  if (editingExId) {
    const i = state.exercises.findIndex(e => e.id === editingExId);
    const old = state.exercises[i];
    const changed = ['met', 'rom', 'bwFactor'].some(k => (old[k] || 0) !== (data[k] || 0));
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
    secPerRep: Number(f.secPerRep.value) || DEFAULT_SETTINGS.secPerRep,
    restSec: Number(f.restSec.value) >= 0 ? Number(f.restSec.value) : DEFAULT_SETTINGS.restSec,
    volumeCorrection: f.volumeCorrection.checked,
    efficiencyPct: Number(f.efficiencyPct.value) || DEFAULT_SETTINGS.efficiencyPct,
  };
  save('meta');
  toast('설정을 저장했습니다');
}

async function download(filename, text, type) {
  // claude.ai 안에서는 downloads 기능으로, 일반 브라우저에서는 링크로 저장
  const dl = window.claude && window.claude.use ? await claude.use('downloads') : null;
  if (dl) {
    try { await dl.save({ filename, data: text }); } catch (e) {
      if (e && e.code !== 'declined') toast('파일을 저장하지 못했습니다');
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportJson() {
  download(`workout-backup-${ymd(new Date())}.json`, JSON.stringify(state, null, 2), 'application/json');
}

function exportCsv() {
  const s = calcSettings();
  const rows = [['날짜', '부위', '운동', '세트', 'kg', '회', '분', 'km', '추정kcal(운동별)', '메모']];
  for (const date of Object.keys(state.logs).sort()) {
    for (const e of state.logs[date]) {
      const kcal = estimateEntry(e, s).total.toFixed(1);
      if (e.type === 'time') rows.push([date, e.cat, e.name, '', '', '', e.minutes, e.km || '', kcal, e.note || '']);
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
  $('#pick-search').value = '';
  renderPickList();
  openSheet('#pick-sheet');
};
$('#pick-search').oninput = renderPickList;
$('#pick-list').onclick = ev => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const ex = state.exercises.find(e => e.id === li.dataset.id);
  openEntryEditor({
    id: uid(), exId: ex.id, name: ex.name, cat: ex.cat, type: ex.type, met: ex.met,
    rom: ex.rom || 0, bwFactor: ex.bwFactor || 0, sets: [], minutes: 0, km: 0, note: '',
  }, true);
};

$('#entry-list').onclick = ev => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const entry = (state.logs[currentDate] || []).find(e => e.id === li.dataset.id);
  if (entry) openEntryEditor(entry, false);
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
  draft.sets.push({ ...last });
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

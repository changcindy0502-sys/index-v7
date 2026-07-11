/* =========================================================
   恢復室病人運送管理系統 - app.js
   ========================================================= */

const API_URL = 'https://script.google.com/macros/s/AKfycbw8iTwSNz0f2vBIgJGZZWO9CuFRFVO16Db1dHKOnCjgVwRE3Bal8V6R1jb5qQ07KsF4gQ/exec';

const POR_BEDS = Array.from({ length: 18 }, (_, i) => 'POR-' + String(i + 1).padStart(2, '0'));
const REFRESH_INTERVAL = 30000; // 30 秒

// 「已完成」清單的每日清空時間（24小時制，0 = 午夜00:00）
// 已完成清單只會顯示「這個時間點之後」完成的紀錄，過了這個時間點就會自動清空重新計算
// 如需改成其他時間（例如早上6點），把 0 改成 6 即可
const COMPLETED_LIST_RESET_HOUR = 0;

const QUICK_PHRASES = [
  '使用氧氣筒返室',
  '照完X光',
  '有檢體在病歷',
  '感染隔離',
  '沒有家屬'
];

let allRecords = [];
let currentTab = 'waiting';
let countdownTimer = null;
let refreshTimer = null;
let statsRange = null; // 'today' | 'week' | 'month' | 'custom'
let lastStatsData = null;
let lastStatsRangeStr = { start: '', end: '' };
// 暫存「剛新增、尚未從API確認回來」的病房床號，避免快速連續送出造成重複
const pendingWardBeds = new Set();
const pendingPushBedWards = new Set();

/* ===================== 初始化 ===================== */

document.addEventListener('DOMContentLoaded', () => {
  populatePorBedOptions();
  populateQuickPhrases();
  setDefaultArrivalTime();
  bindEvents();
  fetchAll();
  startAutoRefresh();
  startCountdownTicker();
  registerServiceWorker();
});

function populatePorBedOptions() {
  const select = document.getElementById('porBed');
  POR_BEDS.forEach(bed => {
    const opt = document.createElement('option');
    opt.value = bed;
    opt.textContent = bed;
    select.appendChild(opt);
  });
}

// 依目前佔床狀況，把已經有病人在「待運送」中的 POR 床反白（disabled）並標註「使用中」，
// 避免人員誤選已經有人在使用的床位
function updatePorBedAvailability() {
  const select = document.getElementById('porBed');
  const options = select.querySelectorAll('option[value^="POR-"]');
  let selectedNowOccupied = false;

  options.forEach(opt => {
    const bed = opt.value;
    const occupied = allRecords.some(r => r['POR床號'] === bed && r['狀態'] === '待運送' && r['項目類型'] !== '推床');
    opt.disabled = occupied;
    opt.textContent = occupied ? `${bed}（使用中）` : bed;
    if (occupied && select.value === bed) selectedNowOccupied = true;
  });

  // 如果背景刷新時，剛好使用者選到的床變成佔用中，清空選擇並提醒，避免誤送出
  if (selectedNowOccupied) {
    select.value = '';
    showToast('您選擇的 POR 床剛被佔用，請重新選擇', 'error');
  }
}

function populateQuickPhrases() {
  const container = document.getElementById('quickPhrases');
  container.innerHTML = QUICK_PHRASES.map(p =>
    `<span class="quick-phrase" data-phrase="${escapeHtml(p)}" onclick="togglePhrase(this)">${escapeHtml(p)}</span>`
  ).join('');
}

function togglePhrase(el) {
  el.classList.toggle('active');
  const textarea = document.getElementById('note');
  const active = Array.from(document.querySelectorAll('.quick-phrase.active')).map(e => e.dataset.phrase);

  // 取出目前手動輸入的內容（不在快速片語清單中的部分）
  const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l);
  const manual = lines.filter(l => !QUICK_PHRASES.includes(l));

  textarea.value = [...active, ...manual].join('\n');
}

function setDefaultArrivalTime() {
  const input = document.getElementById('arrivalTime');
  input.value = toLocalInputValue(new Date());
  updateExpectedLeavePreview();
}

// 點擊到達時間欄位時，重新帶入現在時間，方便直接選取（不用往前捲動選擇日期/時間）
function refreshArrivalTimeToNow() {
  setDefaultArrivalTime();
}

function bindEvents() {
  document.getElementById('arrivalTime').addEventListener('change', updateExpectedLeavePreview);
  // 只要點進到達時間欄位，就先帶入現在時間供選取，避免表單放著太久時間過期
  document.getElementById('arrivalTime').addEventListener('focus', refreshArrivalTimeToNow);
  document.getElementById('addForm').addEventListener('submit', handleAddSubmit);
  document.getElementById('searchInput').addEventListener('input', renderCurrentTab);
  document.getElementById('wardBed').addEventListener('blur', (e) => {
    const formatted = formatWardBed(e.target.value);
    e.target.value = formatted;
    checkWardBedDuplicate(formatted);
  });
  document.getElementById('pushBedForm').addEventListener('submit', handlePushBedSubmit);
  document.getElementById('pushWardBed').addEventListener('blur', (e) => {
    e.target.value = formatWardBed(e.target.value);
  });
  document.getElementById('editForm').addEventListener('submit', handleEditSubmit);
  document.getElementById('editWardBed').addEventListener('blur', (e) => {
    e.target.value = formatWardBed(e.target.value);
  });
}

/* ===================== 病房床號自動格式化 ===================== */

// 規則：輸入純數字時，若最後一位是 1/2/3，則自動轉成「前面數字-最後一位」
// 例：11121 -> 1112-1 ；15093 -> 1509-3 ；12 -> 1-2 ；其他格式不變
function formatWardBed(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return trimmed;

  // 已含有 "-" 或非純數字，不處理
  if (!/^\d+$/.test(trimmed)) return trimmed;

  // 4位數字 = 單人套房床號，直接顯示，不加 "-"
  if (trimmed.length === 4) {
    return trimmed;
  }

  // 5位數字：最後一位為 1/2/3 時，轉換為「前4碼-之X」格式
  if (trimmed.length === 5) {
    const last = trimmed.slice(-1);
    const prefix = trimmed.slice(0, -1);
    if (['1', '2', '3'].includes(last)) {
      return `${prefix}-${last}`;
    }
  }

  // 其他長度或不符合規則，不轉換
  return trimmed;
}

/* ===================== 時間工具 ===================== */

function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDate(str) {
  if (!str) return null;
  return new Date(str.replace(' ', 'T'));
}

function formatTime(date) {
  if (!date) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(date) {
  if (!date) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateExpectedLeavePreview() {
  const arrivalVal = document.getElementById('arrivalTime').value;
  if (!arrivalVal) {
    document.getElementById('expectedLeavePreview').textContent = '—';
    return;
  }
  const arrival = new Date(arrivalVal);
  const leave = new Date(arrival.getTime() + 45 * 60 * 1000);
  document.getElementById('expectedLeavePreview').textContent = formatTime(leave);
}

/* ===================== Toast ===================== */

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✅', error: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = 'toast rounded-full px-5 py-2.5 text-sm font-bold shadow-lg flex items-center gap-2';
  toast.innerHTML = `<span>${icons[type] || icons.info}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/* ===================== API 呼叫 ===================== */

async function apiGet(action) {
  const res = await fetch(`${API_URL}?action=${action}`);
  return res.json();
}

async function apiGetStats(start, end) {
  const params = new URLSearchParams({ action: 'stats' });
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const res = await fetch(`${API_URL}?${params.toString()}`);
  return res.json();
}

async function apiPost(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  return res.json();
}

/* ===================== 資料抓取 / 同步 ===================== */

async function fetchAll(isManual) {
  setSyncStatus('syncing', isManual);
  try {
    // 效能優化：改用單次合併查詢（listAndDashboard），
    // 避免分別呼叫 list + dashboard 造成Google Sheet被讀取兩次，減少延遲。
    const res = await apiGet('listAndDashboard');

    if (res.success) {
      allRecords = res.data;
      pendingWardBeds.clear();
      pendingPushBedWards.clear();
      renderCurrentTab();
      renderPushBedList();
      updatePorBedAvailability();
      cacheRecordsOffline(allRecords);

      if (res.dashboard) {
        renderDashboard(res.dashboard);
      }
    } else {
      showToast('讀取資料失敗：' + (res.message || ''), 'error');
    }

    setSyncStatus('done', isManual);
  } catch (err) {
    setSyncStatus('error', isManual);
    showToast('連線失敗，請檢查網路或 API 設定', 'error');
    loadCachedRecords();
  }
}

function setSyncStatus(state, isManual) {
  const icon = document.getElementById('syncIcon');
  const lastUpdated = document.getElementById('lastUpdated');
  if (!icon) return;
  if (state === 'syncing') {
    icon.classList.add('spin');
  } else if (state === 'done') {
    icon.classList.remove('spin');
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    lastUpdated.textContent = `最後更新: ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // 只在手動點擊「更新」時顯示提示，自動背景刷新不打擾使用者
    if (isManual) {
      showToast('資料已更新', 'success');
    }
  } else {
    icon.classList.remove('spin');
    lastUpdated.textContent = '離線（顯示快取資料）';
  }
}

function manualRefresh() {
  fetchAll(true);
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchAll, REFRESH_INTERVAL);
}

function startCountdownTicker() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (currentTab === 'waiting') renderWaitingList();
  }, 10000);
}

/* ===================== 離線快取 ===================== */

function cacheRecordsOffline(records) {
  try {
    localStorage.setItem('por_records_cache', JSON.stringify(records));
    localStorage.setItem('por_records_cache_time', new Date().toISOString());
  } catch (e) { /* ignore */ }
}

function loadCachedRecords() {
  try {
    const cached = localStorage.getItem('por_records_cache');
    if (cached) {
      allRecords = JSON.parse(cached);
      renderCurrentTab();
      renderPushBedList();
      updatePorBedAvailability();
    }
  } catch (e) { /* ignore */ }
}

/* ===================== Tabs ===================== */

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('waitingPanel').classList.toggle('hidden', tab !== 'waiting');
  document.getElementById('lobbyPanel').classList.toggle('hidden', tab !== 'lobby');
  document.getElementById('completedPanel').classList.toggle('hidden', tab !== 'completed');
  document.getElementById('statsPanel').classList.toggle('hidden', tab !== 'stats');
  document.getElementById('searchWrapper').classList.toggle('hidden', tab === 'stats');
  if (tab === 'stats') {
    if (!statsRange) setStatsRange('today');
    else loadStats();
  } else {
    renderCurrentTab();
  }
}

function renderCurrentTab() {
  if (currentTab === 'waiting') {
    renderWaitingList();
  } else if (currentTab === 'lobby') {
    renderLobbyList();
  } else {
    renderCompletedList();
  }
}

/* ===================== Dashboard ===================== */

function renderDashboard(d) {
  document.getElementById('dashWaiting').textContent = d.waitingCount;
  document.getElementById('dashToday').textContent = d.todayCompleted;
  document.getElementById('dashSmall').textContent = d.smallBed;
  document.getElementById('dashLarge').textContent = d.largeBed;
  document.getElementById('dashAvgStay').textContent = d.avgStay;
}

/* ===================== 搜尋比對工具 ===================== */

function matchesKeyword(r, keyword) {
  if (!keyword) return true;
  const por = (r['POR床號'] || '').toString().toLowerCase();
  const ward = (r['病房床號'] || '').toString().toLowerCase();
  return por.includes(keyword) || ward.includes(keyword);
}

function getKeyword() {
  return document.getElementById('searchInput').value.trim().toLowerCase();
}

// 計算「已完成」清單目前這一輪的清空邊界時間
// 例如 COMPLETED_LIST_RESET_HOUR = 0（午夜），現在是 7/3 08:00 → 邊界是 7/3 00:00
// 若現在是 7/3 23:00，邊界仍是 7/3 00:00；到了 7/4 00:00 一過，邊界就自動變成 7/4 00:00（等於清空）
function getCompletedListResetBoundary() {
  const now = new Date();
  const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), COMPLETED_LIST_RESET_HOUR, 0, 0, 0);
  if (now.getTime() < boundary.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}

/* ===================== 待運送清單 ===================== */

function getWaitingRecords() {
  const keyword = getKeyword();
  let records = allRecords.filter(r => r['項目類型'] !== '推床' && r['狀態'] === '待運送');
  if (keyword) {
    records = records.filter(r => matchesKeyword(r, keyword));
  }
  records.sort((a, b) => {
    const da = parseDate(a['預計離開時間']);
    const db_ = parseDate(b['預計離開時間']);
    return (da ? da.getTime() : 0) - (db_ ? db_.getTime() : 0);
  });
  return records;
}

function getStatusLevel(expectedLeave) {
  const now = new Date();
  const diffMin = (expectedLeave.getTime() - now.getTime()) / 60000;
  if (diffMin < 0) return 'red';
  if (diffMin <= 10) return 'yellow';
  return 'green';
}

function renderWaitingList() {
  const records = getWaitingRecords();
  const container = document.getElementById('waitingList');
  const empty = document.getElementById('waitingEmpty');
  document.getElementById('waitingTabCount').textContent = records.length > 0 ? `(${records.length})` : '';

  if (records.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = records.map(r => {
    const porNum = (r['POR床號'] || '').replace('POR-', '');
    const arrival = parseDate(r['到達時間']);
    const expected = parseDate(r['預計離開時間']);
    const level = expected ? getStatusLevel(expected) : 'green';
    let badgeClass = { green: 'bed-green', yellow: 'bed-yellow', red: 'bed-red' }[level];

    // 若病房床號與「待推大床」清單中尚未推送的床號相同，強制以紅色提示尚有床需先推
    // 大床類型不需提示（病人已躺在大床上，不用再推）
    const pendingPushBeds = allRecords.filter(rec => rec['項目類型'] === '推床' && rec['狀態'] === '待推送' && !rec['推送位置']);
    const wardBedMatch = r['床位類型'] !== '大床' &&
      pendingPushBeds.some(rec => String(fixWardBedDisplay(rec['病房床號'])) === String(fixWardBedDisplay(r['病房床號'])));
    let pushAlert = '';
    if (wardBedMatch) {
      badgeClass = 'bed-red';
      pushAlert = `<p class="text-xs font-bold text-[var(--rose-500)] mt-1">⚠️ 此病房床號的大床尚待推送，請先確認推床</p>`;
    }

    // 連動：若「待推大床」清單中相同病房床號的推床已被標記推送位置，
    // 此待運送項目需自動顯示對應狀態（已推到-大廳 / 大床在恢復室），不需工作人員再手動選取
    // 注意：只看「還沒完成」的推床紀錄，排除已完成的歷史紀錄，避免同一床號舊資料的痕跡被誤判成目前狀態
    const pushedToLobbyRecord = r['床位類型'] !== '大床' &&
      allRecords.find(rec =>
        rec['項目類型'] === '推床' &&
        rec['狀態'] !== '已完成' &&
        rec['推送位置'] === '大廳' &&
        String(fixWardBedDisplay(rec['病房床號'])) === String(fixWardBedDisplay(r['病房床號']))
      );
    const pushedToRecoveryRecord = r['床位類型'] !== '大床' &&
      allRecords.find(rec =>
        rec['項目類型'] === '推床' &&
        rec['狀態'] !== '已完成' &&
        rec['推送位置'] === '恢復室' &&
        String(fixWardBedDisplay(rec['病房床號'])) === String(fixWardBedDisplay(r['病房床號']))
      );
    const pushedToLobbyBadge = pushedToLobbyRecord
      ? `<span class="pill" style="background:#e3f4ee;color:var(--green-600);">🛏️ 已推到-大廳</span>`
      : '';
    const pushedToRecoveryBadge = pushedToRecoveryRecord
      ? `<span class="pill" style="background:#e3edf7;color:var(--teal-700);">🛏️ 大床在恢復室</span>`
      : '';

    const now = new Date();
    const diffMin = expected ? Math.round((expected.getTime() - now.getTime()) / 60000) : 0;
    const elapsedMin = arrival ? Math.round((now.getTime() - arrival.getTime()) / 60000) : 0;

    let statusLabel, statusClass;
    if (diffMin < 0) {
      statusLabel = `超時 ${Math.abs(diffMin)} 分`;
      statusClass = 'text-[var(--rose-500)]';
    } else {
      statusLabel = `剩餘 ${diffMin} 分`;
      statusClass = level === 'yellow' ? 'text-[var(--amber-500)]' : 'text-[var(--green-600)]';
    }

    const isSmall = r['床位類型'] === '小床';
    const isLarge = r['床位類型'] === '大床';
    const wardBedClass = isSmall ? 'ward-bed-text ward-bed-small-bg' : 'ward-bed-text';
    const typePillClass = isLarge ? 'pill pill-waiting-large' : 'pill pill-waiting-small';
    const typePillStyle = 'font-size:1.15rem; padding:.2rem .75rem;';

    const note = r['備註'] ? `<p class="text-xs text-gray-400 mt-1">📋 ${escapeHtml(r['備註']).replace(/\n/g, '、')}</p>` : '';

    return `
      <div class="card p-4 flex items-center gap-4">
        <div class="por-badge ${badgeClass}">
          <div class="label">POR</div>
          <div class="num">${escapeHtml(porNum)}</div>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-400 mb-0.5 waiting-item-label">病房床號 / 類型</p>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="${wardBedClass}">${escapeHtml(fixWardBedDisplay(r['病房床號']) || '—')}</span>
            <span class="${typePillClass}" style="${typePillStyle}">${escapeHtml(r['床位類型'] || '')}</span>
            ${pushedToLobbyBadge}
            ${pushedToRecoveryBadge}
          </div>
          <p class="text-gray-500 mt-1 waiting-item-text">
            到達: ${formatTime(arrival)} <span class="text-gray-300">|</span> 預計: ${formatTime(expected)}
          </p>
          ${note}
          ${pushAlert}
        </div>
        <div class="text-right flex-shrink-0 flex flex-col items-end gap-2">
          <p class="font-bold ${statusClass} waiting-item-text">${statusLabel}</p>
          <p class="text-gray-400 waiting-item-label">已等候: ${elapsedMin} 分鐘</p>
          <div class="flex gap-2">
            <button onclick='openEditModal(${JSON.stringify(r).replace(/'/g, "&#39;")})' class="btn-edit">✏️ 編輯</button>
            <button onclick="openCompleteModal('${r.ID}', '${escapeHtml(r['POR床號'])}', '${escapeHtml(fixWardBedDisplay(r['病房床號']) || '')}')" class="btn-complete">🚀 接送完成</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* ===================== 大廳候床清單 ===================== */

function getLobbyRecords() {
  const keyword = getKeyword();
  // 大廳候床：只要狀態是「已完成」（接送完成 或 推床已移除）就一律不再顯示於大廳，
  // 不論當初的狀態文字是「待運送」「已推送」還是其他中繼狀態
  let records = allRecords.filter(r => r['推送位置'] === '大廳' && r['狀態'] !== '已完成');
  if (keyword) {
    records = records.filter(r => matchesKeyword(r, keyword));
  }
  records.sort((a, b) => (a['病房床號'] || '').localeCompare(b['病房床號'] || ''));
  return records;
}

function renderLobbyList() {
  const records = getLobbyRecords();
  const container = document.getElementById('lobbyList');
  const empty = document.getElementById('lobbyEmpty');
  document.getElementById('lobbyTabCount').textContent = records.length > 0 ? `(${records.length})` : '';

  if (records.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = records.map(r => {
    const isPushBed = r['項目類型'] === '推床';
    const isSmall = r['床位類型'] === '小床';
    const wardBedClass = isSmall ? 'ward-bed-text ward-bed-small-bg' : 'ward-bed-text';
    const typePillClass = r['床位類型'] === '大床' ? 'pill pill-large' : 'pill pill-small';
    const porNum = (r['POR床號'] || '').replace('POR-', '');

    const porBadge = porNum ? `
      <div class="por-badge bed-green">
        <div class="label">POR</div>
        <div class="num">${escapeHtml(porNum)}</div>
      </div>` : `
      <div class="por-badge" style="background:#9aa6a3;">
        <div class="label">推床</div>
        <div class="num">—</div>
      </div>`;

    return `
      <div class="card p-4 flex items-center gap-4">
        ${porBadge}
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-400 mb-0.5">病房床號 / 類型</p>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="${wardBedClass}">${escapeHtml(fixWardBedDisplay(r['病房床號']) || '—')}</span>
            <span class="${typePillClass}">${escapeHtml(r['床位類型'] || '')}</span>
          </div>
          <p class="text-sm text-gray-500 mt-1">目前位置：<span class="font-bold">大廳候床</span></p>
        </div>
        <div class="text-right flex-shrink-0">
          <button onclick="moveToRecoveryRoom('${r.ID}', ${isPushBed})" class="btn-complete">已推到恢復室</button>
        </div>
      </div>
    `;
  }).join('');
}

async function moveToRecoveryRoom(id, isPushBed) {
  try {
    let res;
    if (isPushBed) {
      // 推床送達恢復室後視為完成，狀態、推送位置、完成時間一併更新，
      // 避免床號一直卡在中繼狀態，也讓它之後能被每日封存機制正確清走
      const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      res = await apiPost({ action: 'update', id, fields: { '推送位置': '恢復室', '狀態': '已完成', '完成時間': nowStr } });
    } else {
      res = await apiPost({ action: 'setTransportLocation', id, location: '恢復室' });
    }
    if (res.success) {
      showToast('已標記為：恢復室', 'success');
      fetchAll();
    } else {
      showToast(res.message || '操作失敗', 'error');
    }
  } catch (err) {
    showToast('連線失敗，請稍後再試', 'error');
  }
}

/* ===================== 已完成清單 ===================== */

function getCompletedRecords() {
  const keyword = getKeyword();
  const resetBoundary = getCompletedListResetBoundary();
  let records = allRecords.filter(r => r['項目類型'] !== '推床' && r['狀態'] === '已完成');
  // 已完成清單每日定時清空（預設午夜00:00）：只顯示邊界時間之後完成的紀錄
  records = records.filter(r => {
    const complete = parseDate(r['完成時間']);
    return complete && complete.getTime() >= resetBoundary.getTime();
  });
  if (keyword) {
    records = records.filter(r => matchesKeyword(r, keyword));
  }
  records.sort((a, b) => {
    const da = parseDate(a['完成時間']);
    const db_ = parseDate(b['完成時間']);
    return (db_ ? db_.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return records;
}

function renderCompletedList() {
  const records = getCompletedRecords();
  const container = document.getElementById('completedList');
  const empty = document.getElementById('completedEmpty');
  document.getElementById('completedTabCount').textContent = records.length > 0 ? `(${records.length})` : '';

  if (records.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = records.map(r => {
    const porNum = (r['POR床號'] || '').replace('POR-', '');
    const arrival = parseDate(r['到達時間']);
    const complete = parseDate(r['完成時間']);
    let stay = '—';
    if (arrival && complete) {
      stay = Math.round((complete.getTime() - arrival.getTime()) / 60000) + ' 分';
    }
    const isSmall = r['床位類型'] === '小床';
    const wardBedClass = isSmall ? 'ward-bed-text ward-bed-small-bg' : 'ward-bed-text';
    const typePillClass = r['床位類型'] === '大床' ? 'pill pill-large' : 'pill pill-small';

    return `
      <div class="card p-4 flex items-center gap-4">
        <div class="por-badge bed-green" style="background:#9aa6a3;">
          <div class="label">POR</div>
          <div class="num">${escapeHtml(porNum)}</div>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-400 mb-0.5">病房床號 / 類型</p>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="${wardBedClass}">${escapeHtml(fixWardBedDisplay(r['病房床號']) || '—')}</span>
            <span class="${typePillClass}">${escapeHtml(r['床位類型'] || '')}</span>
          </div>
          <p class="text-sm text-gray-500 mt-1">完成時間: ${formatDateTime(complete)}</p>
          ${r['備註'] ? `<p class="text-xs text-gray-400 mt-1">📋 ${escapeHtml(r['備註']).replace(/\n/g, '、')}</p>` : ''}
        </div>
        <div class="text-right flex-shrink-0 flex flex-col items-end gap-2">
          <p class="font-bold text-[var(--green-600)]">已完成</p>
          <p class="text-xs text-gray-400">停留: ${stay}</p>
          <button onclick='openEditModal(${JSON.stringify(r).replace(/'/g, "&#39;")})' class="btn-edit">✏️ 編輯</button>
        </div>
      </div>
    `;
  }).join('');
}

/* ===================== 編輯已完成項目 ===================== */

function openEditModal(record) {
  document.getElementById('editId').value = record.ID;
  document.getElementById('editPorBed').value = record['POR床號'] || '';
  document.getElementById('editBedType').value = record['床位類型'] || '小床';
  document.getElementById('editWardBed').value = fixWardBedDisplay(record['病房床號']) || '';
  document.getElementById('editNote').value = record['備註'] || '';
  // 預計離開時間預填（可修改）；若原始資料格式異常導致無法解析，留空避免顯示無效值
  const expectedLeave = parseDate(record['預計離開時間']);
  const validExpectedLeave = expectedLeave && !isNaN(expectedLeave.getTime()) ? expectedLeave : null;
  document.getElementById('editExpectedLeave').value = validExpectedLeave ? toLocalInputValue(validExpectedLeave) : '';
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('editModal').classList.add('hidden');
}

// 快速調整「預計離開時間」，作為原生 datetime-local 選擇器在部分裝置上操作不順時的備援方式
function adjustEditExpectedLeave(deltaMinutes) {
  const input = document.getElementById('editExpectedLeave');
  const base = input.value ? new Date(input.value) : new Date();
  const baseValid = !isNaN(base.getTime()) ? base : new Date();
  const updated = new Date(baseValid.getTime() + deltaMinutes * 60000);
  input.value = toLocalInputValue(updated);
}

function resetEditExpectedLeaveToNowPlus45() {
  document.getElementById('editExpectedLeave').value = toLocalInputValue(new Date(Date.now() + 45 * 60000));
}

async function handleEditSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const expectedLeaveVal = document.getElementById('editExpectedLeave').value;

  const fields = {
    'POR床號': document.getElementById('editPorBed').value,
    '床位類型': document.getElementById('editBedType').value,
    '病房床號': formatWardBed(document.getElementById('editWardBed').value),
    '備註': document.getElementById('editNote').value
  };

  // 只有有填預計離開時間才更新
  if (expectedLeaveVal) {
    fields['預計離開時間'] = new Date(expectedLeaveVal).toISOString().replace('T', ' ').substring(0, 19);
  }

  try {
    const res = await apiPost({ action: 'update', id, fields });
    if (res.success) {
      showToast('已儲存修改', 'success');
      closeEditModal();
      fetchAll();
    } else {
      showToast(res.message || '儲存失敗', 'error');
    }
  } catch (err) {
    showToast('連線失敗，請稍後再試', 'error');
  }
}

/* ===================== 新增病人 ===================== */

async function handleAddSubmit(e) {
  e.preventDefault();
  const porBed = document.getElementById('porBed').value;
  const wardBedInput = document.getElementById('wardBed');
  const wardBed = formatWardBed(wardBedInput.value.trim());
  wardBedInput.value = wardBed;
  const bedType = document.getElementById('bedType').value;
  const arrivalVal = document.getElementById('arrivalTime').value;
  const note = document.getElementById('note').value.trim();

  if (!porBed) {
    showToast('請選擇 POR床號', 'error');
    return;
  }

  const occupied = allRecords.find(r => r['POR床號'] === porBed && r['狀態'] === '待運送' && r['項目類型'] !== '推床');
  if (occupied) {
    showToast(`${porBed} 目前已有病人，請先完成接送`, 'error');
    return;
  }

  // 防呆：病房床號不可與「待運送」清單中已存在的床號重複
  if (wardBed && checkWardBedDuplicate(wardBed)) {
    return;
  }

  if (wardBed) pendingWardBeds.add(wardBed);

  const btn = document.getElementById('addSubmitBtn');
  btn.disabled = true;
  btn.textContent = '處理中...';

  try {
    const res = await apiPost({
      action: 'add',
      porBed,
      wardBed,
      bedType,
      arrivalTime: new Date(arrivalVal).toISOString(),
      note
    });
    if (res.success) {
      // 小床病人若已填寫病房床號，自動建立「待推大床」需求，
      // 不需工作人員再到下方表單手動重複輸入一次
      let pushBedCreated = false;
      if (bedType === '小床' && wardBed) {
        const dup = allRecords.find(rec =>
          rec['項目類型'] === '推床' &&
          rec['狀態'] !== '已完成' &&
          String(fixWardBedDisplay(rec['病房床號'])) === String(wardBed)
        );
        if (!dup && !pendingPushBedWards.has(wardBed)) {
          pendingPushBedWards.add(wardBed);
          try {
            const pushRes = await apiPost({ action: 'addPushBed', wardBed });
            pushBedCreated = !!(pushRes && pushRes.success);
            if (!pushBedCreated) pendingPushBedWards.delete(wardBed);
          } catch (pushErr) {
            pendingPushBedWards.delete(wardBed);
          }
        }
      }

      showToast(pushBedCreated ? '已加入待運送清單，並自動建立待推大床需求' : '已加入待運送清單', 'success');
      document.getElementById('porBed').value = '';
      wardBedInput.value = '';
      document.getElementById('note').value = '';
      document.querySelectorAll('.quick-phrase.active').forEach(el => el.classList.remove('active'));
      setDefaultArrivalTime();
      fetchAll();
    } else {
      if (wardBed) pendingWardBeds.delete(wardBed);
      showToast(res.message || '新增失敗', 'error');
    }
  } catch (err) {
    if (wardBed) pendingWardBeds.delete(wardBed);
    showToast('連線失敗，請稍後再試', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '➕ 加入待運送清單';
  }
}

/* ===================== 接送完成 ===================== */

function openCompleteModal(id, porBed, wardBed) {
  document.getElementById('completeModalDesc').textContent =
    `${porBed} → ${wardBed || '（未填病房床號）'}，確認後將釋放此 POR 床位`;
  document.getElementById('completeModal').classList.remove('hidden');

  const btn = document.getElementById('completeConfirmBtn');
  btn.onclick = () => confirmComplete(id);
}

function closeCompleteModal() {
  document.getElementById('completeModal').classList.add('hidden');
}

async function confirmComplete(id) {
  const btn = document.getElementById('completeConfirmBtn');
  btn.disabled = true;
  btn.textContent = '處理中...';
  try {
    const res = await apiPost({ action: 'complete', id });
    if (res.success) {
      showToast('已完成接送，床位已釋放', 'success');
      closeCompleteModal();
      fetchAll();
    } else {
      showToast(res.message || '操作失敗', 'error');
    }
  } catch (err) {
    showToast('連線失敗，請稍後再試', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '確認完成';
  }
}

/* ===================== 待推大床 ===================== */

function getPushBedRecords() {
  // 只有「還沒被推到任何位置」的才算真正待推送；一旦推送位置被標記（大廳／恢復室），
  // 就不再佔用待推大床清單，讓同一個病房床號可以重新新增推床需求
  return allRecords.filter(r => r['項目類型'] === '推床' && r['狀態'] === '待推送' && !r['推送位置']);
}

function renderPushBedList() {
  const records = getPushBedRecords();
  const container = document.getElementById('pushBedList');
  const empty = document.getElementById('pushBedEmpty');

  if (records.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  container.innerHTML = records.map(r => {
    // 若有相同病房床號在「待運送」清單，床號顯示紅色背景提示
    const matchedInWaiting = allRecords.some(rec =>
      rec['項目類型'] !== '推床' &&
      rec['狀態'] === '待運送' &&
      String(fixWardBedDisplay(rec['病房床號'])) === String(fixWardBedDisplay(r['病房床號']))
    );
    const wardBedStyle = matchedInWaiting
      ? 'font-size:1rem; background:#fbe3e1; color:var(--rose-500); border-radius:6px; padding:.15rem .5rem; font-weight:800;'
      : 'font-size:1rem;';
    const alert = matchedInWaiting
      ? `<p class="text-xs font-bold text-[var(--rose-500)] mt-1">⚠️ 此床病人已在恢復室，請優先推此大床</p>`
      : '';

    return `
      <div class="card p-3 flex items-center justify-between gap-2" style="background:#f7f8f3;">
        <div>
          <span class="ward-bed-text" style="${wardBedStyle}">${escapeHtml(fixWardBedDisplay(r['病房床號']))}</span>
          <span class="ml-2 pill" style="background:#fdf3d3;color:#a9802e;">待推送</span>
          ${alert}
          <div class="flex gap-1 mt-2">
            <button onclick="setPushBedLocation('${r.ID}', '大廳')" class="loc-select" style="cursor:pointer;">推到大廳</button>
            <button onclick="setPushBedLocation('${r.ID}', '恢復室')" class="loc-select" style="cursor:pointer;">推到恢復室</button>
          </div>
        </div>
        <button onclick="completePushBed('${r.ID}')" class="btn-edit" style="padding:.35rem .8rem;">移除</button>
      </div>
    `;
  }).join('');
}

async function handlePushBedSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('pushWardBed');
  const wardBed = formatWardBed(input.value.trim());
  input.value = wardBed;

  if (!wardBed) {
    showToast('請輸入病房床號', 'error');
    return;
  }

  // 防重複的唯一規則：只要該床號還有一筆「狀態 ≠ 已完成」的推床紀錄，就視為佔用
  // （不管在待推送、還是已推到大廳/恢復室，只要還沒完成都算佔用；跟後端邏輯統一）
  const duplicate = allRecords.find(r =>
    r['項目類型'] === '推床' &&
    r['狀態'] !== '已完成' &&
    String(fixWardBedDisplay(r['病房床號'])) === String(wardBed)
  );
  if (duplicate || pendingPushBedWards.has(wardBed)) {
    showToast(`床號 ${wardBed} 已在待推大床清單中，請勿重複新增`, 'error');
    return;
  }

  pendingPushBedWards.add(wardBed);

  try {
    const res = await apiPost({ action: 'addPushBed', wardBed });
    if (res.success) {
      showToast('已加入待推大床清單', 'success');
      input.value = '';
      fetchAll();
    } else {
      pendingPushBedWards.delete(wardBed);
      showToast(res.message || '新增失敗', 'error');
    }
  } catch (err) {
    pendingPushBedWards.delete(wardBed);
    showToast('連線失敗，請稍後再試', 'error');
  }
}

async function setPushBedLocation(id, location) {
  try {
    const res = await apiPost({ action: 'setPushLocation', id, location });
    if (res.success) {
      showToast(`已標記為：${location}` + (location === '大廳' ? '（顯示於大廳候床）' : ''), 'success');
      fetchAll();
    } else {
      showToast(res.message || '操作失敗', 'error');
    }
  } catch (err) {
    showToast('連線失敗，請稍後再試', 'error');
  }
}

async function completePushBed(id) {
  try {
    // 補上完成時間，讓這筆紀錄之後能被每日午夜的封存機制正確清走，不會一直卡在主表
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const res = await apiPost({ action: 'update', id, fields: { '狀態': '已完成', '完成時間': nowStr } });
    if (res.success) {
      showToast('已完成，從清單中移除', 'success');
      fetchAll();
    } else {
      showToast(res.message || '操作失敗', 'error');
    }
  } catch (err) {
    showToast('連線失敗，請稍後再試', 'error');
  }
}

/* ===================== 工具 ===================== */

// 即時檢查病房床號是否已在「待運送」清單中重複，並顯示提示
function checkWardBedDuplicate(wardBed) {
  if (!wardBed) return false;
  if (pendingWardBeds.has(wardBed)) {
    showToast(`病房床號 ${wardBed} 已在待運送清單中，請確認是否重複`, 'error');
    return true;
  }
  const duplicate = allRecords.find(r =>
    r['項目類型'] !== '推床' &&
    r['狀態'] === '待運送' &&
    String(fixWardBedDisplay(r['病房床號'])) === String(wardBed)
  );
  if (duplicate) {
    showToast(`病房床號 ${wardBed} 已在待運送清單中，請確認是否重複`, 'error');
    return true;
  }
  return false;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 修正被Google Sheet誤判為日期的病房床號，例如 "1112-02-23T00:00:00" -> "1112-2"
// 規則：偵測 "YYYY-MM-DDTHH:mm:ss" 或 "YYYY-MM-DD" 格式，取年份當前段、月份去掉前導0當之X
function fixWardBedDisplay(value) {
  if (!value) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-\d{2}(T\d{2}:\d{2}:\d{2})?$/);
  if (m) {
    const prefix = m[1];
    const suffix = parseInt(m[2], 10); // 去掉前導0
    if (suffix >= 1 && suffix <= 3) {
      return `${prefix}-${suffix}`;
    }
    return prefix;
  }
  return str;
}

/* ===================== 統計報表 ===================== */

function toDateInputValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 依預設區間（today/week/month）回傳 { start, end } Date 物件（本地時區，當天 00:00 起算）
function getStatsPresetRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start = today;
  const end = today;

  if (range === 'week') {
    const day = today.getDay(); // 0=週日
    const diffToMonday = (day === 0 ? 6 : day - 1);
    start = new Date(today);
    start.setDate(today.getDate() - diffToMonday);
  } else if (range === 'month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  }
  return { start, end };
}

function setStatsRange(range) {
  statsRange = range;
  document.querySelectorAll('#statsPanel .quick-phrase[data-range]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  const customWrap = document.getElementById('statsCustomRange');
  if (range === 'custom') {
    customWrap.classList.remove('hidden');
    if (!document.getElementById('statsStartDate').value) {
      const { start, end } = getStatsPresetRange('month');
      document.getElementById('statsStartDate').value = toDateInputValue(start);
      document.getElementById('statsEndDate').value = toDateInputValue(end);
    }
    return; // 自訂範圍等使用者按「查詢」才觸發
  }
  customWrap.classList.add('hidden');
  loadStats();
}

async function loadStats() {
  let startStr, endStr;
  if (statsRange === 'custom') {
    startStr = document.getElementById('statsStartDate').value;
    endStr = document.getElementById('statsEndDate').value;
    if (!startStr || !endStr) {
      showToast('請選擇開始與結束日期', 'error');
      return;
    }
  } else {
    const { start, end } = getStatsPresetRange(statsRange || 'today');
    startStr = toDateInputValue(start);
    endStr = toDateInputValue(end);
  }

  document.getElementById('statsContent').classList.add('hidden');
  document.getElementById('statsEmpty').classList.add('hidden');
  document.getElementById('statsLoading').classList.remove('hidden');
  document.getElementById('statsExportBtn').classList.add('hidden');

  lastStatsRangeStr = { start: startStr, end: endStr };

  try {
    const res = await apiGetStats(startStr, endStr);
    document.getElementById('statsLoading').classList.add('hidden');
    if (res.success) {
      renderStats(res.data);
    } else {
      showToast(res.message || '讀取統計資料失敗', 'error');
    }
  } catch (err) {
    document.getElementById('statsLoading').classList.add('hidden');
    showToast('連線失敗，請稍後再試', 'error');
  }
}

function renderStats(data) {
  lastStatsData = data;
  if (!data || data.totalCount === 0) {
    document.getElementById('statsContent').classList.add('hidden');
    document.getElementById('statsEmpty').classList.remove('hidden');
    document.getElementById('statsExportBtn').classList.add('hidden');
    return;
  }
  document.getElementById('statsEmpty').classList.add('hidden');
  document.getElementById('statsContent').classList.remove('hidden');
  document.getElementById('statsExportBtn').classList.remove('hidden');

  document.getElementById('statTotalCount').textContent = data.totalCount;
  document.getElementById('statDaySpan').textContent = `共 ${data.daySpan} 天`;
  document.getElementById('statTurnover').textContent = data.turnoverPerBedPerDay;
  document.getElementById('statAvgStay').textContent = data.avgStay;
  document.getElementById('statOvertimeRate').textContent = data.overtimeRate + '%';
  document.getElementById('statOvertimeDetail').textContent =
    `${data.overtimeCount} 筆超時，平均超時 ${data.avgOvertimeMinutes} 分`;

  // 小床 / 大床比例
  const bedTotal = data.smallBedCount + data.largeBedCount;
  const smallPct = bedTotal > 0 ? Math.round((data.smallBedCount / bedTotal) * 100) : 0;
  const largePct = bedTotal > 0 ? 100 - smallPct : 0;
  document.getElementById('statsBedTypeBar').innerHTML = `
    <div class="flex items-center gap-3">
      <span class="text-sm w-16 flex-shrink-0">小床</span>
      <div class="flex-1 bg-[#eef2ee] rounded-full h-3 overflow-hidden">
        <div class="h-3 rounded-full" style="width:${smallPct}%; background:var(--amber-500);"></div>
      </div>
      <span class="text-sm font-bold w-24 text-right flex-shrink-0">${data.smallBedCount} 床 (${smallPct}%)</span>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-sm w-16 flex-shrink-0">大床</span>
      <div class="flex-1 bg-[#eef2ee] rounded-full h-3 overflow-hidden">
        <div class="h-3 rounded-full" style="width:${largePct}%; background:var(--teal-700);"></div>
      </div>
      <span class="text-sm font-bold w-24 text-right flex-shrink-0">${data.largeBedCount} 床 (${largePct}%)</span>
    </div>
  `;

  // 各 POR 床使用次數（由高到低排序）
  const porEntries = Object.entries(data.porUsage || {}).sort((a, b) => b[1] - a[1]);
  const maxPorCount = porEntries.length > 0 ? porEntries[0][1] : 1;
  document.getElementById('statsPorUsage').innerHTML = porEntries.map(([por, count]) => {
    const pct = Math.round((count / maxPorCount) * 100);
    return `
      <div class="flex items-center gap-3">
        <span class="text-sm font-bold w-20 flex-shrink-0">${escapeHtml(por)}</span>
        <div class="flex-1 bg-[#eef2ee] rounded-full h-3 overflow-hidden">
          <div class="h-3 rounded-full" style="width:${pct}%; background:var(--header-teal);"></div>
        </div>
        <span class="text-sm font-bold w-16 text-right flex-shrink-0">${count} 次</span>
      </div>
    `;
  }).join('');

  // 24小時運送時段分布（依到達時間）
  const maxHourCount = Math.max(1, ...data.hourDist);
  document.getElementById('statsHourChart').innerHTML = data.hourDist.map((count, hour) => {
    const barPx = count > 0 ? Math.max(4, Math.round((count / maxHourCount) * 100)) : 0;
    return `
      <div class="flex-1 flex flex-col items-center justify-end" style="height:140px;" title="${hour}時：${count}筆">
        <span class="text-[10px] text-gray-400 mb-1">${count > 0 ? count : ''}</span>
        <div style="width:100%; height:${barPx}px; background:var(--header-teal); border-radius:3px 3px 0 0;"></div>
        <span class="text-[9px] text-gray-400 mt-1">${hour}</span>
      </div>
    `;
  }).join('');
}

/* ===================== 統計報表匯出 Excel ===================== */

function exportStatsExcel() {
  if (!lastStatsData || typeof XLSX === 'undefined') {
    showToast('目前沒有可匯出的統計資料', 'error');
    return;
  }
  const data = lastStatsData;
  const { start, end } = lastStatsRangeStr;

  // 摘要工作表
  const summaryRows = [
    ['恢復室病人運送 - 統計報表'],
    ['查詢區間', `${start} ~ ${end}`, `共 ${data.daySpan} 天`],
    [],
    ['指標', '數值'],
    ['總接送數', data.totalCount],
    ['平均翻床率（每床/每天）', data.turnoverPerBedPerDay],
    ['平均停留時間（分）', data.avgStay],
    ['超時比例', data.overtimeRate + '%'],
    ['超時筆數', data.overtimeCount],
    ['平均超時分鐘', data.avgOvertimeMinutes],
    ['小床使用數', data.smallBedCount],
    ['大床使用數', data.largeBedCount]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 10 }];

  // 各POR床使用次數工作表
  const porEntries = Object.entries(data.porUsage || {}).sort((a, b) => b[1] - a[1]);
  const porRows = [['POR床號', '使用次數'], ...porEntries];
  const porSheet = XLSX.utils.aoa_to_sheet(porRows);
  porSheet['!cols'] = [{ wch: 14 }, { wch: 10 }];

  // 時段分布工作表
  const hourRows = [['時段（小時）', '接送筆數'], ...data.hourDist.map((count, hour) => [`${hour}:00`, count])];
  const hourSheet = XLSX.utils.aoa_to_sheet(hourRows);
  hourSheet['!cols'] = [{ wch: 12 }, { wch: 10 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, '摘要');
  XLSX.utils.book_append_sheet(wb, porSheet, 'POR床使用次數');
  XLSX.utils.book_append_sheet(wb, hourSheet, '時段分布');

  const filename = `恢復室運送統計報表_${start}_${end}.xlsx`;
  XLSX.writeFile(wb, filename);
}

/* ===================== PWA Service Worker ===================== */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // 偵測到新版Service Worker安裝完成時，自動重新整理頁面
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // 新版本已就緒，自動重新整理載入最新版
              showToast('🔄 系統已更新，正在重新載入...', 'info');
              setTimeout(() => window.location.reload(), 1500);
            }
          });
        }
      });
    }).catch(() => {});

    // 接收SW發出的更新訊息
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        showToast('✅ 系統已更新至最新版本', 'success');
      }
    });
  }
}

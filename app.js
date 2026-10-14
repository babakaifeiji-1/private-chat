import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { deriveRoom, newLinkKey, parseLinkKey, encryptJSON, decryptJSON, encryptBytes, decryptBytes, toHex } from './crypto.js';

const $ = (id) => document.getElementById(id);
const LS = {
  cid: 'privchat.cid',          // 本设备随机 id（放在加密消息里，区分“我自己”的消息）
  dev: 'privchat.dev',          // 本设备私有密钥（用于生成撤回/在线令牌，永不上传）
  nick: 'privchat.v2.nick',     // 我的名字
  oldKey: 'privchat.v2.key',    // 旧版单聊天室密钥（自动迁移）
  rooms: 'privchat.v3.rooms',   // [{k: 邀请链接密钥, name: 缓存的聊天室名}]
  cur: 'privchat.v3.current',   // 当前聊天室
  notify: 'privchat.notify',    // 桌面通知开关
  hint: 'privchat.hint.menu',   // 是否已提示过“长按消息”
};
const hiddenKey = (roomId) => 'privchat.v3.hidden.' + roomId; // 仅本机删除的消息 id
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;
const HEARTBEAT_MS = 15000;
const REV_MARGIN = 5;          // 增量同步时回看几个版本，防止并发写入时漏消息（重复的会被去重）
const PAGE = 50;
const MAX_IMG_SIDE = 1600;
const MAX_IMG_BYTES = 2_000_000;
const DB_LIMIT = 500 * 1024 * 1024; // Supabase 免费版数据库容量
const GROUP_MS = 3 * 60000;    // 同一人 3 分钟内的连续消息合并显示
const DIVIDER_MS = 5 * 60000;  // 间隔超过 5 分钟显示时间分隔
const te = new TextEncoder();
const isTouch = matchMedia('(hover: none)').matches;

const lsGet = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = async (s) => toHex(await crypto.subtle.digest('SHA-256', te.encode(s)));
const randomName = () => '用户-' + randHex(2).toUpperCase();
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 20);
const cleanCity = (s) => String(s || '').trim().slice(0, 40);
const cleanRoom = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 40);
const retentionLabel = (d) => (d == null ? '永久' : d === 365 ? '1 年' : `${d} 天`);
const fmtBytes = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const pad = (n) => String(n).padStart(2, '0');

let clientId = localStorage.getItem(LS.cid);
if (!clientId) { clientId = crypto.randomUUID(); localStorage.setItem(LS.cid, clientId); }
let devSecret = localStorage.getItem(LS.dev);
if (!devSecret) { devSecret = randHex(32); localStorage.setItem(LS.dev, devSecret); }

const state = {
  nick: localStorage.getItem(LS.nick) || '',
  k: '', key: null, roomId: '', token: '', ownerHash: '', presSecret: '', myCid: '',
  name: '', retention: null, clearedUpto: 0,
  rev: 0, firstId: null, timer: null, polling: false, unread: 0, gen: 0, newCount: 0,
  hbTimer: null, online: [], myCity: '', seenCids: null,
  hidden: new Set(), pendingImg: null, stick: false,
};

// ---------- 界面小工具 ----------
function toast(text, kind = '', ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function banner(text) {
  $('banner').textContent = text || '';
  $('banner').hidden = !text;
}
// 页面内确认框（替代浏览器自带的 confirm）
function confirmBox({ title, text = '', ok = '确定', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dlg');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = ok;
    $('confirm-ok').className = 'btn ' + (danger ? 'danger' : 'primary');
    let result = false;
    const done = (v) => { result = v; dlg.close(); };
    $('confirm-ok').onclick = () => done(true);
    $('confirm-cancel').onclick = () => done(false);
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    $('confirm-cancel').focus();
  });
}
// 头像：名字首字 + 由种子决定的颜色
const PALETTE = ['#e5484d', '#f76b15', '#d6a10b', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#6f6e77'];
function hashOf(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function paintAvatar(el, name, seed) {
  const n = String(name || '?').replace(/^用户-/, '');
  el.textContent = [...n][0]?.toUpperCase() || '?';
  el.style.background = PALETTE[hashOf(seed || name) % PALETTE.length];
}
// 小图标（固定内容，无用户数据）
function icon(id, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}
function makeAvatar(name, seed) {
  const a = document.createElement('span');
  a.className = 'avatar';
  a.setAttribute('aria-hidden', 'true');
  paintAvatar(a, name, seed);
  return a;
}
function fmtDivider(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return hm;
  if (diff === 1) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
async function copyText(text, okMsg = '已复制') {
  try { await navigator.clipboard.writeText(text); toast(okMsg); return true; } catch { /* 回退 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  toast(ok ? okMsg : '复制失败，请手动复制', ok ? '' : 'error');
  return ok;
}

// ---------- Supabase RPC（直接 fetch，无第三方库） ----------
function apiHeaders() {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY; // 旧版 anon JWT
  return headers;
}
async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: apiHeaders(), body: JSON.stringify(args), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${fn} 失败 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- 聊天室列表（只存在本机） ----------
const getRooms = () => lsGet(LS.rooms, []).filter((r) => parseLinkKey(r.k));
const saveRooms = (rooms) => lsSet(LS.rooms, rooms);
function addRoom(k, name = '') {
  const rooms = getRooms();
  if (!rooms.some((r) => r.k === k)) { rooms.push({ k, name }); saveRooms(rooms); }
}
function cacheRoomName(k, name) {
  const rooms = getRooms();
  const r = rooms.find((x) => x.k === k);
  if (r && r.name !== name) { r.name = name; saveRooms(rooms); }
}
// 从“完整邀请链接”或“裸密钥”中提取密钥
function extractKey(s) {
  const m = String(s || '').trim().match(/(?:[#&]k=)?([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/);
  return m && parseLinkKey(m[1]) ? m[1] : null;
}
const inviteUrl = () => location.origin + location.pathname + '#k=' + state.k;

// ---------- 启动 ----------
function showNoKey(msg = '') {
  leavePresence();
  clearTimeout(state.timer);
  state.gen++;
  state.key = null;
  $('chat').hidden = true;
  $('nokey').hidden = false;
  $('nokey-msg').textContent = msg;
  document.title = 'Notes';
}

async function init() {
  if (SUPABASE_URL.includes('YOUR-PROJECT')) return showNoKey('尚未配置：请先编辑 config.js 填入 Supabase 地址和 key');

  const old = localStorage.getItem(LS.oldKey); // 迁移旧版
  if (old && parseLinkKey(old)) { addRoom(old); if (!localStorage.getItem(LS.cur)) localStorage.setItem(LS.cur, old); }
  localStorage.removeItem(LS.oldKey);

  // 从链接 #k=... 读取密钥，存到本机后立即从地址栏移除（避免截图/复制地址时泄露）
  let msg = '';
  if (/[#&]k=/.test(location.hash)) {
    const k = extractKey(location.hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (k) { addRoom(k); localStorage.setItem(LS.cur, k); } else msg = '邀请链接无效或不完整，请让朋友重新发送';
  }
  const rooms = getRooms();
  if (!rooms.length) return showNoKey(msg);
  const cur = localStorage.getItem(LS.cur);
  await openRoom(rooms.some((r) => r.k === cur) ? cur : rooms[0].k);
  if (msg) toast(msg, 'error', 5000);
}

async function openRoom(k) {
  if (state.k !== k) leavePresence();
  const gen = ++state.gen;
  clearTimeout(state.timer);
  clearList();
  localStorage.setItem(LS.cur, k);
  $('nokey').hidden = true;
  $('chat').hidden = false;

  const { key, roomId } = await deriveRoom(parseLinkKey(k));
  // 撤回令牌 / 在线令牌：只有这台设备能算出来；服务器只保存哈希
  const token = await sha256hex('owner|' + devSecret + '|' + roomId);
  const ownerHash = await sha256hex(token);
  const presSecret = await sha256hex('presence|' + devSecret + '|' + roomId);
  const myCid = await sha256hex(presSecret);
  if (gen !== state.gen) return;
  Object.assign(state, {
    k, key, roomId, token, ownerHash, presSecret, myCid, online: [], myCity: '', seenCids: null,
    name: getRooms().find((r) => r.k === k)?.name || '', retention: null, clearedUpto: 0,
    rev: 0, firstId: null, unread: 0, polling: false, newCount: 0,
    hidden: new Set(lsGet(hiddenKey(roomId), [])),
  });
  $('new-pill').hidden = true;
  renderRoomName();
  updateIdentityUI();
  updateTitle();
  renderOnline();
  startHeartbeat();
  banner('正在加载…');
  try {
    const res = await rpc('get_messages', { p_room: roomId, p_limit: PAGE });
    if (gen !== state.gen) return;
    await applyRoom(res.room);
    for (const m of res.messages) await upsertRow(m);
    if (gen !== state.gen) return;
    state.rev = res.max_rev || 0;
    state.firstId = res.messages.length ? res.messages[0].id : null;
    $('older').hidden = res.messages.length < PAGE;
    afterChange();
    scrollToBottom();
    banner('');
    schedulePoll(POLL_VISIBLE_MS);
  } catch {
    banner('连接失败，5 秒后重试…');
    state.timer = setTimeout(() => { if (gen === state.gen) openRoom(k); }, 5000);
  }
}

// 应用房间信息（名称、保留期限、清空标记）
async function applyRoom(meta) {
  if (!meta) return;
  if (meta.name_payload) {
    try {
      const n = cleanRoom((await decryptJSON(state.key, state.roomId, meta.name_payload)).name);
      if (n) { state.name = n; cacheRoomName(state.k, n); }
    } catch { /* 忽略无法解密的名称 */ }
  }
  state.retention = meta.retention_days ?? null;
  if (meta.cleared_upto > state.clearedUpto) {
    state.clearedUpto = meta.cleared_upto;
    for (const row of $('list').querySelectorAll('.row')) if (+row.dataset.id <= state.clearedUpto) row.remove();
  }
  enforceRetention();
  renderRoomName();
}

function enforceRetention() {
  if (!state.retention) return;
  const cutoff = Date.now() - state.retention * 86400000;
  for (const row of $('list').querySelectorAll('.row')) if (+row.dataset.ts < cutoff) row.remove();
}

function renderRoomName() {
  const name = state.name || '未命名聊天室';
  $('room-name').textContent = name;
  paintAvatar($('room-avatar'), name, state.roomId);
}

// ---------- 名字 ----------
function updateIdentityUI() {
  const joined = !!state.nick;
  $('join').hidden = joined;
  $('composer').hidden = !joined;
  if (!joined && !$('join-name').value) $('join-name').value = randomName();
}
function setNick(name) {
  state.nick = name;
  localStorage.setItem(LS.nick, name);
  updateIdentityUI();
  if (state.key) startHeartbeat();
}
function showMenuHintOnce() {
  if (lsGet(LS.hint, false)) return;
  lsSet(LS.hint, true);
  toast(isTouch ? '提示：长按消息可以复制、撤回或删除' : '提示：鼠标移到消息上点 ⋯（或右键）可以复制、撤回、删除', 'info', 6000);
}

// ---------- 在线状态 ----------
function startHeartbeat() {
  clearTimeout(state.hbTimer);
  const gen = state.gen;
  const beat = async () => {
    if (gen !== state.gen || !state.key) return;
    try {
      const payload = await encryptJSON(state.key, state.roomId, { n: state.nick, j: !!state.nick });
      const rows = await rpc('heartbeat', { p_room: state.roomId, p_secret: state.presSecret, p_payload: payload });
      if (gen !== state.gen) return;
      const online = [];
      for (const r of rows) {
        try {
          const p = await decryptJSON(state.key, state.roomId, r.payload);
          online.push({ cid: r.cid, me: r.cid === state.myCid, name: cleanName(p.n), joined: !!p.j, city: cleanCity(r.city) });
        } catch { /* 忽略无法解密的条目 */ }
      }
      const me = online.find((p) => p.me);
      if (me) state.myCity = me.city;
      // 有新设备上线时提示（首次加载时不提示）
      if (state.seenCids) {
        const fresh = online.filter((p) => !p.me && !state.seenCids.has(p.cid));
        if (fresh.length) {
          const text = fresh.map((p) => `${p.joined ? p.name : '访客'}（${p.city || '未知地区'}）`).join('、');
          toast('新设备上线：' + text, 'info', 7000);
        }
      } else {
        state.seenCids = new Set();
      }
      for (const p of online) state.seenCids.add(p.cid);
      state.online = online;
      renderOnline();
    } catch { /* 网络问题，下次再试 */ }
    if (gen === state.gen) state.hbTimer = setTimeout(beat, HEARTBEAT_MS);
  };
  beat();
}

function leavePresence() {
  clearTimeout(state.hbTimer);
  if (!state.roomId || !state.presSecret) return;
  // keepalive：页面关闭时请求也能发出去
  fetch(`${SUPABASE_URL}/rest/v1/rpc/leave_presence`, {
    method: 'POST', headers: apiHeaders(), keepalive: true,
    body: JSON.stringify({ p_room: state.roomId, p_secret: state.presSecret }),
  }).catch(() => {});
}

function renderOnline() {
  $('online-count').textContent = String(state.online.length);
  $('online-count2').textContent = `· ${state.online.length} 人`;
  const ul = $('online-list');
  ul.textContent = '';
  const sorted = [...state.online].sort((a, b) => (b.me - a.me) || (b.joined - a.joined) || a.name.localeCompare(b.name));
  for (const p of sorted) {
    const li = document.createElement('li');
    li.className = 'person';
    const display = p.joined ? p.name || '?' : '访客';
    li.appendChild(makeAvatar(display, p.joined ? display : p.cid));
    const main = document.createElement('div');
    main.className = 'person-main';
    const nameRow = document.createElement('span');
    nameRow.className = 'person-name';
    const nm = document.createElement('span');
    nm.textContent = display;
    nameRow.appendChild(nm);
    const badge = (text, gray) => { const b = document.createElement('span'); b.className = 'badge' + (gray ? ' gray' : ''); b.textContent = text; nameRow.appendChild(b); };
    if (p.me) badge('我');
    if (!p.joined) badge('浏览中，未加入', true);
    const city = document.createElement('span');
    city.className = 'person-city';
    city.append(icon('i-pin', 'pin'), document.createTextNode(p.city || '未知地区'));
    main.append(nameRow, city);
    li.appendChild(main);
    ul.appendChild(li);
  }
}

// ---------- 同步消息 ----------
async function poll() {
  if (!state.key || state.polling) return;
  const gen = state.gen;
  state.polling = true;
  try {
    const res = await rpc('get_changes', { p_room: state.roomId, p_after_rev: Math.max(0, state.rev - REV_MARGIN) });
    if (gen !== state.gen) return;
    if (res.room) { await applyRoom(res.room); state.rev = Math.max(state.rev, res.room.rev); }
    const atBottom = isNearBottom() || state.stick;
    let fresh = 0;
    for (const m of res.messages) {
      const r = await upsertRow(m);
      if (gen !== state.gen) return;
      state.rev = Math.max(state.rev, m.rev);
      if (state.firstId == null) state.firstId = m.id;
      if (r?.isNew && !r.mine) fresh++;
    }
    enforceRetention();
    afterChange();
    if (res.messages.length && atBottom) scrollToBottom();
    else if (fresh) { state.newCount += fresh; showNewPill(); }
    state.stick = false;
    if (fresh && document.hidden) { state.unread += fresh; notifyNew(); }
    updateTitle();
    banner('');
  } catch {
    if (gen === state.gen) banner('网络连接异常，正在重试…');
  } finally {
    if (gen === state.gen) state.polling = false;
  }
}
// 立刻同步一次（如果正在同步，等它结束后再来一次）
async function pollNow() {
  const gen = state.gen;
  while (state.polling && gen === state.gen) await sleep(50);
  if (gen !== state.gen) return;
  await poll();
  schedulePoll(POLL_VISIBLE_MS);
}

function schedulePoll(delay) {
  clearTimeout(state.timer);
  const gen = state.gen;
  state.timer = setTimeout(async () => {
    await poll();
    if (state.key && gen === state.gen) schedulePoll(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
  }, delay);
}

async function loadOlder() {
  if (state.firstId == null) return;
  const gen = state.gen;
  $('older').disabled = true;
  $('older').textContent = '加载中…';
  try {
    const res = await rpc('get_messages', { p_room: state.roomId, p_before: state.firstId, p_limit: PAGE });
    if (gen !== state.gen) return;
    const list = $('list');
    const prevHeight = list.scrollHeight;
    for (const m of res.messages) await upsertRow(m, true);
    if (res.messages.length) state.firstId = res.messages[0].id;
    $('older').hidden = res.messages.length < PAGE;
    afterChange();
    list.scrollTop += list.scrollHeight - prevHeight;
  } catch {
    toast('加载失败，请稍后再试', 'error');
  } finally {
    $('older').disabled = false;
    $('older').textContent = '加载更早的消息';
  }
}

const rowEl = (id) => $('list').querySelector(`.row[data-id="${Number(id)}"]`);

// 插入或更新一条消息（按 id 排序）；返回 {isNew, mine} 或 null
async function upsertRow(m, older = false) {
  const existing = rowEl(m.id);
  if (existing && (existing.dataset.recalled === '1' || !m.recalled)) return null; // 已是最终状态 / 重复
  if (m.id <= state.clearedUpto) return null;
  if (state.hidden.has(m.id)) { existing?.remove(); return null; }
  if (!existing && !older && state.firstId != null && m.id < state.firstId) return null; // 不在已加载范围内
  const gen = state.gen;
  const node = await renderRow(m);
  if (gen !== state.gen) return null;
  const again = rowEl(m.id);
  if (again) again.replaceWith(node); else insertSorted(node);
  return { isNew: !again, mine: node.dataset.mine === '1' };
}

function insertSorted(node) {
  const id = +node.dataset.id;
  const rows = [...$('list').querySelectorAll('.row')];
  let before = $('list').querySelector('.prow'); // 正在发送的占位气泡始终在最后
  for (let i = rows.length - 1; i >= 0; i--) {
    if (+rows[i].dataset.id < id) { before = rows[i].nextSibling; break; }
    if (i === 0) before = rows[0];
  }
  $('list').insertBefore(node, before);
}

function clearList() {
  for (const n of $('list').querySelectorAll('.row, .divider, .prow')) n.remove();
  $('older').hidden = true;
  $('empty').hidden = true;
}

// 列表变化后：重建时间分隔、合并连续消息、空状态
function afterChange() {
  const list = $('list');
  for (const d of list.querySelectorAll('.divider')) d.remove();
  let prev = null;
  let lastTs = 0;
  for (const row of list.querySelectorAll('.row')) {
    const ts = +row.dataset.ts;
    let broke = false;
    if (!lastTs || ts - lastTs > DIVIDER_MS) {
      const d = document.createElement('div');
      d.className = 'divider';
      d.textContent = fmtDivider(ts);
      row.before(d);
      broke = true;
    }
    const cont = !broke && prev && !row.classList.contains('sys') && !prev.classList.contains('sys')
      && prev.dataset.sender === row.dataset.sender && ts - +prev.dataset.ts < GROUP_MS;
    row.classList.toggle('cont', !!cont);
    prev = row;
    lastTs = ts;
  }
  $('empty').hidden = !!list.querySelector('.row, .prow');
}

// ---------- 渲染（全部使用 textContent，避免 XSS） ----------
function sysRow(row, text) {
  row.classList.add('sys');
  const s = document.createElement('span');
  s.className = 'sys-text';
  s.textContent = text;
  row.appendChild(s);
  return row;
}

async function renderRow(m) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = m.id;
  row.dataset.ts = Date.parse(m.created_at);

  let msg;
  try {
    msg = await decryptJSON(state.key, state.roomId, m.payload);
  } catch {
    return sysRow(row, '[无法解密的消息]');
  }
  const mine = msg.c === clientId;
  row.dataset.mine = mine ? '1' : '0';
  const name = cleanName(msg.n) || '?';
  const who = mine ? '你' : name;

  if (m.recalled || msg.t === 'recall') { row.dataset.recalled = '1'; return sysRow(row, `${who}撤回了一条消息`); }
  if (msg.t === 'rename') return sysRow(row, `${who}将聊天室名称改为「${cleanRoom(msg.name)}」`);
  if (msg.t === 'retention') return sysRow(row, `${who}将消息保留时间设为${retentionLabel(msg.d ?? null)}`);
  if (msg.t === 'clear') return sysRow(row, `${who}清空了聊天记录`);

  row.dataset.sender = String(msg.c || '') + '|' + name;
  if (mine) row.classList.add('me');
  row.appendChild(makeAvatar(name, name));

  const body = document.createElement('div');
  body.className = 'body';
  const whoEl = document.createElement('div');
  whoEl.className = 'who';
  const nm = document.createElement('span');
  nm.textContent = mine ? '我' : name;
  whoEl.appendChild(nm);
  const loc = cleanCity(msg.loc);
  if (loc) {
    const l = document.createElement('span');
    l.className = 'loc';
    l.append(icon('i-pin', 'pin'), document.createTextNode(loc));
    whoEl.appendChild(l);
  }

  const line = document.createElement('div');
  line.className = 'line';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.title = new Date(m.created_at).toLocaleString('zh-CN', { hour12: false });
  if (msg.t === 'img' && typeof msg.b === 'string') {
    bubble.classList.add('img');
    bubble.textContent = '图片加载中…';
    loadImage(msg, bubble);
  } else {
    bubble.textContent = String(msg.x ?? '');
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more';
  more.setAttribute('aria-label', '消息操作');
  more.appendChild(icon('i-more'));
  const open = () => openMsgMenu(m.id, msg, mine, more);
  more.addEventListener('click', open);
  attachLongPress(bubble, open);
  line.append(bubble, more);
  body.append(whoEl, line);
  row.appendChild(body);
  return row;
}

// 长按（手机）/ 右键（电脑）打开消息菜单
function attachLongPress(el, fn) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  el.addEventListener('touchstart', (e) => {
    const p = e.touches[0];
    sx = p.clientX; sy = p.clientY;
    timer = setTimeout(() => { timer = null; fn(); }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const p = e.touches[0];
    if (timer && (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10)) { clearTimeout(timer); timer = null; }
  }, { passive: true });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
}

function openMsgMenu(id, msg, mine, btn) {
  const dlg = $('msg-dlg');
  if (dlg.open) return;
  $('msg-preview').textContent = msg.t === 'img' ? '[图片]' : String(msg.x ?? '').slice(0, 120);
  const box = $('msg-actions');
  box.textContent = '';
  const add = (text, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.addEventListener('click', () => { dlg.close(); fn(); });
    box.appendChild(b);
  };
  if (msg.t !== 'img') add('复制', () => copyText(String(msg.x ?? '')));
  if (mine) add('撤回（所有人都看不到）', () => recall(id));
  add('删除（仅从本设备删除）', () => deleteLocal(id), 'danger');
  btn?.setAttribute('aria-expanded', 'true');
  dlg.addEventListener('close', () => btn?.setAttribute('aria-expanded', 'false'), { once: true });
  dlg.showModal();
  box.querySelector('button')?.focus();
}

async function recall(id) {
  try {
    const payload = await encryptJSON(state.key, state.roomId, { t: 'recall', n: state.nick, c: clientId, ts: Date.now() });
    const ok = await rpc('recall_message', { p_room: state.roomId, p_id: id, p_token: state.token, p_payload: payload });
    if (!ok) toast('无法撤回：只能撤回在这台设备上发送的消息', 'error', 4000);
    else toast('已撤回');
    pollNow();
  } catch {
    toast('撤回失败，请检查网络', 'error');
  }
}

function deleteLocal(id) {
  state.hidden.add(id);
  lsSet(hiddenKey(state.roomId), [...state.hidden].slice(-5000));
  rowEl(id)?.remove();
  afterChange();
  toast('已从本设备删除');
}

async function loadImage(msg, bubble) {
  const gen = state.gen;
  try {
    const data = await rpc('get_blob', { p_room: state.roomId, p_id: msg.b });
    if (!data) throw new Error('missing');
    const bytes = await decryptBytes(state.key, state.roomId, data);
    if (gen !== state.gen) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    const img = document.createElement('img');
    img.src = url;
    img.alt = '图片（点击查看大图）';
    img.tabIndex = 0;
    img.addEventListener('click', () => openViewer(url));
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter') openViewer(url); });
    const stick = isNearBottom();
    img.addEventListener('load', () => { if (stick) scrollToBottom(); });
    bubble.textContent = '';
    bubble.appendChild(img);
  } catch {
    bubble.classList.add('bad');
    bubble.textContent = '[图片已过期或加载失败]';
  }
}

function openViewer(url) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-label', '图片预览，点击或按 Esc 关闭');
  v.tabIndex = -1;
  const img = document.createElement('img');
  img.src = url;
  img.alt = '图片大图';
  v.appendChild(img);
  const close = () => v.remove();
  v.addEventListener('click', close);
  v.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(v);
  v.focus();
}

// ---------- 发消息 ----------
// 发送中的占位气泡
function addPending(text) {
  const p = document.createElement('div');
  p.className = 'prow';
  const body = document.createElement('div');
  body.className = 'body';
  const b = document.createElement('div');
  b.className = 'bubble pending';
  b.textContent = text;
  const ts = document.createElement('div');
  ts.className = 'ts';
  ts.textContent = '发送中…';
  body.append(b, ts);
  p.appendChild(body);
  $('list').appendChild(p);
  $('empty').hidden = true;
  scrollToBottom();
  return p;
}

async function sendPayload(obj, blobId = null) {
  const payload = await encryptJSON(state.key, state.roomId, { ...obj, n: state.nick || '某人', c: clientId, loc: state.myCity, ts: Date.now() });
  await rpc('send_message', { p_room: state.roomId, p_payload: payload, p_owner_hash: state.ownerHash, p_blob_id: blobId });
  state.stick = true;
  await pollNow();
}

async function sendText() {
  const ta = $('text');
  const text = ta.value.trim();
  if (!text || !state.nick) return;
  ta.value = '';
  autoGrow();
  updateSendBtn();
  const p = addPending(text);
  try {
    await sendPayload({ t: 'text', x: text });
  } catch {
    if (!ta.value) { ta.value = text; autoGrow(); updateSendBtn(); }
    toast('发送失败，消息已放回输入框，请重试', 'error', 4000);
  } finally {
    p.remove();
    afterChange();
    ta.focus();
  }
}

// 压缩图片：缩放到最长边 1600px，转 JPEG（去掉 EXIF 等元数据，包括 GPS 位置）
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  let quality = 0.82;
  let scale = Math.min(1, MAX_IMG_SIDE / Math.max(bmp.width, bmp.height));
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_IMG_BYTES) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), blob, w: canvas.width, h: canvas.height };
      }
      quality = Math.max(0.5, quality - 0.1);
      scale *= 0.8;
    }
  } finally {
    bmp.close();
  }
  throw new Error('图片太大');
}

// 选择 / 粘贴 / 拖入图片后先预览，确认后再发送
async function previewImage(file) {
  if (!file || !file.type.startsWith('image/') || !state.nick || !state.key) return;
  try {
    const img = await compressImage(file);
    if (state.pendingImg) URL.revokeObjectURL(state.pendingImg.url);
    state.pendingImg = { ...img, url: URL.createObjectURL(img.blob) };
    $('preview-img').src = state.pendingImg.url;
    $('preview-info').textContent = `${img.w}×${img.h} · ${fmtBytes(img.bytes.length)} · 已压缩并去除位置信息`;
    $('preview-dlg').showModal();
    $('preview-send').focus();
  } catch {
    toast('无法读取这张图片', 'error');
  }
}

async function sendPendingImage() {
  const p = state.pendingImg;
  state.pendingImg = null; // 交给发送流程，关闭弹窗时不要回收
  $('preview-dlg').close();
  if (!p) return;
  const ph = addPending('图片发送中…');
  try {
    const data = await encryptBytes(state.key, state.roomId, p.bytes);
    const blobId = await rpc('put_blob', { p_room: state.roomId, p_data: data });
    await sendPayload({ t: 'img', b: blobId }, blobId);
  } catch {
    toast('图片发送失败，请重试', 'error');
  } finally {
    URL.revokeObjectURL(p.url);
    ph.remove();
    afterChange();
  }
}

// ---------- 聊天室列表 / 新建 / 加入 ----------
function openRoomsDialog() {
  const ul = $('rooms-list');
  ul.textContent = '';
  for (const r of getRooms()) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const name = r.name || '未命名聊天室';
    b.appendChild(makeAvatar(name, r.k === state.k ? state.roomId : r.k));
    const label = document.createElement('span');
    label.className = 'room-label';
    label.textContent = name;
    b.appendChild(label);
    if (r.k === state.k) {
      b.setAttribute('aria-current', 'true');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '当前';
      b.appendChild(badge);
    }
    b.addEventListener('click', () => { $('rooms-dlg').close(); if (r.k !== state.k) openRoom(r.k); });
    li.appendChild(b);
    ul.appendChild(li);
  }
  $('rooms-msg').textContent = '';
  $('rooms-link').value = '';
  $('rooms-dlg').showModal();
}

function openCreateDialog() {
  if ($('rooms-dlg').open) $('rooms-dlg').close();
  $('create-name').value = '聊天室-' + randHex(2).toUpperCase();
  $('create-dlg').showModal();
  $('create-name').select();
}

async function createRoom(e) {
  e.preventDefault();
  const name = cleanRoom($('create-name').value) || '新聊天室';
  $('create-dlg').close();
  const k = newLinkKey();
  addRoom(k, name);
  await openRoom(k);
  try {
    await rpc('set_room_name', { p_room: state.roomId, p_name_payload: await encryptJSON(state.key, state.roomId, { name }) });
  } catch { /* 下次修改名称时会再保存 */ }
  toast('聊天室已创建');
  openInvite();
}

function joinByLink(text, msgEl) {
  const k = extractKey(text);
  if (!k) { msgEl.textContent = '链接无效，请检查是否复制完整'; return; }
  addRoom(k);
  if ($('rooms-dlg').open) $('rooms-dlg').close();
  openRoom(k);
}

function openInvite() {
  $('invite-url').value = inviteUrl();
  $('invite-share').hidden = !navigator.share;
  $('invite-dlg').showModal();
  $('invite-copy').focus();
}

// ---------- 设置 ----------
function openSettings() {
  $('nick-input').value = state.nick;
  $('roomname-input').value = state.name;
  $('retention').value = state.retention == null ? '' : String(state.retention);
  $('notify').checked = !!lsGet(LS.notify, false) && 'Notification' in window && Notification.permission === 'granted';
  $('notify').disabled = !('Notification' in window);
  $('settings-dlg').showModal();
  refreshUsage();
}

async function refreshUsage() {
  $('usage').textContent = '正在计算存储占用…';
  try {
    const u = await rpc('room_usage', { p_room: state.roomId });
    $('usage').textContent = `本聊天室 ${u.messages} 条消息、${u.images} 张图片，约 ${fmtBytes(u.bytes)}。`
      + `数据库共用 ${fmtBytes(u.db_bytes)} / 500 MB（免费额度）。`;
    $('usage-bar').style.width = Math.min(100, (u.db_bytes / DB_LIMIT) * 100).toFixed(1) + '%';
  } catch {
    $('usage').textContent = '存储占用获取失败';
  }
}

async function saveRoomName(e) {
  e.preventDefault();
  const name = cleanRoom($('roomname-input').value);
  if (!name || name === state.name) return;
  try {
    await rpc('set_room_name', { p_room: state.roomId, p_name_payload: await encryptJSON(state.key, state.roomId, { name }) });
    state.name = name;
    cacheRoomName(state.k, name);
    renderRoomName();
    await sendPayload({ t: 'rename', name });
    toast('聊天室名称已修改');
  } catch {
    toast('修改失败，请检查网络', 'error');
  }
}

async function changeRetention() {
  const v = $('retention').value;
  const d = v === '' ? null : parseInt(v, 10);
  const revert = () => { $('retention').value = state.retention == null ? '' : String(state.retention); };
  if (d === state.retention) return;
  if (d != null && !(await confirmBox({ title: `只保留最近 ${retentionLabel(d)}的消息？`, text: '更早的消息和图片会被永久删除，对所有人生效。', ok: '确定', danger: true }))) return revert();
  try {
    await rpc('set_retention', { p_room: state.roomId, p_days: d });
    state.retention = d;
    enforceRetention();
    await sendPayload({ t: 'retention', d });
    toast('消息保留时间：' + retentionLabel(d));
    refreshUsage();
  } catch {
    revert();
    toast('设置失败，请检查网络', 'error');
  }
}

async function toggleNotify() {
  if (!$('notify').checked) { lsSet(LS.notify, false); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') { lsSet(LS.notify, true); toast('已开启桌面通知'); }
  else { $('notify').checked = false; toast('浏览器没有允许通知', 'error'); }
}

function notifyNew() {
  if (!lsGet(LS.notify, false) || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('Notes', { body: '有新消息', tag: 'privchat' }); } catch { /* 部分手机浏览器不支持 */ }
}

async function clearRoom() {
  if (!(await confirmBox({ title: '清空所有聊天记录？', text: '本聊天室的所有消息和图片会被永久删除，所有人都看不到了，无法恢复。', ok: '清空', danger: true }))) return;
  try {
    await rpc('clear_room', { p_room: state.roomId });
    clearList();
    await sendPayload({ t: 'clear' });
    toast('已清空');
    refreshUsage();
  } catch {
    toast('清空失败，请检查网络', 'error');
  }
}

async function leaveRoom() {
  if (!(await confirmBox({ title: '从此设备移除该聊天室？', text: '聊天记录不会被删除，以后可以用邀请链接重新加入。', ok: '移除' }))) return;
  saveRooms(getRooms().filter((r) => r.k !== state.k));
  localStorage.removeItem(hiddenKey(state.roomId));
  $('settings-dlg').close();
  const rest = getRooms();
  if (rest.length) openRoom(rest[0].k); else { localStorage.removeItem(LS.cur); showNoKey(); }
  toast('已移除');
}

// ---------- 小工具 ----------
function isNearBottom() {
  const l = $('list');
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}
function scrollToBottom() {
  const l = $('list');
  l.scrollTop = l.scrollHeight;
  state.newCount = 0;
  $('new-pill').hidden = true;
}
function showNewPill() {
  $('new-pill').textContent = `↓ ${state.newCount} 条新消息`;
  $('new-pill').hidden = false;
}
function updateTitle() { document.title = state.unread ? `(${state.unread}) Notes` : 'Notes'; }
function autoGrow() {
  const ta = $('text');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  ta.style.overflowY = ta.scrollHeight > 140 ? 'auto' : 'hidden';
}
function updateSendBtn() { $('send').disabled = !$('text').value.trim(); }

// ---------- 事件绑定 ----------
$('nokey-join').addEventListener('submit', (e) => { e.preventDefault(); joinByLink($('nokey-link').value, $('nokey-msg')); });
$('nokey-create').addEventListener('click', openCreateDialog);
$('create-form').addEventListener('submit', createRoom);
$('rooms-btn').addEventListener('click', openRoomsDialog);
$('rooms-create').addEventListener('click', openCreateDialog);
$('rooms-join').addEventListener('submit', (e) => { e.preventDefault(); joinByLink($('rooms-link').value, $('rooms-msg')); });
$('invite-btn').addEventListener('click', openInvite);
$('settings-invite').addEventListener('click', () => { $('settings-dlg').close(); openInvite(); });
$('empty-invite').addEventListener('click', () => copyText(inviteUrl(), '邀请链接已复制，发给朋友吧'));
$('invite-copy').addEventListener('click', () => copyText($('invite-url').value, '邀请链接已复制'));
$('invite-share').addEventListener('click', () => navigator.share?.({ title: '邀请你加入聊天', url: $('invite-url').value }).catch(() => {}));
$('online-btn').addEventListener('click', () => { renderOnline(); $('online-dlg').showModal(); });
$('settings-btn').addEventListener('click', openSettings);
$('nick-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = cleanName($('nick-input').value);
  if (n && n !== state.nick) { setNick(n); toast('名字已改为 ' + n); }
});
$('roomname-form').addEventListener('submit', saveRoomName);
$('retention').addEventListener('change', changeRetention);
$('notify').addEventListener('change', toggleNotify);
$('clear-room').addEventListener('click', clearRoom);
$('leave-room').addEventListener('click', leaveRoom);
for (const b of document.querySelectorAll('.close-dlg')) b.addEventListener('click', () => b.closest('dialog').close());
// 点击弹窗外的遮罩关闭
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'confirm-dlg') d.close(); });
}
$('preview-send').addEventListener('click', sendPendingImage);
$('preview-dlg').addEventListener('close', () => {
  if (state.pendingImg) { URL.revokeObjectURL(state.pendingImg.url); state.pendingImg = null; }
  if (!$('composer').hidden) $('text').focus();
});

$('join').addEventListener('submit', (e) => {
  e.preventDefault();
  setNick(cleanName($('join-name').value) || randomName());
  toast('欢迎，' + state.nick);
  showMenuHintOnce();
  $('text').focus();
});
$('older').addEventListener('click', loadOlder);
$('new-pill').addEventListener('click', scrollToBottom);
$('list').addEventListener('scroll', () => { if (!$('new-pill').hidden && isNearBottom()) { state.newCount = 0; $('new-pill').hidden = true; } }, { passive: true });
$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
$('text').addEventListener('input', () => { autoGrow(); updateSendBtn(); });
$('text').addEventListener('keydown', (e) => {
  // 电脑：Enter 发送，Shift+Enter 换行；手机：回车换行，用发送按钮发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch) { e.preventDefault(); sendText(); }
});
$('file').addEventListener('change', (e) => { previewImage(e.target.files[0]); e.target.value = ''; });
$('text').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); previewImage(item.getAsFile()); }
});
const list = $('list');
list.addEventListener('dragover', (e) => { if (state.nick && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); list.classList.add('drag'); } });
list.addEventListener('dragleave', () => list.classList.remove('drag'));
list.addEventListener('drop', (e) => {
  list.classList.remove('drag');
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); previewImage(f); }
});
window.addEventListener('pagehide', leavePresence);
window.addEventListener('pageshow', (e) => { if (e.persisted && state.key) startHeartbeat(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { state.unread = 0; updateTitle(); if (state.key) schedulePoll(0); }
});
// 在已打开的页面里粘贴了新的邀请链接（只改了 # 部分），重新加载
window.addEventListener('hashchange', () => { if (/[#&]k=/.test(location.hash)) location.reload(); });

init();

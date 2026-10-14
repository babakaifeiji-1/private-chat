import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { deriveRoom, newLinkKey, parseLinkKey, encryptJSON, decryptJSON, encryptBytes, decryptBytes, toHex } from './crypto.js';

const $ = (id) => document.getElementById(id);
const LS = {
  cid: 'privchat.cid',          // 本设备随机 id（放在加密消息里，区分“我自己”的消息）
  dev: 'privchat.dev',          // 本设备私有密钥（用于生成撤回令牌，永不上传）
  nick: 'privchat.v2.nick',     // 我的名字
  oldKey: 'privchat.v2.key',    // 旧版单聊天室密钥（自动迁移）
  rooms: 'privchat.v3.rooms',   // [{k: 邀请链接密钥, name: 缓存的聊天室名}]
  cur: 'privchat.v3.current',   // 当前聊天室
  notify: 'privchat.notify',    // 桌面通知开关
};
const hiddenKey = (roomId) => 'privchat.v3.hidden.' + roomId; // 仅本机删除的消息 id
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;
const REV_MARGIN = 5; // 增量同步时回看几个版本，防止并发写入时漏消息（重复的会被去重）
const PAGE = 50;
const HEARTBEAT_MS = 15000;
const MAX_IMG_SIDE = 1600;
const MAX_IMG_BYTES = 2_000_000;
const te = new TextEncoder();

const lsGet = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const randHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = async (s) => toHex(await crypto.subtle.digest('SHA-256', te.encode(s)));
const randomName = () => '用户-' + randHex(2).toUpperCase();
const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 20);
const cleanRoom = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 40);
const retentionLabel = (d) => (d == null ? '永久' : d === 365 ? '1 年' : `${d} 天`);
const fmtBytes = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

let clientId = localStorage.getItem(LS.cid);
if (!clientId) { clientId = crypto.randomUUID(); localStorage.setItem(LS.cid, clientId); }
let devSecret = localStorage.getItem(LS.dev);
if (!devSecret) { devSecret = randHex(32); localStorage.setItem(LS.dev, devSecret); }

const state = {
  nick: localStorage.getItem(LS.nick) || '',
  k: '', key: null, roomId: '', token: '', ownerHash: '', presSecret: '', myCid: '', hbTimer: null, online: [],
  name: '', retention: null, clearedUpto: 0,
  rev: 0, firstId: null, timer: null, polling: false, unread: 0, gen: 0,
  hidden: new Set(), msgs: new Map(), pendingImg: null, stick: false,
};

// ---------- Supabase RPC（直接 fetch，无第三方库） ----------
async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY; // 旧版 anon JWT
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store',
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
  if (msg) setStatus(msg);
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
  // 撤回令牌：只有这台设备能算出来；服务器只保存它的哈希
  const token = await sha256hex('owner|' + devSecret + '|' + roomId);
  const ownerHash = await sha256hex(token);
  // 在线状态令牌：同样只有本设备知道，服务器只看到哈希
  const presSecret = await sha256hex('presence|' + devSecret + '|' + roomId);
  const myCid = await sha256hex(presSecret);
  if (gen !== state.gen) return;
  Object.assign(state, {
    k, key, roomId, token, ownerHash, presSecret, myCid, online: [],
    name: getRooms().find((r) => r.k === k)?.name || '', retention: null, clearedUpto: 0,
    rev: 0, firstId: null, unread: 0, polling: false,
    hidden: new Set(lsGet(hiddenKey(roomId), [])), msgs: new Map(),
  });
  renderRoomName();
  updateIdentityUI();
  updateTitle();
  renderOnline();
  startHeartbeat();
  setStatus('加载中…');
  try {
    const res = await rpc('get_messages', { p_room: roomId, p_limit: PAGE });
    if (gen !== state.gen) return;
    await applyRoom(res.room);
    for (const m of res.messages) await upsertRow(m);
    if (gen !== state.gen) return;
    state.rev = res.max_rev || 0;
    state.firstId = res.messages.length ? res.messages[0].id : null;
    $('older').hidden = res.messages.length < PAGE;
    updateEmpty();
    scrollToBottom();
    setStatus('');
    schedulePoll(POLL_VISIBLE_MS);
  } catch {
    setStatus('连接失败，重试中…');
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
          online.push({ me: r.cid === state.myCid, name: cleanName(p.n), joined: !!p.j });
        } catch { /* 忽略无法解密的条目 */ }
      }
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
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY;
  // keepalive：页面关闭时请求也能发出去
  fetch(`${SUPABASE_URL}/rest/v1/rpc/leave_presence`, {
    method: 'POST', headers, keepalive: true,
    body: JSON.stringify({ p_room: state.roomId, p_secret: state.presSecret }),
  }).catch(() => {});
}

function renderOnline() {
  $('online-count').textContent = String(state.online.length);
  const ul = $('online-list');
  ul.textContent = '';
  const sorted = [...state.online].sort((a, b) => (b.me - a.me) || (b.joined - a.joined) || a.name.localeCompare(b.name));
  for (const p of sorted) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = p.joined ? p.name || '?' : '访客';
    li.append(dot, name);
    const tagText = [p.me ? '我' : '', p.joined ? '' : '浏览中，未加入'].filter(Boolean).join('，');
    if (tagText) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `（${tagText}）`;
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }
}
function renderRoomName() {
  $('room-name').textContent = state.name || '未命名聊天室';
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
    if (res.messages.length && atBottom) scrollToBottom();
    state.stick = false;
    if (fresh && document.hidden) { state.unread += fresh; notifyNew(); }
    enforceRetention();
    updateEmpty();
    updateTitle();
    setStatus('');
  } catch {
    if (gen === state.gen) setStatus('连接异常，重试中…');
  } finally {
    if (gen === state.gen) state.polling = false;
  }
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
  try {
    const res = await rpc('get_messages', { p_room: state.roomId, p_before: state.firstId, p_limit: PAGE });
    if (gen !== state.gen) return;
    const list = $('list');
    const prevHeight = list.scrollHeight;
    for (const m of res.messages) await upsertRow(m, true);
    if (res.messages.length) state.firstId = res.messages[0].id;
    $('older').hidden = res.messages.length < PAGE;
    list.scrollTop += list.scrollHeight - prevHeight;
    updateEmpty();
  } catch {
    setStatus('加载失败');
  } finally {
    $('older').disabled = false;
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
  let before = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (+rows[i].dataset.id < id) { before = rows[i].nextSibling; break; }
    if (i === 0) before = rows[0];
  }
  $('list').insertBefore(node, before);
}

function clearList() {
  for (const n of $('list').querySelectorAll('.row')) n.remove();
  $('older').hidden = true;
  $('empty').hidden = true;
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
  const time = new Date(m.created_at).toLocaleString('zh-CN', { hour12: false });

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

  state.msgs.set(m.id, msg);
  if (mine) row.classList.add('me');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('span');
  label.textContent = `${name} · ${time}`;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more';
  more.textContent = '⋯';
  more.setAttribute('aria-label', '消息操作');
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => toggleActions(row, m.id, msg, mine, more));
  if (mine) meta.append(more, label); else meta.append(label, more);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.t === 'img' && typeof msg.b === 'string') {
    bubble.classList.add('img');
    bubble.textContent = '图片加载中…';
    loadImage(msg, bubble);
  } else {
    bubble.textContent = String(msg.x ?? '');
  }
  row.append(meta, bubble);
  return row;
}

function toggleActions(row, id, msg, mine, btn) {
  const open = row.querySelector('.actions');
  if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
  const bar = document.createElement('div');
  bar.className = 'actions';
  const add = (text, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  };
  if (msg.t !== 'img') add('复制', async () => { try { await navigator.clipboard.writeText(String(msg.x ?? '')); setStatus('已复制'); } catch { setStatus('复制失败'); } bar.remove(); });
  if (mine) add('撤回', () => recall(id));
  add('删除', () => deleteLocal(id));
  row.appendChild(bar);
  btn.setAttribute('aria-expanded', 'true');
  bar.querySelector('button').focus();
}

async function recall(id) {
  try {
    const payload = await encryptJSON(state.key, state.roomId, { t: 'recall', n: state.nick, c: clientId, ts: Date.now() });
    const ok = await rpc('recall_message', { p_room: state.roomId, p_id: id, p_token: state.token, p_payload: payload });
    if (!ok) alert('无法撤回：只能撤回在这台设备上发送的消息');
    schedulePoll(0);
  } catch (e) {
    alert('撤回失败：' + e.message);
  }
}

function deleteLocal(id) {
  if (!confirm('仅从此设备删除这条消息？（其他人仍能看到；要让所有人都看不到请用“撤回”）')) return;
  state.hidden.add(id);
  lsSet(hiddenKey(state.roomId), [...state.hidden].slice(-5000));
  rowEl(id)?.remove();
  updateEmpty();
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
    img.alt = '图片';
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
async function sendPayload(obj, blobId = null) {
  const payload = await encryptJSON(state.key, state.roomId, { ...obj, n: state.nick || '某人', c: clientId, ts: Date.now() });
  await rpc('send_message', { p_room: state.roomId, p_payload: payload, p_owner_hash: state.ownerHash, p_blob_id: blobId });
  state.stick = true;
  schedulePoll(0);
}

async function sendText() {
  const ta = $('text');
  const text = ta.value.trim();
  if (!text || !state.nick) return;
  $('send').disabled = true;
  try {
    await sendPayload({ t: 'text', x: text });
    ta.value = '';
    autoGrow();
  } catch (e) {
    alert('发送失败：' + e.message);
  } finally {
    $('send').disabled = false;
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
    setStatus('处理图片…');
    const img = await compressImage(file);
    setStatus('');
    if (state.pendingImg) URL.revokeObjectURL(state.pendingImg.url);
    state.pendingImg = { ...img, url: URL.createObjectURL(img.blob) };
    $('preview-img').src = state.pendingImg.url;
    $('preview-info').textContent = `${img.w}×${img.h}，${fmtBytes(img.bytes.length)}（已压缩并去除位置信息）`;
    $('preview-dlg').showModal();
    $('preview-send').focus();
  } catch (e) {
    setStatus('');
    alert('无法读取图片：' + e.message);
  }
}

async function sendPendingImage() {
  const p = state.pendingImg;
  $('preview-dlg').close();
  if (!p) return;
  setStatus('图片加密上传中…');
  try {
    const data = await encryptBytes(state.key, state.roomId, p.bytes);
    const blobId = await rpc('put_blob', { p_room: state.roomId, p_data: data });
    await sendPayload({ t: 'img', b: blobId }, blobId);
    setStatus('');
  } catch (e) {
    setStatus('');
    alert('图片发送失败：' + e.message);
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
    b.textContent = r.name || '未命名聊天室';
    if (r.k === state.k) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { $('rooms-dlg').close(); if (r.k !== state.k) openRoom(r.k); });
    li.appendChild(b);
    ul.appendChild(li);
  }
  $('rooms-msg').textContent = '';
  $('rooms-link').value = '';
  $('rooms-dlg').showModal();
}

async function createRoom() {
  const input = prompt('给新聊天室起个名字', '聊天室-' + randHex(2).toUpperCase());
  if (input === null) return;
  const name = cleanRoom(input) || '新聊天室';
  const k = newLinkKey();
  addRoom(k, name);
  if ($('rooms-dlg').open) $('rooms-dlg').close();
  await openRoom(k);
  try {
    await rpc('set_room_name', { p_room: state.roomId, p_name_payload: await encryptJSON(state.key, state.roomId, { name }) });
  } catch { /* 下次修改名称时会再保存 */ }
  openSettings('聊天室已创建，复制下面的邀请链接发给朋友');
}

function joinByLink(text, msgEl) {
  const k = extractKey(text);
  if (!k) { msgEl.textContent = '链接无效，请检查是否复制完整'; return; }
  addRoom(k);
  if ($('rooms-dlg').open) $('rooms-dlg').close();
  openRoom(k);
}

// ---------- 设置 ----------
async function openSettings(msg = '') {
  $('nick-input').value = state.nick;
  $('roomname-input').value = state.name;
  $('invite-url').value = location.origin + location.pathname + '#k=' + state.k;
  $('retention').value = state.retention == null ? '' : String(state.retention);
  $('notify').checked = !!lsGet(LS.notify, false) && 'Notification' in window && Notification.permission === 'granted';
  $('notify').disabled = !('Notification' in window);
  $('settings-msg').textContent = msg;
  $('settings-dlg').showModal();
  refreshUsage();
}

async function refreshUsage() {
  $('usage').textContent = '存储占用：计算中…';
  try {
    const u = await rpc('room_usage', { p_room: state.roomId });
    $('usage').textContent = `本聊天室：${u.messages} 条消息、${u.images} 张图片，约 ${fmtBytes(u.bytes)}。`
      + `数据库总占用 ${fmtBytes(u.db_bytes)} / 500 MB（Supabase 免费额度）。`;
  } catch {
    $('usage').textContent = '存储占用：获取失败';
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
    $('settings-msg').textContent = '聊天室名称已修改';
  } catch (err) {
    alert('修改失败：' + err.message);
  }
}

async function changeRetention() {
  const v = $('retention').value;
  const d = v === '' ? null : parseInt(v, 10);
  if (d === state.retention) return;
  if (d != null && !confirm(`超过 ${retentionLabel(d)}的消息和图片将被永久删除（对所有人生效），确定？`)) {
    $('retention').value = state.retention == null ? '' : String(state.retention);
    return;
  }
  try {
    await rpc('set_retention', { p_room: state.roomId, p_days: d });
    state.retention = d;
    enforceRetention();
    await sendPayload({ t: 'retention', d });
    $('settings-msg').textContent = '保留时间已设为' + retentionLabel(d);
    refreshUsage();
  } catch (err) {
    alert('设置失败：' + err.message);
  }
}

async function toggleNotify() {
  if (!$('notify').checked) { lsSet(LS.notify, false); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') { lsSet(LS.notify, true); $('settings-msg').textContent = '已开启桌面通知'; }
  else { $('notify').checked = false; $('settings-msg').textContent = '浏览器未允许通知'; }
}

function notifyNew() {
  if (!lsGet(LS.notify, false) || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('Notes', { body: '有新消息', tag: 'privchat' }); } catch { /* 部分手机浏览器不支持 */ }
}

async function clearRoom() {
  if (!confirm('将永久删除本聊天室的所有消息和图片（所有人都看不到了），无法恢复。确定？')) return;
  try {
    await rpc('clear_room', { p_room: state.roomId });
    clearList();
    await sendPayload({ t: 'clear' });
    $('settings-msg').textContent = '已清空';
    refreshUsage();
  } catch (err) {
    alert('清空失败：' + err.message);
  }
}

function leaveRoom() {
  if (!confirm('从此设备移除该聊天室？（聊天记录不会被删除，以后可用邀请链接重新加入）')) return;
  saveRooms(getRooms().filter((r) => r.k !== state.k));
  localStorage.removeItem(hiddenKey(state.roomId));
  $('settings-dlg').close();
  const rest = getRooms();
  if (rest.length) openRoom(rest[0].k); else { localStorage.removeItem(LS.cur); showNoKey('已移除'); }
}

// ---------- 小工具 ----------
function isNearBottom() {
  const l = $('list');
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}
function scrollToBottom() { const l = $('list'); l.scrollTop = l.scrollHeight; }
function updateEmpty() { $('empty').hidden = !!$('list').querySelector('.row'); }
function setStatus(s) { $('status').textContent = s; }
function updateTitle() { document.title = state.unread ? `(${state.unread}) Notes` : 'Notes'; }
function autoGrow() {
  const ta = $('text');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

// ---------- 事件绑定 ----------
$('nokey-join').addEventListener('submit', (e) => { e.preventDefault(); joinByLink($('nokey-link').value, $('nokey-msg')); });
$('nokey-create').addEventListener('click', createRoom);
$('rooms-btn').addEventListener('click', openRoomsDialog);
$('online-btn').addEventListener('click', () => { renderOnline(); $('online-dlg').showModal(); });
$('rooms-create').addEventListener('click', createRoom);
$('rooms-join').addEventListener('submit', (e) => { e.preventDefault(); joinByLink($('rooms-link').value, $('rooms-msg')); });
$('settings-btn').addEventListener('click', () => openSettings());
$('nick-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = cleanName($('nick-input').value);
  if (n) { setNick(n); $('settings-msg').textContent = '名字已保存'; }
});
$('roomname-form').addEventListener('submit', saveRoomName);
$('invite-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('invite-url').value); } catch { $('invite-url').select(); document.execCommand('copy'); }
  $('settings-msg').textContent = '邀请链接已复制';
});
$('retention').addEventListener('change', changeRetention);
$('notify').addEventListener('change', toggleNotify);
$('clear-room').addEventListener('click', clearRoom);
$('leave-room').addEventListener('click', leaveRoom);
for (const b of document.querySelectorAll('.close-dlg')) b.addEventListener('click', () => b.closest('dialog').close());
$('preview-send').addEventListener('click', sendPendingImage);
$('preview-dlg').addEventListener('close', () => {
  if (state.pendingImg) { URL.revokeObjectURL(state.pendingImg.url); state.pendingImg = null; }
  $('text').focus();
});

$('join').addEventListener('submit', (e) => {
  e.preventDefault();
  setNick(cleanName($('join-name').value) || randomName());
  $('text').focus();
});
$('older').addEventListener('click', loadOlder);
$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
$('text').addEventListener('input', autoGrow);
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
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

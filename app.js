import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { deriveRoom, encryptJSON, decryptJSON, encryptBytes, decryptBytes } from './crypto.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'privchat.v1';
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;
const PAGE = 50;
const MAX_IMG_SIDE = 1600;
const MAX_IMG_BYTES = 2_000_000;

// 每台设备一个随机 id，用来区分“我自己”的消息
let clientId = localStorage.getItem('privchat.cid');
if (!clientId) {
  clientId = crypto.randomUUID();
  localStorage.setItem('privchat.cid', clientId);
}

const state = {
  nick: '', roomName: '', key: null, roomId: '',
  firstId: null, lastId: 0, timer: null, polling: false, unread: 0, blobUrls: [],
};

// ---------- Supabase RPC（直接 fetch，无第三方库） ----------
async function rpc(fn, args) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY; // 旧版 anon JWT
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${fn} 失败 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- 登录 / 退出 ----------
async function enter(nick, roomName, pass, remember) {
  $('login-btn').disabled = true;
  $('login-msg').textContent = '正在生成密钥…';
  try {
    const { key, roomId } = await deriveRoom(roomName, pass);
    Object.assign(state, { nick, roomName, key, roomId, firstId: null, lastId: 0, unread: 0 });
    if (remember) localStorage.setItem(STORE_KEY, JSON.stringify({ nick, roomName, pass }));
    else localStorage.removeItem(STORE_KEY);
    localStorage.setItem('privchat.nick', nick);

    $('login').hidden = true;
    $('chat').hidden = false;
    $('room-title').textContent = roomName;
    $('pass').value = '';
    await loadInitial();
    schedulePoll(0);
    $('text').focus();
  } catch (e) {
    $('login').hidden = false;
    $('chat').hidden = true;
    $('login-msg').textContent = '进入失败：' + e.message;
  } finally {
    $('login-btn').disabled = false;
  }
}

function logout() {
  clearTimeout(state.timer);
  localStorage.removeItem(STORE_KEY);
  state.blobUrls.forEach((u) => URL.revokeObjectURL(u));
  Object.assign(state, { key: null, roomId: '', blobUrls: [], firstId: null, lastId: 0 });
  [...$('list').querySelectorAll('.row')].forEach((n) => n.remove());
  $('chat').hidden = true;
  $('login').hidden = false;
  $('login-msg').textContent = '';
  document.title = 'Notes';
}

// ---------- 收消息 ----------
async function loadInitial() {
  const rows = await rpc('get_messages', { p_room: state.roomId, p_limit: PAGE });
  for (const r of rows) await appendRow(r, false);
  if (rows.length) {
    state.firstId = rows[0].id;
    state.lastId = rows[rows.length - 1].id;
  }
  $('older').hidden = rows.length < PAGE;
  scrollToBottom();
}

async function loadOlder() {
  if (state.firstId == null) return;
  $('older').disabled = true;
  try {
    const rows = await rpc('get_messages', { p_room: state.roomId, p_before: state.firstId, p_limit: PAGE });
    const list = $('list');
    const prevHeight = list.scrollHeight;
    const anchor = $('older').nextSibling;
    for (const r of rows) list.insertBefore(await renderRow(r), anchor);
    if (rows.length) state.firstId = rows[0].id;
    $('older').hidden = rows.length < PAGE;
    list.scrollTop += list.scrollHeight - prevHeight;
  } catch (e) {
    setStatus('加载失败');
  } finally {
    $('older').disabled = false;
  }
}

async function poll() {
  if (!state.key || state.polling) return;
  state.polling = true;
  try {
    const rows = await rpc('get_messages', { p_room: state.roomId, p_after: state.lastId, p_limit: 200 });
    const atBottom = isNearBottom();
    for (const r of rows) {
      const mine = await appendRow(r, true);
      state.lastId = Math.max(state.lastId, r.id);
      if (state.firstId == null) state.firstId = r.id;
      if (document.hidden && !mine) state.unread++;
    }
    if (rows.length && atBottom) scrollToBottom();
    updateTitle();
    setStatus('');
  } catch (e) {
    setStatus('连接异常，重试中…');
  } finally {
    state.polling = false;
  }
}

function schedulePoll(delay) {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    await poll();
    if (state.key) schedulePoll(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
  }, delay);
}

// ---------- 渲染（全部使用 textContent，避免 XSS） ----------
async function renderRow(r) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = r.id;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const time = new Date(r.created_at).toLocaleString('zh-CN', { hour12: false });

  let msg;
  try {
    msg = await decryptJSON(state.key, state.roomId, r.payload);
  } catch {
    meta.textContent = time;
    bubble.classList.add('bad');
    bubble.textContent = '[无法解密的消息]';
    row.append(meta, bubble);
    return row;
  }
  if (msg.c === clientId) row.classList.add('me');
  meta.textContent = `${String(msg.n || '?').slice(0, 20)} · ${time}`;

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

async function appendRow(r, dedupe) {
  if (dedupe && $('list').querySelector(`.row[data-id="${Number(r.id)}"]`)) return false;
  const node = await renderRow(r);
  $('list').appendChild(node);
  return node.classList.contains('me');
}

async function loadImage(msg, bubble) {
  try {
    const data = await rpc('get_blob', { p_room: state.roomId, p_id: msg.b });
    if (!data) throw new Error('missing');
    const bytes = await decryptBytes(state.key, state.roomId, data);
    const url = URL.createObjectURL(new Blob([bytes], { type: msg.m || 'image/jpeg' }));
    state.blobUrls.push(url);
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
    bubble.textContent = '[图片加载失败]';
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
async function sendPayload(obj) {
  const payload = await encryptJSON(state.key, state.roomId, { ...obj, n: state.nick, c: clientId, ts: Date.now() });
  await rpc('send_message', { p_room: state.roomId, p_payload: payload });
  schedulePoll(0);
}

async function sendText() {
  const ta = $('text');
  const text = ta.value.trim();
  if (!text) return;
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
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_IMG_BYTES) {
      bmp.close();
      return new Uint8Array(await blob.arrayBuffer());
    }
    quality = Math.max(0.5, quality - 0.1);
    scale *= 0.8;
  }
  bmp.close();
  throw new Error('图片太大');
}

async function sendImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  setStatus('图片加密上传中…');
  try {
    const bytes = await compressImage(file);
    const data = await encryptBytes(state.key, state.roomId, bytes);
    const blobId = await rpc('put_blob', { p_room: state.roomId, p_data: data });
    await sendPayload({ t: 'img', b: blobId, m: 'image/jpeg' });
    setStatus('');
  } catch (e) {
    setStatus('');
    alert('图片发送失败：' + e.message);
  }
}

// ---------- 小工具 ----------
function isNearBottom() {
  const l = $('list');
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}
function scrollToBottom() {
  const l = $('list');
  l.scrollTop = l.scrollHeight;
}
function setStatus(s) { $('status').textContent = s; }
function updateTitle() { document.title = state.unread ? `(${state.unread}) Notes` : 'Notes'; }
function autoGrow() {
  const ta = $('text');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

// ---------- 事件绑定 ----------
$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const nick = $('nick').value.trim();
  const room = $('room').value.trim();
  const pass = $('pass').value;
  if (!nick || !room || pass.length < 8) {
    $('login-msg').textContent = '请填写昵称、房间名，口令至少 8 位';
    return;
  }
  enter(nick, room, pass, $('remember').checked);
});
$('logout').addEventListener('click', logout);
$('older').addEventListener('click', loadOlder);
$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
$('text').addEventListener('input', autoGrow);
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
});
$('file').addEventListener('change', (e) => { sendImage(e.target.files[0]); e.target.value = ''; });
$('text').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); sendImage(item.getAsFile()); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { state.unread = 0; updateTitle(); if (state.key) schedulePoll(0); }
});

// ---------- 启动 ----------
if (SUPABASE_URL.includes('YOUR-PROJECT')) {
  $('login-msg').textContent = '尚未配置：请先编辑 config.js 填入 Supabase 地址和 key';
  $('login-btn').disabled = true;
} else {
  $('nick').value = localStorage.getItem('privchat.nick') || '';
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.nick && saved?.roomName && saved?.pass) {
      $('remember').checked = true;
      enter(saved.nick, saved.roomName, saved.pass, true);
    }
  } catch { localStorage.removeItem(STORE_KEY); }
}

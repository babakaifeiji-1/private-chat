// 端到端加密工具：全部使用浏览器内置的 Web Crypto API，无第三方依赖。
//
// 房间名 + 口令 --PBKDF2-SHA256(600k 次)--> 512 bit
//   前 256 bit  => AES-256-GCM 密钥（只存在于浏览器内存中）
//   后 256 bit  => 再做 SHA-256 => roomId（发给服务器用来区分房间，无法反推口令/密钥）

const te = new TextEncoder();
const td = new TextDecoder();
const PBKDF2_ITERATIONS = 600000;

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToB64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function deriveRoom(roomName, passphrase) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('privchat-v1|' + roomName), iterations: PBKDF2_ITERATIONS },
      base,
      512,
    ),
  );
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const roomId = toHex(await crypto.subtle.digest('SHA-256', bits.slice(32)));
  bits.fill(0);
  return { key, roomId };
}

// 加密：输出 base64(iv[12] || ciphertext+tag)，并以 roomId 作为附加认证数据
export async function encryptBytes(key, roomId, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(roomId) }, key, bytes),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return bytesToB64(out);
}

export async function decryptBytes(key, roomId, b64) {
  const data = b64ToBytes(b64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: te.encode(roomId) },
    key,
    data.subarray(12),
  );
  return new Uint8Array(pt);
}

export async function encryptJSON(key, roomId, obj) {
  return encryptBytes(key, roomId, te.encode(JSON.stringify(obj)));
}

export async function decryptJSON(key, roomId, b64) {
  return JSON.parse(td.decode(await decryptBytes(key, roomId, b64)));
}

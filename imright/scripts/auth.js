/**
 * Password-gate helpers for serve-site.js: constant-time password check,
 * signed session cookies (HMAC, no server-side session store needed), and a
 * simple in-memory brute-force limiter keyed by IP.
 */

import crypto from 'crypto';

const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const ATTEMPT_LIMIT = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const attemptsByIp = new Map();

/** Timing-safe string compare. Hashing first also equalizes length, so the
 * comparison itself never leaks how many leading characters matched. */
export function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function isLockedOut(ip) {
  const record = attemptsByIp.get(ip);
  return Boolean(record && record.lockedUntil && Date.now() < record.lockedUntil);
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  let record = attemptsByIp.get(ip);
  if (!record || now - record.windowStart > ATTEMPT_WINDOW_MS) {
    record = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  record.count += 1;
  if (record.count >= ATTEMPT_LIMIT) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.count = 0;
    record.windowStart = now;
  }
  attemptsByIp.set(ip, record);
}

export function recordLoginSuccess(ip) {
  attemptsByIp.delete(ip);
}

/** expiresAt.signature — signature covers expiresAt only, so a forged or
 * tampered expiry is rejected by the HMAC check before the expiry check runs. */
export function createSessionToken(secret, maxAgeMs) {
  const expiresAt = Date.now() + maxAgeMs;
  const signature = crypto.createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

export function verifySessionToken(token, secret) {
  if (typeof token !== 'string') return false;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return false;
  const expiresAtRaw = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expectedSignature = crypto.createHmac('sha256', secret).update(expiresAtRaw).digest('hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const pair of header.split(';')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export function buildSessionCookie(name, value, maxAgeMs, secure) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildExpiredCookie(name, secure) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

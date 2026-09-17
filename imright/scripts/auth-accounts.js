/**
 * Real user accounts: guest identity resolution/provisioning, signup
 * (guest -> account "claim"), login/logout, and durable per-account lockout.
 *
 * Deliberately separate from auth.js, which keeps guarding the two
 * pre-existing, unrelated site-wide password gates (the visitor lock and the
 * admin dashboard) — those aren't "accounts" and don't need to change.
 *
 * Identity here is split into two steps, on purpose:
 *   - resolveUser(): read-only, safe on every request, never writes a row.
 *   - ensureOwner(): the only path that ever mints a new guest `users` row,
 *     called explicitly by the few endpoints that create owned content
 *     (in practice, just POST /api/run). This avoids minting a permanent DB
 *     row for every drive-by pageview/bot/crawler that never generates
 *     anything — see the plan's guest-identity write-up for why that matters.
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { eq, and, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { parseCookies, getClientIp } from './auth.js';
import { appendSetCookie } from './identity.js';
import { HttpError } from './http-error.js';

const GUEST_COOKIE_NAME = 'imright_guest';
const SESSION_COOKIE_NAME = 'imright_uid';
const GUEST_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // 400 days: the practical browser cap
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_STALE_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const BCRYPT_COST = 12;
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A precomputed hash of a value nobody will ever type, compared against on a
// login attempt for a username that doesn't exist — so "no such user" and
// "wrong password" take the same amount of time and don't leak which one it
// was via a timing side channel (same spirit as auth.js's safeCompare).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('imright-dummy-hash-never-a-real-password', BCRYPT_COST);

function isSecureRequest(req) {
  return Boolean(req.secure) || req.headers['x-forwarded-proto'] === 'https';
}

function buildCookie(name, value, maxAgeMs, secure) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildExpiredCookie(name, secure) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    isGuest: row.isGuest,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
  };
}

function isUniqueViolation(error, constraintName) {
  // drizzle-orm wraps the real `pg` error (with .code/.constraint) under .cause
  // as a DrizzleQueryError, rather than exposing those fields directly.
  const pgError = error?.cause ?? error;
  return pgError?.code === '23505' && (!constraintName || pgError?.constraint === constraintName);
}

/**
 * Read-only identity resolution — call once per request, before routes.
 * Sets req.user (or null) and never writes to the database.
 */
export async function resolveUser(req, res) {
  const db = getDb();
  if (!db) {
    req.user = null;
    return null;
  }
  const secure = isSecureRequest(req);
  const cookies = parseCookies(req.headers.cookie);

  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId) {
    const rows = await db
      .select({ user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.id, sessionId), sql`${schema.sessions.expiresAt} > now()`))
      .limit(1);
    if (rows[0]) {
      // Fire-and-forget — not on the request's critical path.
      db.update(schema.sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.sessions.id, sessionId))
        .catch((error) => console.error('[auth] last_seen_at update failed:', error?.message ?? error));
      req.user = toPublicUser(rows[0].user);
      return req.user;
    }
    // Present but expired/deleted: stop the browser resending a dead token.
    appendSetCookie(res, buildExpiredCookie(SESSION_COOKIE_NAME, secure));
  }

  const guestCookieId = cookies[GUEST_COOKIE_NAME];
  if (guestCookieId) {
    const rows = await db.select().from(schema.users).where(eq(schema.users.guestCookieId, guestCookieId)).limit(1);
    if (rows[0]) {
      req.user = toPublicUser(rows[0]);
      return req.user;
    }
  }

  req.user = null;
  return null;
}

/**
 * The only code path that ever mints a guest `users` row. Call explicitly
 * from endpoints that create owned content for the first time.
 */
export async function ensureOwner(req, res) {
  if (req.user) return req.user;
  const db = getDb();
  if (!db) throw new HttpError(503, 'database_unavailable');

  const guestCookieId = crypto.randomUUID();
  const [row] = await db
    .insert(schema.users)
    .values({ isGuest: true, guestCookieId, displayName: 'Anonymous' })
    .returning();
  appendSetCookie(res, buildCookie(GUEST_COOKIE_NAME, guestCookieId, GUEST_MAX_AGE_MS, isSecureRequest(req)));
  req.user = toPublicUser(row);
  return req.user;
}

async function createSession(db, userId, req, res) {
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  const [row] = await db
    .insert(schema.sessions)
    .values({
      userId,
      expiresAt,
      userAgent: req.headers['user-agent'] ?? null,
      ip: getClientIp(req),
    })
    .returning();
  appendSetCookie(res, buildCookie(SESSION_COOKIE_NAME, row.id, SESSION_MAX_AGE_MS, isSecureRequest(req)));
  return row;
}

/** Guest -> account "claim": same PK before and after, so every article a
 * guest already created stays owned by the same row, no migration needed. */
export async function signup(req, res, { username, email, password, displayName }) {
  const db = getDb();
  if (!db) throw new HttpError(503, 'database_unavailable');
  if (req.user && !req.user.isGuest) throw new HttpError(409, 'already_logged_in');
  // A visitor who came straight to /signup without ever submitting an idea
  // has no identity yet (resolveUser never provisions one — see its
  // docstring). Signing up is itself a valid reason to provision one now,
  // same as POST /api/run: there's nothing to "claim" onto otherwise.
  if (!req.user) await ensureOwner(req, res);

  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, 'invalid_username');
  }
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, 'invalid_email');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'weak_password');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const setValues = {
    isGuest: false,
    username,
    email,
    passwordHash,
    claimedAt: new Date(),
    updatedAt: new Date(),
  };
  const trimmedDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
  if (trimmedDisplayName) setValues.displayName = trimmedDisplayName.slice(0, 50);

  let claimed;
  try {
    const rows = await db
      .update(schema.users)
      .set(setValues)
      .where(and(eq(schema.users.id, req.user.id), eq(schema.users.isGuest, true)))
      .returning();
    claimed = rows[0];
  } catch (error) {
    if (isUniqueViolation(error, 'users_username_unique')) throw new HttpError(409, 'username_taken');
    if (isUniqueViolation(error, 'users_email_unique')) throw new HttpError(409, 'email_taken');
    throw error;
  }
  if (!claimed) throw new HttpError(409, 'already_claimed');

  await createSession(db, claimed.id, req, res);
  req.user = toPublicUser(claimed);
  return req.user;
}

async function recordLoginFailure(db, account) {
  const attempts = account.failedLoginAttempts + 1;
  const patch = { failedLoginAttempts: attempts };
  if (attempts >= LOCKOUT_THRESHOLD) {
    patch.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    patch.failedLoginAttempts = 0;
  }
  await db.update(schema.users).set(patch).where(eq(schema.users.id, account.id));
}

export async function login(req, res, { username, password }) {
  const db = getDb();
  if (!db) throw new HttpError(503, 'database_unavailable');
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'missing_credentials');
  }

  const [account] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.username, username), eq(schema.users.isGuest, false)))
    .limit(1);

  if (account && account.lockedUntil && new Date(account.lockedUntil) > new Date()) {
    throw new HttpError(429, 'account_locked');
  }

  const passwordOk = await bcrypt.compare(password, account ? account.passwordHash : DUMMY_PASSWORD_HASH);
  if (!account || !passwordOk) {
    if (account) await recordLoginFailure(db, account);
    throw new HttpError(401, 'invalid_credentials');
  }

  await db.update(schema.users).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(schema.users.id, account.id));
  await createSession(db, account.id, req, res);
  req.user = toPublicUser(account);
  return req.user;
}

export async function logout(req, res) {
  const db = getDb();
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (db && sessionId) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
  }
  // imright_guest is deliberately left alone here: if this browser had a
  // pre-login guest identity, logging out reverts to it rather than losing it.
  appendSetCookie(res, buildExpiredCookie(SESSION_COOKIE_NAME, isSecureRequest(req)));
  req.user = null;
}

/** Nothing above ever deletes an expired session row — call once per process
 * start so the table doesn't grow unboundedly. Storage-only concern: a row
 * past its expires_at is already inert for auth (see resolveUser above). */
export async function sweepExpiredSessions() {
  const db = getDb();
  if (!db) return;
  await db
    .delete(schema.sessions)
    .where(sql`${schema.sessions.expiresAt} < now() - make_interval(secs => ${SESSION_STALE_CLEANUP_AGE_MS / 1000})`);
}

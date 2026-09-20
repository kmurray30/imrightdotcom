/**
 * Real-account auth routes. Namespaced under /api/account/* specifically to
 * avoid colliding with the pre-existing, unrelated /api/login + /api/logout
 * (the site-wide password gate, handled elsewhere in serve-site.js and left
 * untouched by this feature).
 */

import { Router } from 'express';
import { signup, login, logout } from '../auth-accounts.js';

export const accountRouter = Router();

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    isGuest: user.isGuest,
    username: user.username ?? null,
    displayName: user.displayName,
    email: user.email ?? null,
  };
}

accountRouter.get('/me', (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

accountRouter.post('/signup', async (req, res, next) => {
  try {
    const { username, email, password, displayName } = req.body ?? {};
    const user = await signup(req, res, { username, email, password, displayName });
    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

accountRouter.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    const user = await login(req, res, { username, password });
    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

accountRouter.post('/logout', async (req, res, next) => {
  try {
    await logout(req, res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

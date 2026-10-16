import { HttpError } from './http-error.js';

/** Rejects anyone whose account isn't flagged is_admin (404, not 403 — a
 * non-admin, logged-in or not, gets the same "not found" a bad article id
 * would, rather than a response that confirms an admin-only route exists
 * at this path). Real accounts only: req.user.isAdmin is never true for a
 * guest (see auth-accounts.js's toPublicUser / users.isAdmin's schema
 * default), so this also implicitly requires being logged in. */
export function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    next(new HttpError(404, 'not_found'));
    return;
  }
  next();
}

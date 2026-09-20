import { HttpError } from './http-error.js';

/** Rejects guests (403 { error: 'account_required' }) — enforced here at the
 * API layer, not the schema, since "is this owner currently a guest" is a
 * cross-table business rule a CHECK constraint can't express. */
export function requireAccount(req, res, next) {
  if (!req.user || req.user.isGuest) {
    next(new HttpError(403, 'account_required'));
    return;
  }
  next();
}

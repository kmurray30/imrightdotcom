/**
 * DB access for feedback submitted from the header menu — one module per
 * concern, same pattern as articles.js/auth-accounts.js.
 */

import { getDb, schema } from './db/index.js';
import { HttpError } from './http-error.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE_LENGTH = 5000;

export async function submitFeedback({ userId, email, message }) {
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (!trimmedMessage) throw new HttpError(400, 'empty_message');
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, 'message_too_long');

  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (!EMAIL_PATTERN.test(trimmedEmail)) throw new HttpError(400, 'invalid_email');

  const db = getDb();
  if (!db) throw new HttpError(503, 'database_unavailable');
  const [row] = await db
    .insert(schema.feedback)
    .values({ userId: userId ?? null, email: trimmedEmail, message: trimmedMessage })
    .returning();
  return row;
}

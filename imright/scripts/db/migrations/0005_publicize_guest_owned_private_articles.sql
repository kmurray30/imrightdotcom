-- One-time backfill: articles created before this feature existed were
-- private by default with no way for a guest to change that (VisibilityToggle
-- was guest-gated), so every guest-owned private article is private only as
-- an accident of the old default, never a deliberate choice. Publicize them
-- retroactively. Real-account-owned private articles are left untouched —
-- those reflect an actual choice someone with the ability to toggle made.
UPDATE articles
SET is_public = true, updated_at = now()
FROM users
WHERE articles.owner_user_id = users.id
  AND users.is_guest = true
  AND articles.is_public = false;

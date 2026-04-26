-- A2-716: replace the single-column `pending_payouts_user` index
-- with a composite (user_id, created_at) so `listPayoutsForUser`
-- (admin user-detail page) can satisfy the
-- `WHERE user_id = ? ORDER BY created_at DESC` shape with an
-- index-only scan instead of a filter+sort.
--
-- The composite covers every lookup the single-column did, so
-- dropping the old index is safe.

DROP INDEX IF EXISTS pending_payouts_user;

CREATE INDEX IF NOT EXISTS pending_payouts_user_created
  ON pending_payouts (user_id, created_at);

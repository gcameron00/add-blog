-- Phase 5e (authors). Additive per 0001's header — an old Worker version
-- reads a row with this column present but unused, no different from any
-- other rollout, so no coordination needed beyond applying the file.
--
-- 0 (default) means active; a disabled author keeps their row, their post
-- history, and their `role` — only src/auth.js's resolveAuthor stops
-- resolving them, so the Access identity itself is untouched and existing
-- posts don't need reassigning the way a delete does.
ALTER TABLE authors ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

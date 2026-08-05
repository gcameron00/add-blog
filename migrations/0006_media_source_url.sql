-- WordPress WXR import (Phase 7) needs to know, on a later /run call, which
-- attachment URLs it already fetched successfully — without this, a
-- resumed import would have to re-fetch every attachment from scratch to
-- recompute a checksum just to find out it already has it, burning the
-- Workers per-invocation subrequest budget on nothing. Nullable and unused
-- by every other write path (direct upload, MCP's upload_media_from_url) —
-- an additive column, not a rebuild.
ALTER TABLE media ADD COLUMN source_url TEXT;

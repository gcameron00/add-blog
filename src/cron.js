/**
 * Scheduled Worker handler (Phase 5f). One job: sweep `scheduled` posts
 * whose `scheduled_for` has arrived and publish them — the piece
 * `POST /:id/schedule` (src/admin-posts.js) always deferred to "something
 * that runs later". Revision retention doesn't need a cron; it's trimmed
 * on write instead (see MAX_REVISIONS_PER_POST in src/admin-db.js).
 *
 * No identity fires a cron, so audit entries use actor='system',
 * via='cron' — a `via` migrations/0003_audit_via_cron.sql added, since
 * the original CHECK only allowed 'ui'/'mcp'/'api'.
 */
import { getDueScheduledPosts, updatePostRow } from './admin-db.js';
import { writeAuditLog } from './audit.js';
import { purgePostUrls } from './cache-purge.js';

export async function publishDuePosts(env) {
  if (!env.DB) return { published: 0 };

  const now = new Date().toISOString();
  const due = await getDueScheduledPosts(env.DB, now);

  for (const post of due) {
    await updatePostRow(env.DB, post.id, {
      status: 'published',
      published_at: post.published_at || post.scheduled_for || now,
      scheduled_for: null,
      updated_at: now,
    });
    await writeAuditLog(env.DB, {
      actor: 'system',
      via: 'cron',
      action: 'post.publish',
      entity: 'post',
      entityId: post.id,
      detail: { title: post.title, scheduled_for: post.scheduled_for },
    });
    if (env.PUBLIC_HOST) {
      await purgePostUrls(`https://${env.PUBLIC_HOST}`, {
        slug: post.slug,
        tags: post.tags.map((t) => t.slug),
      });
    }
  }

  return { published: due.length };
}

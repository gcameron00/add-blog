/**
 * `audit_log` writer, per docs/architecture.md §6 ("every mutation writes to
 * audit_log"). Phase 4 has no mutations yet — nothing calls this — but the
 * identity work is what an audit entry's `actor` depends on, so the helper
 * belongs here rather than being invented ad hoc when Phase 5's write routes
 * need it. `via` distinguishes the admin UI from `/mcp` (Phase 6), per the
 * "an agent can never do something its human operator could not" rule.
 */
export async function writeAuditLog(db, { actor, via, action, entity = null, entityId = null, detail = null }) {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor, via, action, entity, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      actor,
      via,
      action,
      entity,
      entityId,
      detail ? JSON.stringify(detail) : null,
      new Date().toISOString()
    )
    .run();
}

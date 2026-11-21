import { decrypt, encrypt, sha } from './auth';
import { MAX_EXPORT_PAGE_SIZE } from '../shared/export-limits';

type ExportSnapshot = {
  scope: string;
  groupScope: string;
  snapshotAt: string;
  watermark: number;
  eligibleCount: number;
  unfinishedCount: number;
};
type ExportRow = { id: string; taskId: string; groupId: string; name: string; relativePath: string; size: number; createdAt: string };
type SnapshotQuery = {
  db: D1Database;
  key: string;
  actor: { id: string; role: string };
  url: URL;
  page: { limit: number; cursor: string } | null;
  where: string;
  args: unknown[];
  fail: (status: number, message: string) => never;
};

export async function exportSnapshotPage({ db, key, actor, url, page, where, args, fail }: SnapshotQuery) {
  const requested = url.searchParams.get('snapshot');
  const verify = url.searchParams.get('verify') === '1';
  if (!page || !requested || requested.length > 8192 || (requested === 'new' && (page.cursor || verify))) {
    return fail(400, '导出快照请求无效');
  }
  if (!key) fail(503, '导出快照服务暂不可用');
  const ids = [...new Set(url.searchParams.getAll('id'))].sort();
  if (ids.length > 100 || ids.some(id => !id || id.length > 200 || /[\u0000-\u001f]/.test(id))) {
    fail(400, '每次最多选择100张图片导出');
  }
  if (ids.length) {
    where += ' AND f.id IN (SELECT value FROM json_each(?))';
    args = [...args, JSON.stringify(ids)];
  }
  const scope = await sha(JSON.stringify([where, args]));
  const secret = key + ':export-snapshot:v1';
  const now = new Date().toISOString();
  const from = 'FROM files f JOIN groups g ON f.groupId=g.id';
  const exportColumns = 'f.id,f.taskId,f.groupId,f.name,f.relativePath,f.size,f.createdAt';
  const successful = "f.status='success' AND f.expiresAt>?";
  const groupScope = () => actor.role === 'admin' ? db.prepare("SELECT '' activeGroups") : db.prepare(`
    SELECT COALESCE(group_concat(groupId, ','), '') activeGroups FROM (
      SELECT ug.groupId FROM user_groups ug JOIN groups g ON g.id=ug.groupId
      WHERE ug.userId=? AND g.status='active' ORDER BY ug.groupId
    )`).bind(actor.id);
  const fingerprint = (row: unknown) => sha((row as { activeGroups: string }).activeGroups);
  let snapshot: ExportSnapshot;
  let encoded = requested;
  let rows: ExportRow[];
  if (requested === 'new') {
    // A single D1 transaction keeps the completion order, coverage and first page consistent.
    const [order, counts, first, groups] = await db.batch([
      db.prepare('SELECT COALESCE(MAX(sequence),0) watermark FROM export_completion_order'),
      db.prepare(`SELECT COUNT(*) FILTER (WHERE ${successful}) eligibleCount,
        COUNT(*) FILTER (WHERE f.status IN ('pending','uploading','failed') AND f.expiresAt>?) unfinishedCount
        ${from} ${where}`).bind(now, now, ...args),
      db.prepare(`SELECT ${exportColumns} ${from} ${where} AND ${successful} ORDER BY f.id LIMIT ?`)
        .bind(...args, now, page.limit + 1),
      groupScope(),
    ]);
    snapshot = {
      scope,
      groupScope: await fingerprint(groups.results[0]),
      snapshotAt: now,
      watermark: (order.results[0] as { watermark: number }).watermark,
      eligibleCount: (counts.results[0] as { eligibleCount: number }).eligibleCount,
      unfinishedCount: (counts.results[0] as { unfinishedCount: number }).unfinishedCount,
    };
    encoded = btoa(await encrypt(snapshot, secret));
    rows = first.results as ExportRow[];
  } else {
    try {
      snapshot = await decrypt<ExportSnapshot>(atob(requested), secret);
    } catch {
      return fail(400, '导出快照无效，请重新导出');
    }
    if (snapshot.scope !== scope) fail(400, '导出范围已改变，请重新导出');
    // Rows without an order were already successful when the trigger was installed.
    const frozen = `${from} LEFT JOIN export_completion_order o ON o.fileId=f.id
      ${where} AND ${successful} AND (o.sequence IS NULL OR o.sequence<=?)`;
    const bindings = [...args, now > snapshot.snapshotAt ? now : snapshot.snapshotAt, snapshot.watermark];
    const query = verify ? db.prepare(`SELECT COUNT(*) total ${frozen}`).bind(...bindings)
      : db.prepare(`SELECT ${exportColumns} ${frozen} AND f.id>? ORDER BY f.id LIMIT ?`)
        .bind(...bindings, page.cursor, page.limit + 1);
    let results: unknown[];
    if (actor.role === 'admin') {
      results = (await query.all()).results;
    } else {
      const [groups, data] = await db.batch([groupScope(), query]);
      if (await fingerprint(groups.results[0]) !== snapshot.groupScope) fail(409, '业务账号权限已改变，请重新导出');
      results = data.results;
    }
    if (verify) {
      if ((results[0] as { total: number }).total !== snapshot.eligibleCount) fail(409, '导出期间有图片到期或被删除，请重新导出');
      return { verified: true };
    }
    rows = results as ExportRow[];
  }
  return {
    maxPageSize: MAX_EXPORT_PAGE_SIZE,
    files: rows.slice(0, page.limit).map(({ id, ...file }) => ({ ...file, url: `${url.origin}/img/${id}` })),
    nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    snapshot: encoded,
    snapshotAt: snapshot.snapshotAt,
    eligibleCount: snapshot.eligibleCount,
    unfinishedCount: snapshot.unfinishedCount,
  };
}

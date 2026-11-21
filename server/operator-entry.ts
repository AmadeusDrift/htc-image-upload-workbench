import { sha } from './auth';
import { GLOBAL_UPLOAD_LIMIT } from './concurrency';

export const OPERATOR_NAMES = ['alpha', 'beta', 'gamma', 'delta'] as const;
export const OPERATOR_PRESENCE_TTL_MS = 45_000;
export const operatorEntryEnabled = (env: Env) => (env as Env & {OPERATOR_CARD_ENTRY_ENABLED?:string}).OPERATOR_CARD_ENTRY_ENABLED === 'true';
export const operatorNameAllowed = (username: string) => OPERATOR_NAMES.some(name => name === username);

export async function operatorStatus(db: D1Database) {
  const time = Date.now();
  // One statement gives all counters the same database snapshot. Only explicit,
  // public columns are read; password/session material never enters the result.
  const result = await db.prepare(`WITH profiles(username,position) AS
    (VALUES ('alpha',1),('beta',2),('gamma',3),('delta',4))
    SELECT p.username,u.id,u.displayName,
      CASE WHEN u.status='active' AND u.role='employee' THEN 1 ELSE 0 END available,
      (SELECT COUNT(DISTINCT deviceId) FROM sessions WHERE userId=u.id AND lastSeen>? AND expiresAt>?) onlineDevices,
      (SELECT COUNT(DISTINCT deviceId) FROM leases WHERE userId=u.id AND expiresAt>? AND uploadedAt IS NULL) uploadingDevices,
      (SELECT COUNT(*) FROM leases WHERE userId=u.id AND expiresAt>? AND uploadedAt IS NULL) uploadSlots,
      (SELECT COUNT(*) FROM leases l WHERE expiresAt>? AND uploadedAt IS NULL
        AND NOT EXISTS(SELECT 1 FROM upload_pool_members m WHERE m.userId=l.userId)) globalSlots
    FROM profiles p LEFT JOIN users u ON u.username=p.username AND u.role='employee' ORDER BY p.position`)
    .bind(time - OPERATOR_PRESENCE_TTL_MS, time, time, time, time)
    .all<{ username: string; id: string | null; displayName: string | null; available: number; onlineDevices: number; uploadingDevices: number; uploadSlots: number; globalSlots: number }>();
  return {
    profiles: result.results.map(({ globalSlots: _, ...profile }) => ({
      ...profile, id: profile.id ?? '', displayName: profile.displayName ?? profile.username,
      available: !!profile.available,
    })),
    globalSlots: result.results[0]?.globalSlots ?? 0,
    globalLimit: GLOBAL_UPLOAD_LIMIT,
  };
}

// Count successes too. Atomic increment avoids concurrent requests bypassing the
// limit. Separate namespaces leave the legacy password-login throttle unchanged.
export async function operatorEntryThrottled(db: D1Database, request: Request, device: string) {
  const time = Date.now(), ip = request.headers.get('CF-Connecting-IP') || 'local';
  for (const [scope, identity, limit] of [
    ['ip', ip, 120], ['device', `${ip}:${device}`, 10],
  ] as const) {
    const key = await sha(`operator-entry:${scope}:${identity}`);
    const attempt = await db.prepare(`INSERT INTO login_attempts VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN resetAt<=? THEN 1 ELSE attempts+1 END,
        resetAt=CASE WHEN resetAt<=? THEN excluded.resetAt ELSE resetAt END
      RETURNING attempts`)
      .bind(key, time + 60_000, time, time).first<{ attempts: number }>();
    if (!attempt || attempt.attempts > limit) return true;
  }
  return false;
}

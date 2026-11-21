import {
  encrypt,
  hashPassword,
  passwordValid,
  randomToken,
  safeEqual,
  sha,
  verifyPassword,
} from "./auth";
import { storageConfig, presign } from "./storage";
import { cleanPackObjects, packKey, PackFields, PACK_TYPE, readPackedImage, registerPacks, verifiedPack } from "./packs";
import { handleRelease } from "./releases";
import { exportSnapshotPage } from "./export-snapshot";
import { MAX_EXPORT_PAGE_SIZE } from "../shared/export-limits";
import { GLOBAL_UPLOAD_LIMIT, UPLOAD_CONFIRM_LIMIT, pruneUploadDemands, reserveUpload, reserveUploadBatch, stopUploadDemand, uploadDemand } from "./concurrency";
import { operatorEntryEnabled, operatorEntryThrottled, operatorNameAllowed, operatorStatus } from "./operator-entry";
type Permissions = {
  upload: boolean;
  view: boolean;
  export: boolean;
  delete: boolean;
};
type User = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  passwordHash: string;
  mustChangePassword: number;
  permissions: string;
};
type FileRow = PackFields & {
  id: string;
  clientId: string;
  taskId: string;
  groupId: string;
  userId: string;
  name: string;
  relativePath: string;
  size: number;
  contentType: string;
  sha256: string;
  objectKey: string;
  status: string;
  error: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
};
const defaults = {
  retries: 3,
  scanSubfolders: true,
  checkDuplicates: true,
  compressPng: true,
  jpegQuality: 90,
  notify: true,
  exportFormat: "xlsx",
  sort: "name",
  retentionDays: 7,
  perDevice: 20,
  global: 20,
};
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
const json = (
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
const now = () => new Date().toISOString();
const DAY_MS = 86400000;
const IMAGE_RETENTION_MS = 7 * DAY_MS;
const UNFINISHED_RETENTION_MS = 30 * DAY_MS;
const MAX_CONFIRM_OBJECT_AGE_MS = DAY_MS / 2;
const EXPIRY_BATCH_SIZE = 1000;
const EXPIRY_BATCHES_PER_SWEEP = 8;
function text(value: unknown, label: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    return fail(400, `${label}格式无效`);
  return value.trim();
}
function cleanName(value: unknown, label = "文件名") {
  const result = text(value, label, 1024);
  if (
    /(^|\/)\.\.(\/|$)/.test(result) ||
    result.startsWith("/") ||
    result.includes("\\")
  )
    fail(400, "文件路径无效");
  return result;
}
function cursorPage(url: URL, maxLimit = 500) {
  if (!url.searchParams.has("limit") && !url.searchParams.has("cursor"))
    return null;
  const rawLimit = url.searchParams.get("limit") ?? "500";
  const limit = Number(rawLimit);
  if (
    !/^\d+$/.test(rawLimit) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maxLimit
  )
    fail(400, `分页数量必须为1至${maxLimit}的整数`);
  const cursor = url.searchParams.get("cursor") ?? "";
  if (cursor.length > 200 || /[\u0000-\u001f]/.test(cursor))
    fail(400, "分页游标无效");
  return { limit, cursor };
}
function permissions(value: unknown): Permissions {
  const p = (value ?? {}) as Record<string, unknown>;
  return {
    upload: p.upload === true,
    view: p.view === true,
    export: p.export === true,
    delete: p.delete === true,
  };
}
function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    mustChangePassword: !!u.mustChangePassword,
    permissions: permissions(JSON.parse(u.permissions)),
  };
}
async function audit(
  env: Env,
  userId: string | null,
  action: string,
  detail: unknown,
) {
  await env.DB.prepare("INSERT INTO audit VALUES(?,?,?,?,?)")
    .bind(crypto.randomUUID(), userId, action, JSON.stringify(detail), now())
    .run();
}
async function groupsFor(env: Env, u: User) {
  const result = await env.DB.prepare(
    `SELECT g.*,(SELECT COALESCE(SUM(size),0) FROM files f WHERE f.groupId=g.id AND f.status='success' AND f.createdAt>=?) todayBytes,(SELECT COUNT(DISTINCT s.deviceId) FROM sessions s JOIN user_groups ug ON ug.userId=s.userId WHERE ug.groupId=g.id AND s.lastSeen>? AND s.expiresAt>?) onlineDevices FROM groups g WHERE ?='admin' OR g.id IN (SELECT groupId FROM user_groups WHERE userId=?) ORDER BY g.createdAt`,
  )
    .bind(now().slice(0, 10), Date.now() - 300000, Date.now(), u.role, u.id)
    .all();
  return result.results.map((g) => ({
    ...g,
    permissions:
      u.role === "admin"
        ? { upload: true, view: true, export: true, delete: true }
        : permissions(JSON.parse(u.permissions)),
  }));
}
async function session(env: Env, u: User, device: string) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .bind(await sha(token), u.id, device, Date.now() + 86400000, Date.now())
    .run();
  return { token, user: publicUser(u), groups: await groupsFor(env, u) };
}
async function authenticate(request: Request, env: Env, uploadTaskId?: string) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  const device = request.headers.get("X-Device-Id");
  if (!token || !device) fail(401, "请先登录");
  const key = await sha(token!);
  if (uploadTaskId !== undefined) {
    const time = Date.now();
    // One primary round trip. Keep the heartbeat ordered with leave/logout.
    const [access] = await env.DB.batch([
      env.DB.prepare(`SELECT u.*, t.id AS uploadTask, t.userId AS owner,
        g.status AS groupStatus, ug.userId AS member
        FROM sessions s JOIN users u ON u.id=s.userId
        LEFT JOIN tasks t ON t.id=?
        LEFT JOIN groups g ON g.id=t.groupId
        LEFT JOIN user_groups ug ON ug.groupId=t.groupId AND ug.userId=u.id
        WHERE s.tokenHash=? AND s.deviceId=? AND s.expiresAt>? AND u.status='active'`)
        .bind(uploadTaskId, key, device, time),
      env.DB.prepare(`UPDATE sessions SET lastSeen=?
        WHERE tokenHash=? AND deviceId=? AND expiresAt>? AND lastSeen<?
        AND EXISTS (SELECT 1 FROM users WHERE id=sessions.userId AND status='active')`)
        .bind(time, key, device, time, time - 15000),
    ]);
    const u = access.results[0] as (User & {
      uploadTask: string | null; owner: string | null;
      groupStatus: string | null; member: string | null;
    }) | undefined;
    if (!u) return fail(401, "登录已失效");
    if (!u.uploadTask) return fail(404, "任务不存在");
    if (!u.groupStatus) return fail(404, "业务账号不存在");
    if (u.role !== "admin") {
      if (u.groupStatus !== "active" || !u.member || !permissions(JSON.parse(u.permissions)).upload)
        fail(403, "没有此业务账号的操作权限");
      if (u.owner !== u.id) fail(403, "只能上传自己的文件");
    }
    return { u, device: device!, tokenHash: key };
  }
  const u = await env.DB.prepare(
    "SELECT u.* FROM users u JOIN sessions s ON u.id=s.userId WHERE s.tokenHash=? AND s.deviceId=? AND s.expiresAt>? AND u.status='active'",
  )
    .bind(key, device, Date.now())
    .first<User>();
  if (!u) fail(401, "登录已失效");
  await env.DB.prepare("UPDATE sessions SET lastSeen=? WHERE tokenHash=?")
    .bind(Date.now(), key)
    .run();
  return { u: u!, device: device!, tokenHash: key };
}
function admin(u: User) {
  if (u.role !== "admin") fail(403, "需要管理员权限");
}
async function allow(
  env: Env,
  u: User,
  groupId: string,
  permission: keyof Permissions,
) {
  const group = await env.DB.prepare("SELECT status FROM groups WHERE id=?")
    .bind(groupId)
    .first<{ status: string }>();
  if (!group) fail(404, "业务账号不存在");
  if (u.role === "admin") return;
  if (
    group!.status !== "active" ||
    !permissions(JSON.parse(u.permissions))[permission] ||
    !(await env.DB.prepare(
      "SELECT 1 FROM user_groups WHERE userId=? AND groupId=?",
    )
      .bind(u.id, groupId)
      .first())
  )
    fail(403, "没有此业务账号的操作权限");
}
function fileView(f: FileRow, origin: string) {
  const status =
    f.status === "success" && f.expiresAt <= now() ? "expired" : f.status;
  return {
    id: f.id,
    clientId: f.clientId,
    taskId: f.taskId,
    groupId: f.groupId,
    name: f.name,
    relativePath: f.relativePath,
    size: f.size,
    contentType: f.contentType,
    status,
    error: f.error,
    createdAt: f.createdAt,
    expiresAt: f.expiresAt,
    ...(f.packLeaderId ? {packLeaderId: f.packLeaderId, packOffset: f.packOffset} : {}),
    url: status === "success" ? `${origin}/img/${f.id}` : "",
  };
}
async function fileGet(env: Env, id: string) {
  const f = await env.DB.prepare("SELECT * FROM files WHERE id=?")
    .bind(id)
    .first<FileRow>();
  if (!f) fail(404, "文件不存在");
  return f!;
}
async function parse(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") || 0) > 1024 * 1024)
    fail(413, "请求过大");
  const body = await request.text();
  if (body.length > 1024 * 1024) fail(413, "请求过大");
  try {
    const b = JSON.parse(body || "{}");
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "请求格式无效");
    return b;
  } catch {
    return fail(400, "JSON格式无效");
  }
}
async function handle(request: Request, env: Env) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization,Content-Type,X-Device-Id",
        "Access-Control-Max-Age": "86400",
      },
    });
  if (path.startsWith("/img/") && (method === "GET" || method === "HEAD")) {
    const f = await fileGet(env, path.slice(5));
    if (
      f.status !== "success" ||
      f.expiresAt <= now() ||
      !f.contentType.startsWith("image/")
    )
      fail(404, "图片不存在或已过期");
    if (f.packLeaderId) return readPackedImage(request, env.BUCKET, f, fail);
    const object =
      method === "HEAD"
        ? await env.BUCKET.head(f.objectKey)
        : await env.BUCKET.get(f.objectKey);
    if (!object) fail(404, "图片不存在");
    return new Response(
      method === "HEAD" ? null : (object as R2ObjectBody).body,
      {
        headers: {
          "Content-Type": f.contentType,
          "Content-Length": String(object.size),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          ETag: object.httpEtag,
        },
      },
    );
  }
  if (path === "/api/health")
    return json({
      ok: true,
      initialized: !!(await env.DB.prepare(
        "SELECT id FROM users LIMIT 1",
      ).first()),
      storageReady: !!(await storageConfig(env)),
      operatorEntryEnabled: operatorEntryEnabled(env),
      batchUpload: true,
      packedUpload: true,
      limits: { global: 20, perDevice: 20, allocation: "dynamic-device" },
      version: "1.5.0",
    });
  const b = method === "POST" || method === "PATCH" ? await parse(request) : {};
  if (path === "/api/operator-status" && method === "GET") {
    if (!operatorEntryEnabled(env)) fail(404, "入口未启用");
    return json(await operatorStatus(env.DB));
  }
  if (path === "/api/operator-entry" && method === "POST") {
    if (!operatorEntryEnabled(env)) fail(404, "入口未启用");
    const username = text(b.username, "用户名", 80),
      device = text(b.deviceId, "设备", 120),
      headerDevice = text(request.headers.get("X-Device-Id"), "设备", 120);
    if (device !== headerDevice) fail(400, "设备标识不一致");
    if (await operatorEntryThrottled(env.DB, request, device))
      fail(429, "进入尝试过多，请一分钟后重试");
    if (!operatorNameAllowed(username)) fail(403, "此操作员不可用");
    const operator = await env.DB.prepare("SELECT * FROM users WHERE username=? AND role='employee' AND status='active'")
      .bind(username).first<User>();
    if (!operator) fail(403, "此操作员不可用");
    return json(await session(env, operator, device));
  }
  if (path === "/api/setup" && method === "POST") {
    if (await env.DB.prepare("SELECT id FROM users LIMIT 1").first())
      fail(409, "管理员已初始化");
    if (
      !env.SETUP_TOKEN ||
      !(await safeEqual(String(b.setupToken || ""), env.SETUP_TOKEN))
    )
      fail(403, "初始化令牌无效");
    if (!passwordValid(b.password)) fail(400, "密码需为8至128个字符");
    const id = crypto.randomUUID(),
      username = text(b.username, "用户名", 80),
      displayName = text(b.displayName, "姓名", 80);
    await env.DB.prepare(
      `INSERT INTO users SELECT ?,?,?,'admin','active',?,0,?,? WHERE NOT EXISTS(SELECT 1 FROM users)`,
    )
      .bind(
        id,
        username,
        displayName,
        await hashPassword(b.password),
        JSON.stringify({
          upload: true,
          view: true,
          export: true,
          delete: true,
        }),
        now(),
      )
      .run();
    const u = await env.DB.prepare("SELECT * FROM users WHERE id=?")
      .bind(id)
      .first<User>();
    if (!u) fail(409, "管理员已初始化");
    await audit(env, id, "setup", {});
    return json(
      await session(
        env,
        u!,
        text(
          request.headers.get("X-Device-Id") || b.deviceId || "setup-device",
          "设备",
          120,
        ),
      ),
    );
  }
  if (path === "/api/login" && method === "POST") {
    const username = text(b.username, "用户名", 80),
      device = text(
        b.deviceId || request.headers.get("X-Device-Id"),
        "设备",
        120,
      );
    const key = await sha(
      `${request.headers.get("CF-Connecting-IP") || "local"}:${username.toLowerCase()}`,
    );
    const attempt = await env.DB.prepare(
      "SELECT * FROM login_attempts WHERE key=?",
    )
      .bind(key)
      .first<{ attempts: number; resetAt: number }>();
    if (attempt && attempt.resetAt > Date.now() && attempt.attempts >= 10)
      fail(429, "登录尝试过多，请15分钟后重试");
    await env.DB.prepare(
      "INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN resetAt<? THEN 1 ELSE attempts+1 END,resetAt=CASE WHEN resetAt<? THEN excluded.resetAt ELSE resetAt END",
    )
      .bind(key, Date.now() + 900000, Date.now(), Date.now())
      .run();
    const u = await env.DB.prepare("SELECT * FROM users WHERE username=?")
      .bind(username)
      .first<User>();
    if (
      !u ||
      u.status !== "active" ||
      typeof b.password !== "string" ||
      !(await verifyPassword(b.password, u.passwordHash))
    )
      fail(401, "用户名或密码错误");
    await env.DB.prepare("DELETE FROM login_attempts WHERE key=?")
      .bind(key)
      .run();
    return json(await session(env, u, device));
  }
  if (!path.startsWith("/api/"))
    return new Response("Not found", { status: 404 });
  const batchLease = method === "POST" && path.match(/^\/api\/tasks\/([^/]+)\/(upload-leases|confirm-uploads|packs)$/);
  const { u, device, tokenHash } = await authenticate(request, env, batchLease ? batchLease[1] : undefined);
  if (path === "/api/presence" && method === "GET")
    return json({ ok: true });
  if (path === "/api/presence/leave" && method === "POST") {
    await env.DB.prepare("UPDATE sessions SET lastSeen=0 WHERE tokenHash=?")
      .bind(tokenHash).run();
    return json({ ok: true });
  }
  if (path === "/api/uploads/activity" && method === "POST") {
    if (u.role !== "admin" && !permissions(JSON.parse(u.permissions)).upload) fail(403, "没有上传权限");
    if (typeof b.active !== "boolean") fail(400, "上传活动状态无效");
    const runId = b.runId === undefined ? undefined : text(b.runId, "上传运行标识", 120);
    if (b.active) {
      const demand = b.demand;
      if (demand !== undefined && (!runId || typeof demand !== "number" || !Number.isInteger(demand) || demand < 0 || demand > GLOBAL_UPLOAD_LIMIT))
        fail(400, "上传需求无效");
      const result = await uploadDemand(env.DB, u.id, device, Date.now(), runId, demand).run();
      if (!result.meta.changes) fail(409, "本次上传已暂停，请重新开始");
    } else if (runId !== undefined) await stopUploadDemand(env.DB, u.id, device, runId);
    else await env.DB.prepare("DELETE FROM upload_demands WHERE deviceId=? AND userId=? AND runId=''").bind(device, u.id).run();
    return json({ ok: true });
  }
  if (path === "/api/me")
    return json({ user: publicUser(u), groups: await groupsFor(env, u) });
  if (path === "/api/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE tokenHash=?")
      .bind(tokenHash)
      .run();
    return json({ ok: true });
  }
  if (path === "/api/password" && method === "POST") {
    if (
      typeof b.oldPassword !== "string" ||
      !(await verifyPassword(b.oldPassword, u.passwordHash))
    )
      fail(403, "原密码不正确");
    if (!passwordValid(b.newPassword)) fail(400, "密码需为8至128个字符");
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET passwordHash=?,mustChangePassword=0 WHERE id=?",
      ).bind(await hashPassword(b.newPassword), u.id),
      env.DB.prepare(
        "DELETE FROM sessions WHERE userId=? AND tokenHash<>?",
      ).bind(u.id, tokenHash),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/groups" && method === "GET")
    return json({ groups: await groupsFor(env, u) });
  if (path === "/api/groups" && method === "POST") {
    admin(u);
    const g = {
      id: crypto.randomUUID(),
      name: text(b.name, "业务账号名称", 100),
      status: "active",
    };
    await env.DB.prepare("INSERT INTO groups VALUES(?,?,?,?)")
      .bind(g.id, g.name, g.status, now())
      .run();
    await audit(env, u.id, "group.create", g);
    return json({ group: g });
  }
  if (path.match(/^\/api\/groups\/[^/]+$/) && method === "PATCH") {
    admin(u);
    const id = path.split("/")[3],
      g = await env.DB.prepare("SELECT * FROM groups WHERE id=?")
        .bind(id)
        .first<{ name: string; status: string }>();
    if (!g) fail(404, "业务账号不存在");
    const status = b.status === undefined ? g!.status : text(b.status, "状态");
    if (!["active", "disabled"].includes(status)) fail(400, "状态无效");
    await env.DB.prepare("UPDATE groups SET name=?,status=? WHERE id=?")
      .bind(
        b.name === undefined ? g!.name : text(b.name, "名称", 100),
        status,
        id,
      )
      .run();
    await audit(env, u.id, "group.update", { id });
    return json({ ok: true });
  }
  if (path === "/api/users" && method === "GET") {
    admin(u);
    const rows = await env.DB.prepare(
      "SELECT * FROM users ORDER BY createdAt",
    ).all<User>();
    const users = await Promise.all(
      rows.results.map(async (x) => ({
        ...publicUser(x),
        groupIds: (
          await env.DB.prepare("SELECT groupId FROM user_groups WHERE userId=?")
            .bind(x.id)
            .all<{ groupId: string }>()
        ).results.map((g) => g.groupId),
      })),
    );
    return json({ users });
  }
  if (
    (path === "/api/users" && method === "POST") ||
    (path.match(/^\/api\/users\/[^/]+$/) && method === "PATCH")
  ) {
    admin(u);
    const create = method === "POST",
      id = create ? crypto.randomUUID() : path.split("/")[3];
    const existing = create
      ? null
      : await env.DB.prepare("SELECT * FROM users WHERE id=?")
          .bind(id)
          .first<User>();
    if (!create && !existing) fail(404, "员工不存在");
    const username =
        b.username === undefined && existing
          ? existing.username
          : text(b.username, "用户名", 80),
      displayName =
        b.displayName === undefined && existing
          ? existing.displayName
          : text(b.displayName, "姓名", 80),
      role = String(b.role ?? existing?.role ?? "employee"),
      status = String(b.status ?? existing?.status ?? "active");
    if (
      !["admin", "employee"].includes(role) ||
      !["active", "disabled"].includes(status)
    )
      fail(400, "角色或状态无效");
    if ((create || b.password !== undefined) && !passwordValid(b.password))
      fail(400, "密码需为8至128个字符");
    const ids = b.groupIds === undefined ? null : b.groupIds;
    if (
      ids !== null &&
      (!Array.isArray(ids) ||
        ids.some((x) => typeof x !== "string") ||
        ids.length > 100)
    )
      fail(400, "业务账号列表无效");
    if (ids)
      for (const gid of ids as string[])
        if (
          !(await env.DB.prepare("SELECT id FROM groups WHERE id=?")
            .bind(gid)
            .first())
        )
          fail(400, "业务账号不存在");
    const pass = b.password
      ? await hashPassword(String(b.password))
      : existing!.passwordHash;
    const perm = JSON.stringify(
      b.permissions === undefined && existing
        ? JSON.parse(existing.permissions)
        : permissions(b.permissions),
    );
    let result;
    if (create) {
      result = await env.DB.prepare(
        "INSERT INTO users VALUES(?,?,?,?,?,?,1,?,?)",
      )
        .bind(id, username, displayName, role, status, pass, perm, now())
        .run();
    } else {
      result = await env.DB.prepare(
        `UPDATE users SET username=?,displayName=?,role=?,status=?,passwordHash=?,permissions=?,mustChangePassword=CASE WHEN ? THEN 1 ELSE mustChangePassword END WHERE id=? AND (role<>'admin' OR status<>'active' OR (?='admin' AND ?='active') OR (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active')>1)`,
      )
        .bind(
          username,
          displayName,
          role,
          status,
          pass,
          perm,
          b.password !== undefined ? 1 : 0,
          id,
          role,
          status,
        )
        .run();
      if (!result.meta.changes) fail(409, "不能禁用或降级最后一位管理员");
    }
    if (ids) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM user_groups WHERE userId=?").bind(id),
        ...(ids as string[]).map((gid) =>
          env.DB.prepare("INSERT OR IGNORE INTO user_groups VALUES(?,?)").bind(
            id,
            gid,
          ),
        ),
      ]);
    }
    if (b.password !== undefined && !create)
      await env.DB.prepare("DELETE FROM sessions WHERE userId=?")
        .bind(id)
        .run();
    await audit(env, u.id, create ? "user.create" : "user.update", { id });
    return json({
      user: publicUser(
        (await env.DB.prepare("SELECT * FROM users WHERE id=?")
          .bind(id)
          .first<User>())!,
      ),
    });
  }
  if (path === "/api/settings" && method === "GET") {
    const row = await env.DB.prepare("SELECT value FROM config WHERE key=?")
      .bind("settings:" + u.id)
      .first<{ value: string }>();
    const c = await storageConfig(env);
    return json({
      settings: {
        ...defaults,
        ...(row ? JSON.parse(row.value) : {}),
        allocation: "dynamic-device",
        retentionDays: 7,
        perDevice: 20,
        global: 20,
      },
      storage: {
        ready: !!c,
        endpoint: env.R2_ENDPOINT,
        bucket: env.R2_BUCKET_NAME,
        publicBaseUrl: url.origin + "/img",
      },
    });
  }
  if (path === "/api/settings" && method === "PATCH") {
    const s = (b.settings || {}) as Record<string, unknown>,
      out: Record<string, unknown> = {};
    if (s.compressPng !== undefined && typeof s.compressPng !== "boolean")
      fail(400, "PNG压缩开关必须为布尔值");
    if (
      s.jpegQuality !== undefined &&
      (typeof s.jpegQuality !== "number" ||
        !Number.isInteger(s.jpegQuality) ||
        s.jpegQuality < 80 ||
        s.jpegQuality > 95)
    )
      fail(400, "JPEG质量必须为80至95的整数");
    for (const k of [
      "scanSubfolders",
      "checkDuplicates",
      "notify",
      "compressPng",
    ])
      if (typeof s[k] === "boolean") out[k] = s[k];
    if (s.jpegQuality !== undefined) out.jpegQuality = s.jpegQuality;
    if (
      Number.isInteger(s.retries) &&
      Number(s.retries) >= 0 &&
      Number(s.retries) <= 5
    )
      out.retries = s.retries;
    if (["xlsx", "csv"].includes(String(s.exportFormat)))
      out.exportFormat = s.exportFormat;
    if (["name", "size", "createdAt"].includes(String(s.sort)))
      out.sort = s.sort;
    const key = "settings:" + u.id;
    const old = await env.DB.prepare("SELECT value FROM config WHERE key=?")
      .bind(key)
      .first<{ value: string }>();
    await env.DB.prepare(
      "INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
      .bind(
        key,
        JSON.stringify({ ...(old ? JSON.parse(old.value) : {}), ...out }),
      )
      .run();
    return json({ ok: true });
  }
  if (path === "/api/storage" && method === "POST") {
    admin(u);
    if (!env.CONFIG_KEY) fail(503, "未配置加密密钥");
    if (b.endpoint !== env.R2_ENDPOINT || b.bucket !== env.R2_BUCKET_NAME)
      fail(400, "存储地址和桶必须与部署配置一致");
    const config = {
      endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET_NAME,
      accessKeyId: text(b.accessKeyId, "Access Key", 200),
      secretAccessKey: text(b.secretAccessKey, "Secret Key", 300),
    };
    await env.DB.prepare(
      "INSERT INTO config VALUES('storage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
      .bind(await encrypt(config, env.CONFIG_KEY))
      .run();
    await audit(env, u.id, "storage.update", {});
    return json({ ok: true });
  }
  if (path === "/api/storage/test" && method === "POST") {
    admin(u);
    const c = await storageConfig(env);
    if (!c) fail(503, "存储未配置");
    const key = `probes/${crypto.randomUUID()}`;
    try {
      const signed = await presign(c, key, "image/png");
      const response = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: signed.headers,
        body: new Uint8Array([1]),
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      if (!response.ok) fail(502, "R2直传密钥验证失败，请检查密钥和桶权限");
      const object = await env.BUCKET.head(key);
      if (!object || object.size !== 1) fail(502, "直传目标与绑定的R2桶不一致");
      await audit(env, u.id, "storage.test", {});
      return json({ ok: true, message: "R2直传、文件确认和桶绑定均已验证" });
    } finally {
      await env.BUCKET.delete(key);
    }
  }
  if (path === "/api/tasks" && method === "POST") {
    const groupId = text(b.groupId, "业务账号");
    await allow(env, u, groupId, "upload");
    const clientTaskId = b.clientTaskId;
    if (
      clientTaskId !== undefined &&
      (typeof clientTaskId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          clientTaskId,
        ))
    )
      fail(400, "客户端任务ID必须为有效UUID");
    const task = {
      id:
        clientTaskId === undefined
          ? crypto.randomUUID()
          : await sha(u.id + "/" + clientTaskId),
      groupId,
      userId: u.id,
      name: text(b.name, "任务名称", 200),
      createdAt: now(),
    };
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?)",
    )
      .bind(task.id, u.id, groupId, task.name, task.createdAt)
      .run();
    const stored = await env.DB.prepare(
      "SELECT * FROM tasks WHERE id=? AND userId=?",
    )
      .bind(task.id, u.id)
      .first<typeof task>();
    if (!stored || stored.groupId !== groupId)
      fail(409, "客户端任务ID已用于其他业务账号");
    if (inserted.meta.changes)
      await audit(env, u.id, "task.create", {
        id: stored.id,
        groupId: stored.groupId,
      });
    return json({ task: stored });
  }
  const taskFiles = path.match(/^\/api\/tasks\/([^/]+)\/files$/);
  if (taskFiles && method === "POST") {
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id=?")
      .bind(taskFiles[1])
      .first<{ id: string; groupId: string; userId: string }>();
    if (!t) fail(404, "任务不存在");
    await allow(env, u, t!.groupId, "upload");
    if (t!.userId !== u.id && u.role !== "admin")
      fail(403, "只能修改自己的任务");
    if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > 100)
      fail(400, "每批需为1至100张图片");
    const files = b.files.map((value: Record<string, unknown>) => {
      const size = Number(value.size),
        type = text(value.contentType, "图片格式", 100);
      if (!Number.isSafeInteger(size) || size < 1 || size > 50 * 1024 * 1024)
        fail(400, "单图最大50MB");
      if (!/^image\/(jpeg|png|webp|gif|avif|bmp|tiff|heic|heif)$/.test(type))
        fail(400, "仅支持图片文件");
      if (!/^[a-f0-9]{64}$/i.test(String(value.sha256)))
        fail(400, "SHA256格式无效");
      const id = crypto.randomUUID();
      return {
        id,
        clientId: text(value.clientId, "客户端ID", 150),
        name: cleanName(value.name),
        relativePath: cleanName(value.relativePath),
        size,
        contentType: type,
        sha256: String(value.sha256),
        objectKey: `images/${id}`,
        createdAt: now(),
        expiresAt: new Date(Date.now() + UNFINISHED_RETENTION_MS).toISOString(),
      };
    });
    await env.DB.batch(
      files.map((f) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO files(id,clientId,taskId,groupId,userId,name,relativePath,size,contentType,sha256,objectKey,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          f.id,
          f.clientId,
          t!.id,
          t!.groupId,
          u.id,
          f.name,
          f.relativePath,
          f.size,
          f.contentType,
          f.sha256,
          f.objectKey,
          f.createdAt,
          f.expiresAt,
        ),
      ),
    );
    // D1 accepts at most 100 bound parameters. Read only this registration
    // batch, including idempotent replays, instead of decoding the whole task.
    const clientIds = [...new Set(files.map((f) => f.clientId))];
    const rows: FileRow[] = [];
    for (let start = 0; start < clientIds.length; start += 99) {
      const chunk = clientIds.slice(start, start + 99);
      const result = await env.DB.prepare(
        `SELECT * FROM files WHERE taskId=? AND clientId IN (${chunk.map(() => "?").join(",")})`,
      )
        .bind(t.id, ...chunk)
        .all<FileRow>();
      rows.push(...result.results);
    }
    return json({
      files: rows.map((f) => fileView(f, url.origin)),
    });
  }
  const taskId = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskId && method === "PATCH") {
    const task = await env.DB.prepare("SELECT groupId,userId FROM tasks WHERE id=?")
      .bind(taskId[1]).first<{groupId:string;userId:string}>();
    if (!task) fail(404, "任务不存在");
    await allow(env,u,task.groupId,"upload");
    if (task.userId!==u.id && u.role!=="admin") fail(403,"只能重命名自己的任务");
    const name=text(b.name,"任务名称",200);
    await env.DB.prepare("UPDATE tasks SET name=? WHERE id=?").bind(name,taskId[1]).run();
    return json({id:taskId[1],name});
  }
  if (taskId && method === "GET") {
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?")
      .bind(taskId[1])
      .first<{ groupId: string; userId: string }>();
    if (!task) fail(404, "任务不存在");
    const ownerCanUpload =
      task.userId === u.id && permissions(JSON.parse(u.permissions)).upload;
    await allow(env, u, task.groupId, ownerCanUpload ? "upload" : "view");
    const page = cursorPage(url);
    if (page) {
      const rows = await env.DB.prepare(
        `SELECT f.*, EXISTS(SELECT 1 FROM leases l WHERE l.fileId=f.id AND l.userId=?
          AND l.deviceId=? AND l.uploadedAt IS NOT NULL AND l.expiresAt>?) awaitingConfirmation
        FROM files f WHERE f.taskId=? AND f.id>? ORDER BY f.id LIMIT ?`,
      )
        .bind(u.id,device,Date.now(),taskId[1], page.cursor, page.limit + 1)
        .all<FileRow & {awaitingConfirmation:number}>();
      const files = rows.results.slice(0, page.limit);
      return json({
        task,
        files: files.map((f) => ({...fileView(f, url.origin),...(f.awaitingConfirmation?{awaitingConfirmation:true}:{})})),
        nextCursor:
          rows.results.length > page.limit ? files[files.length - 1].id : null,
      });
    }
    return json({
      task,
      files: (
        await env.DB.prepare(
          "SELECT * FROM files WHERE taskId=? ORDER BY createdAt",
        )
          .bind(taskId[1])
          .all<FileRow>()
      ).results.map((f) => fileView(f, url.origin)),
    });
  }
  if (path === "/api/tasks" && method === "GET") {
    const args: unknown[] = [];
    let where =
      "WHERE ( ?='admin' OR (t.groupId IN (SELECT groupId FROM user_groups WHERE userId=?) AND g.status='active'))";
    args.push(u.role, u.id);
    if (u.role !== "admin" && !permissions(JSON.parse(u.permissions)).view)
      fail(403, "没有查看权限");
    if (url.searchParams.get("groupId")) {
      await allow(env, u, url.searchParams.get("groupId")!, "view");
      where += " AND t.groupId=?";
      args.push(url.searchParams.get("groupId"));
    }
    const search = url.searchParams.get("search");
    if (search) {
      where += " AND t.name LIKE ?";
      args.push("%" + search + "%");
    }
    const days = Math.min(
      365,
      Math.max(1, Number(url.searchParams.get("days")) || 7),
    );
    where += " AND t.createdAt>=?";
    args.push(new Date(Date.now() - days * 86400000).toISOString());
    const rows = await env.DB.prepare(
      `SELECT t.*,g.name groupName,COUNT(f.id) total,COALESCE(SUM(f.status='success'),0) success,COALESCE(SUM(f.status='failed'),0) failed,COALESCE(SUM(f.status='uploading'),0) uploading,COALESCE(SUM(CASE WHEN f.status='success' THEN f.size ELSE 0 END),0) bytes,COALESCE(MAX(f.completedAt),t.createdAt) finishedAt FROM tasks t JOIN groups g ON g.id=t.groupId LEFT JOIN files f ON f.taskId=t.id ${where} GROUP BY t.id ORDER BY t.createdAt DESC`,
    )
      .bind(...args)
      .all<Record<string, unknown>>();
    let tasks = rows.results.map((t) => ({
      ...t,
      status:
        Number(t.total) > 0 && Number(t.success) === Number(t.total)
          ? "success"
          : Number(t.uploading) > 0
            ? "uploading"
            : Number(t.success) > 0 && Number(t.failed) > 0
              ? "partial"
              : Number(t.failed) > 0
                ? "failed"
                : "pending",
      durationMs: Math.max(
        0,
        Date.parse(String(t.finishedAt)) - Date.parse(String(t.createdAt)),
      ),
    }));
    if (url.searchParams.get("status"))
      tasks = tasks.filter((t) => t.status === url.searchParams.get("status"));
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    return json({
      tasks: tasks.slice((page - 1) * 50, page * 50),
      total: tasks.length,
    });
  }
  if (batchLease) {
    const taskId = batchLease[1];
    if (batchLease[2] === "packs") {
      await registerPacks(env.DB, taskId, b.packs, fail);
      return json({ok: true});
    }
    if (batchLease[2] === "confirm-uploads") {
      if (!Array.isArray(b.fileIds) || !b.fileIds.length || b.fileIds.length > UPLOAD_CONFIRM_LIMIT)
        return fail(400, "待确认图片数量无效");
      const ids = [...new Set(b.fileIds.map(id => text(id,"文件标识",120)))];
      if (b.packedReceipts !== undefined && (!Array.isArray(b.packedReceipts) || b.packedReceipts.length>ids.length))
        fail(400,"图片包确认回执数量无效");
      const supplied = new Map<string,{fileId:string;leaseId:string;runId:string}>();
      for (const value of (b.packedReceipts ?? []) as Record<string,unknown>[]) {
        if (!value || typeof value!=="object") fail(400,"图片包回执无效");
        const fileId=text(value.fileId,"文件标识",120);
        if (!ids.includes(fileId) || supplied.has(fileId)) fail(400,"图片包回执成员无效");
        supplied.set(fileId,{fileId,leaseId:text(value.leaseId,"上传名额",120),runId:text(value.runId,"上传运行标识",120)});
      }
      const rows = (await env.DB.prepare(`
        WITH saved AS (SELECT value->>'$.fileId' fileId,value->>'$.leaseId' leaseId,value->>'$.runId' runId FROM json_each(?))
        SELECT f.*,COALESCE(a.leaseId,l.id) confirmationLease FROM json_each(?) j CROSS JOIN files f ON f.id=j.value
        LEFT JOIN saved s ON s.fileId=f.id
        LEFT JOIN pack_attempts a ON a.leaseId=s.leaseId AND a.leaderId=f.id AND a.generation=f.packGeneration
          AND a.userId=? AND a.deviceId=? AND a.runId=s.runId
        LEFT JOIN leases l ON l.fileId=f.id AND l.userId=? AND l.deviceId=? AND l.uploadedAt IS NOT NULL AND l.expiresAt>?
        WHERE f.taskId=? AND f.expiresAt>?
      `).bind(JSON.stringify([...supplied.values()]),JSON.stringify(ids),u.id,device,u.id,device,Date.now(),taskId,now()).all<FileRow & {confirmationLease:string|null}>()).results;
      const pending = rows.filter(row=>row.confirmationLease && (row.status==="uploading" ||
        (row.packLeaderId===row.id && ["pending","failed"].includes(row.status))));
      const valid: {fileId: string; leaseId: string; key: string | null; etag: string | null}[] = [], rejected:typeof pending = [];
      // Bound the number of simultaneous R2 reads within each Worker invocation.
      for (let i=0;i<pending.length;i+=5) {
        await Promise.all(pending.slice(i,i+5).map(async row=>{
          const key=row.packLeaderId ? packKey(row.id,row.confirmationLease!) : row.objectKey;
          const freshAfter=Date.now()-MAX_CONFIRM_OBJECT_AGE_MS;
          const object=row.packLeaderId ? await verifiedPack(env.BUCKET,key,row.packSize!,row.packSha256!,freshAfter) : await env.BUCKET.head(key);
          const matches=object && (row.packLeaderId || (object.size===row.size &&
            object.httpMetadata?.contentType===row.contentType && object.uploaded.getTime()>=freshAfter));
          if (matches) valid.push({fileId:row.id,leaseId:row.confirmationLease!,key:row.packLeaderId ? key : null,etag:row.packLeaderId ? object.etag : null});
          else rejected.push(row);
        }));
      }
      const time=Date.now(), done=JSON.stringify(valid);
      const missing=JSON.stringify(rejected.map(row=>row.confirmationLease));
      const successRows = env.DB.prepare(`
        WITH requested AS MATERIALIZED (SELECT value FROM json_each(?)),
        matched AS (SELECT f.id FROM requested r CROSS JOIN files f ON f.id=r.value
          UNION SELECT f.id FROM requested r CROSS JOIN files f ON f.packLeaderId=r.value)
        SELECT f.* FROM matched CROSS JOIN files f ON f.id=matched.id
        WHERE f.taskId=? AND f.status='success' AND f.expiresAt>?
      `).bind(JSON.stringify(ids),taskId,new Date(time).toISOString());
      const files = pending.length ? (await env.DB.batch<FileRow>([
        env.DB.prepare(`
          UPDATE files SET status='success',error=NULL,completedAt=?,expiresAt=?,
            packObjectKey=j.value->>'$.key',packEtag=j.value->>'$.etag'
          FROM json_each(?) j
          WHERE files.id=j.value->>'$.fileId' AND files.status IN('pending','failed','uploading') AND files.expiresAt>?
            AND ((files.packLeaderId=files.id AND EXISTS(SELECT 1 FROM pack_attempts a WHERE a.leaseId=j.value->>'$.leaseId'
              AND a.leaderId=files.id AND a.generation=files.packGeneration))
              OR (files.packLeaderId IS NULL AND j.value->>'$.key' IS NULL AND files.status='uploading' AND EXISTS(
                SELECT 1 FROM leases l WHERE l.id=j.value->>'$.leaseId' AND l.fileId=files.id AND l.uploadedAt IS NOT NULL AND l.expiresAt>?)))
        `).bind(new Date(time).toISOString(),new Date(time+IMAGE_RETENTION_MS).toISOString(),done,new Date(time).toISOString(),time),
        env.DB.prepare(`
          UPDATE files SET status='pending',error=NULL WHERE status='uploading'
            AND id IN(SELECT fileId FROM leases WHERE id IN(SELECT value FROM json_each(?)))
        `).bind(missing),
        env.DB.prepare(`DELETE FROM leases WHERE fileId IN(SELECT j.value->>'$.fileId' FROM json_each(?) j
          JOIN files f ON f.id=j.value->>'$.fileId' AND f.status='success') OR id IN(SELECT value FROM json_each(?))`).bind(done,missing),
        successRows,
      ])).at(-1)!.results : (await successRows.all<FileRow>()).results;
      const completed = new Set(files.map(file=>file.packLeaderId || file.id));
      const retry = new Set([...rejected.map(row=>row.id), ...supplied.keys()].filter(id=>!completed.has(id)));
      return json({files:files.map(file=>fileView(file,url.origin)),retry:[...retry]});
    }
    const runId = text(b.runId, "上传运行标识", 120);
    const demand = b.demand;
    if (typeof demand !== "number" || !Number.isInteger(demand) || demand < 0 || demand > GLOBAL_UPLOAD_LIMIT)
      return fail(400, "上传需求无效");
    if (!Array.isArray(b.fileIds) || b.fileIds.length > GLOBAL_UPLOAD_LIMIT || b.fileIds.length > demand)
      fail(400, "一次最多申请 20 张图片的上传名额");
    const fileIds = [...new Set<string>((b.fileIds as unknown[]).map(id => text(id, "文件标识", 120)))];
    if (b.uploaded !== undefined && (!Array.isArray(b.uploaded) || b.uploaded.length > GLOBAL_UPLOAD_LIMIT))
      return fail(400,"上传回执数量无效");
    const uploaded = (b.uploaded as unknown[] | undefined)?.map(value=>{
      if (!value || typeof value!=="object") return fail(400,"上传回执无效");
      const receipt=value as Record<string,unknown>;
      return {fileId:text(receipt.fileId,"文件标识",120),leaseId:text(receipt.leaseId,"上传名额",120)};
    });
    const startedAt = Date.now();
    const [storage, candidateRows] = await Promise.all([
      fileIds.length ? storageConfig(env) : null,
      fileIds.length ? env.DB.prepare(
        "SELECT f.* FROM json_each(?) j CROSS JOIN files f ON f.id=j.value WHERE f.taskId=?"
      ).bind(JSON.stringify(fileIds), taskId).all<FileRow>() : null,
    ]);
    if (fileIds.length && !storage) fail(503, "存储未配置");
    const candidates = candidateRows?.results ?? [];
    const byId = new Map(candidates.map(f => [f.id,f]));
    const timestamp = now();
    const eligible = fileIds.filter(id => {
      const file = byId.get(id);
      return file && (!file.packLeaderId || (b.packed===true && file.id===file.packLeaderId))
        && file.expiresAt > timestamp && ["pending","failed","uploading"].includes(file.status);
    });
    const { slots, grants, receipts } = await reserveUploadBatch(env.DB, {
      fileIds: eligible, demand, taskId, userId: u.id, deviceId: device, runId, uploaded, packed: b.packed===true,
    });
    if (!slots.active) fail(409, "本次上传已暂停，请重新开始");
    const eligibleIds = new Set(eligible);
    const unavailable = fileIds.filter(id => !eligibleIds.has(id)).map(fileId => {
      const file = byId.get(fileId);
      return {fileId, file: file ? fileView(file, url.origin) : null};
    });
    const signedGrants = await Promise.all(grants.map(async grant => ({
        fileId: grant.fileId, leaseId: grant.leaseId,
        ...(await presign(storage!, grant.packLeaderId ? packKey(grant.fileId,grant.leaseId) : grant.objectKey,
          grant.packLeaderId ? PACK_TYPE : grant.contentType,
          Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1000)), grant.packSha256)),
        expiresAt: new Date(grant.expiresAt).toISOString(),
    })));
    if (fileIds.length || uploaded?.length) {
      const shortfall = grants.length < eligible.length;
      console.info({
        event: "upload.lease_batch", userId: u.id, pool: slots.pool, requested: fileIds.length, eligible: eligible.length,
        granted: grants.length, acknowledged: receipts.length, demand,
        deviceQuota: slots.quota, deviceUsed: slots.used, globalUsed: slots.globalUsed,
        globalLimit: GLOBAL_UPLOAD_LIMIT,
        deviceQuotaReached: shortfall && slots.used >= slots.quota,
        globalLimitReached: shortfall && slots.globalUsed >= GLOBAL_UPLOAD_LIMIT,
        confirmationLimitReached: shortfall && slots.deviceHeld >= UPLOAD_CONFIRM_LIMIT,
        elapsedMs: Date.now() - startedAt,
      });
    }
    return json({
      pool: slots.pool, quota: slots.quota, used: slots.used, globalUsed: slots.globalUsed,
      globalLimit: GLOBAL_UPLOAD_LIMIT, uploadingDevices: slots.uploadingDevices, unavailable, receipts,
      grants: signedGrants,
    });
  }
  const action = path.match(
    /^\/api\/files\/([^/]+)\/(lease|complete|fail|release)$/,
  );
  if (action && method === "POST") {
    const f = await fileGet(env, action[1]);
    await allow(env, u, f.groupId, "upload");
    if (f.userId !== u.id && u.role !== "admin")
      fail(403, "只能上传自己的文件");
    const op = action[2];
    if (f.packLeaderId && (f.id!==f.packLeaderId || op==="lease" || op==="complete"))
      fail(409, "此图片已登记为批量上传，请使用图片包接口");
    // A client may lose the response after the successful transaction; confirmation
    // retries remain safe after the consumed lease has been deleted.
    if (op === "complete" && f.status === "success" && f.expiresAt > now()) {
      return json({ file: fileView(f, url.origin) });
    }
    if (op === "lease") {
      if (
        ["success", "deleted", "expired"].includes(f.status) ||
        f.expiresAt <= now()
      )
        fail(409, "文件状态不允许上传");
      const c = await storageConfig(env);
      if (!c) fail(503, "存储未配置");
      const runId = b.runId === undefined ? undefined : text(b.runId, "上传运行标识", 120);
      const reservation = reserveUpload(env.DB, f.id, u.id, device, Date.now(), runId);
      const leaseId = reservation.id, expiresAt = reservation.expiresAt;
      const lease = await reservation.run();
      if (!lease.meta.changes)
        return json({ error: "正在等待上传名额，系统将按设备动态分配" }, 429, {
          "Retry-After": "2",
        });
      try {
        const signed = await presign(c, f.objectKey, f.contentType);
        const updated = await env.DB.prepare(
          "UPDATE files SET status='uploading',error=NULL WHERE id=? AND status IN('pending','failed','uploading') AND EXISTS(SELECT 1 FROM leases WHERE id=? AND expiresAt>?)",
        )
          .bind(f.id, leaseId, Date.now())
          .run();
        if (!updated.meta.changes) fail(409, "文件或授权状态已改变");
        return json({
          leaseId,
          ...signed,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      } catch (e) {
        await env.DB.prepare("DELETE FROM leases WHERE id=?")
          .bind(leaseId)
          .run();
        throw e;
      }
    }
    const lease = await env.DB.prepare(
      "SELECT * FROM leases WHERE id=? AND fileId=? AND userId=? AND deviceId=? AND expiresAt>?",
    )
      .bind(String(b.leaseId || ""), f.id, u.id, device, Date.now())
      .first<{ id: string }>();
    if (!lease) {
      if (op === "complete" && f.status === "uploading") {
        const latest = await fileGet(env, f.id);
        if (latest.status === "success" && latest.expiresAt > now())
          return json({ file: fileView(latest, url.origin) });
      }
      fail(409, "上传授权已失效");
    }
    if (op === "complete") {
      const object = await env.BUCKET.head(f.objectKey);
      if (
        !object ||
        object.size !== f.size ||
        object.httpMetadata?.contentType !== f.contentType
      )
        fail(409, "R2文件大小或类型未匹配，尚未确认成功");
      const confirmation = Date.now();
      // The bucket's eight-day backstop starts at the object write. Old orphaned
      // objects need a fresh PUT before they can start a full seven-day link.
      if (object!.uploaded.getTime() < confirmation - MAX_CONFIRM_OBJECT_AGE_MS)
        fail(409, "云端临时文件已超时，请重新上传");
      const [completed] = await env.DB.batch<FileRow>([
        env.DB.prepare(
          "UPDATE files SET status='success',error=NULL,completedAt=?,expiresAt=? WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM leases WHERE id=? AND expiresAt>?) RETURNING *",
        ).bind(new Date(confirmation).toISOString(), new Date(confirmation + IMAGE_RETENTION_MS).toISOString(), f.id, lease!.id, confirmation),
        env.DB.prepare("DELETE FROM leases WHERE id=?").bind(lease!.id),
      ]);
      const confirmed = completed.results[0];
      if (confirmed) return json({ file: fileView(confirmed, url.origin) });
      const latest = await fileGet(env, f.id);
      if (latest.status === "success" && latest.expiresAt > now())
        return json({ file: fileView(latest, url.origin) });
      fail(409, "文件或授权状态已改变");
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE files SET status=?,error=? WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM leases WHERE id=? AND fileId=files.id AND uploadedAt IS NULL)",
      ).bind(
        op === "fail" ? "failed" : "pending",
        op === "fail" ? String(b.error || "上传失败").slice(0, 500) : null,
        f.id,
        lease!.id,
      ),
      env.DB.prepare("DELETE FROM leases WHERE id=? AND uploadedAt IS NULL").bind(lease!.id),
    ]);
    return json({ ok: true });
  }
  const singleFile = path.match(/^\/api\/files\/([^/]+)$/);
  if (singleFile && method === "GET") {
    const file = await env.DB.prepare(
      "SELECT f.*,t.userId taskOwnerId FROM files f JOIN tasks t ON t.id=f.taskId WHERE f.id=?",
    )
      .bind(singleFile[1])
      .first<FileRow & { taskOwnerId: string }>();
    if (!file) fail(404, "文件不存在");
    const ownerCanUpload =
      file.taskOwnerId === u.id &&
      permissions(JSON.parse(u.permissions)).upload;
    await allow(env, u, file.groupId, ownerCanUpload ? "upload" : "view");
    return json({ file: fileView(file, url.origin) });
  }
  if ((path === "/api/files" || path === "/api/export") && method === "GET") {
    const exportMode = path.endsWith("export"),
      permission = exportMode ? "export" : "view";
    if (
      u.role !== "admin" &&
      !permissions(JSON.parse(u.permissions))[permission]
    )
      fail(403, "没有操作权限");
    const args: unknown[] = [u.role, u.id];
    let where =
      "WHERE (?='admin' OR (f.groupId IN(SELECT groupId FROM user_groups WHERE userId=?) AND g.status='active'))";
    for (const key of ["groupId", "taskId"])
      if (url.searchParams.get(key)) {
        if (key === "groupId")
          await allow(env, u, url.searchParams.get(key)!, permission);
        where += ` AND f.${key}=?`;
        args.push(url.searchParams.get(key));
      }
    if (exportMode && (url.searchParams.has("snapshot") || url.searchParams.has("verify"))) {
      return json(await exportSnapshotPage({ db: env.DB, key: env.CONFIG_KEY, actor: u, url, page: cursorPage(url, MAX_EXPORT_PAGE_SIZE), where, args, fail }));
    }
    if (exportMode) {
      where += " AND f.status='success' AND f.expiresAt>?";
      args.push(now());
    } else {
      const search = url.searchParams.get("search");
      if (search) {
        where += " AND (f.name LIKE ? OR f.relativePath LIKE ?)";
        args.push("%" + search + "%", "%" + search + "%");
      }
      const status = url.searchParams.get("status");
      if (status) {
        if (status === "expired") {
          where +=
            " AND (f.status='expired' OR (f.status='success' AND f.expiresAt<=?))";
          args.push(now());
        } else {
          where += " AND f.status=?";
          args.push(status);
          if (status === "success") {
            where += " AND f.expiresAt>?";
            args.push(now());
          }
        }
      }
    }
    const page = exportMode ? cursorPage(url) : null;
    let nextCursor: string | null = null;
    let rows: FileRow[];
    let total = 0;
    if (exportMode) {
      if (page) {
        where += " AND f.id>?";
        const result = await env.DB.prepare(
          `SELECT f.* FROM files f JOIN groups g ON f.groupId=g.id ${where} ORDER BY f.id LIMIT ?`,
        )
          .bind(...args, page.cursor, page.limit + 1)
          .all<FileRow>();
        rows = result.results.slice(0, page.limit);
        if (result.results.length > page.limit)
          nextCursor = rows[rows.length - 1].id;
      } else {
        rows = (
          await env.DB.prepare(
            `SELECT f.* FROM files f JOIN groups g ON f.groupId=g.id ${where} ORDER BY f.createdAt DESC`,
          )
            .bind(...args)
            .all<FileRow>()
        ).results;
      }
    } else {
      const rawPage = Number(url.searchParams.get("page"));
      const pageNumber = Number.isFinite(rawPage)
        ? Math.max(1, Math.floor(rawPage))
        : 1;
      const offset = Math.min(Number.MAX_SAFE_INTEGER, (pageNumber - 1) * 100);
      const count = await env.DB.prepare(
        `SELECT COUNT(*) total FROM files f JOIN groups g ON f.groupId=g.id ${where}`,
      )
        .bind(...args)
        .first<{ total: number }>();
      total = count?.total ?? 0;
      rows = (
        await env.DB.prepare(
          `SELECT f.* FROM files f JOIN groups g ON f.groupId=g.id ${where} ORDER BY f.createdAt DESC,f.id DESC LIMIT 100 OFFSET ?`,
        )
          .bind(...args, offset)
          .all<FileRow>()
      ).results;
    }
    const files = rows.map((f) => fileView(f, url.origin));
    if (exportMode)
      return json({
        files: files.map((f) => ({
          taskId: f.taskId,
          groupId: f.groupId,
          name: f.name,
          relativePath: f.relativePath,
          url: f.url,
          size: f.size,
          createdAt: f.createdAt,
        })),
        ...(page ? { nextCursor } : {}),
      });
    return json({
      files,
      total,
    });
  }
  if (path === "/api/files/delete" && method === "POST") {
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100)
      fail(400, "每次可删除1至100个文件");
    const files = await Promise.all(
      b.ids.map((id) => fileGet(env, String(id))),
    );
    for (const f of files) await allow(env, u, f.groupId, "delete");
    let deleted = 0;
    for (const f of files) {
      if (f.status === "deleted") {
        if (f.packObjectKey) await cleanPackObjects(env.DB, env.BUCKET, f.packObjectKey);
        else if (!f.packLeaderId) await env.BUCKET.delete(f.objectKey);
        continue;
      }
      const [updated] = await env.DB.batch<Pick<FileRow,"packLeaderId"|"packObjectKey">>([
        env.DB.prepare("UPDATE files SET status='deleted' WHERE id=? AND status<>'deleted' RETURNING packLeaderId,packObjectKey").bind(
          f.id,
        ),
        env.DB.prepare("DELETE FROM leases WHERE fileId=?").bind(f.id),
      ]);
      const row = updated.results[0];
      if (!row) continue;
      if (row.packObjectKey) await cleanPackObjects(env.DB, env.BUCKET, row.packObjectKey);
      else if (!row.packLeaderId) await env.BUCKET.delete(f.objectKey);
      deleted++;
    }
    await audit(env, u.id, "files.delete", { ids: b.ids });
    return json({ deleted });
  }
  if (path === "/api/audit" && method === "GET") {
    admin(u);
    return json({
      events: (
        await env.DB.prepare(
          "SELECT a.*,u.displayName FROM audit a LEFT JOIN users u ON a.userId=u.id ORDER BY a.createdAt DESC LIMIT 200",
        ).all()
      ).results,
    });
  }
  return json({ error: "接口不存在" }, 404);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const release = await handleRelease(request, env);
      if (release) return release;
      const r = await handle(request, env);
      r.headers.set("Access-Control-Allow-Origin", "*");
      r.headers.set("Access-Control-Expose-Headers", "Retry-After");
      return r;
    } catch (e) {
      if (e instanceof HttpError)
        return json({ error: e.message }, e.status, {
          "Access-Control-Allow-Origin": "*",
        });
      if (
        e instanceof Error &&
        /UNIQUE constraint failed: users\.username\b/.test(e.message)
      )
        return json({ error: "用户名已存在，请使用其他用户名" }, 409, {
          "Access-Control-Allow-Origin": "*",
        });
      console.error(
        JSON.stringify({
          event: "request.error",
          path: new URL(request.url).pathname,
          message: e instanceof Error ? e.message : "unknown",
        }),
      );
      return json({ error: "服务器暂时无法处理请求" }, 500, {
        "Access-Control-Allow-Origin": "*",
      });
    }
  },
  async scheduled(_event: ScheduledController, env: Env) {
    const time = Date.now(), cutoff = new Date(time).toISOString();
    for (let batch = 0; batch < EXPIRY_BATCHES_PER_SWEEP; batch++) {
      const { results } = await env.DB.prepare(
        "SELECT id,objectKey,packLeaderId FROM files WHERE expiresAt<=? AND status NOT IN('deleted','expired') AND NOT EXISTS(SELECT 1 FROM leases WHERE fileId=COALESCE(files.packLeaderId,files.id) AND expiresAt>?) ORDER BY expiresAt,id LIMIT ?",
      ).bind(cutoff,time,EXPIRY_BATCH_SIZE).all<Pick<FileRow,"id"|"objectKey"|"packLeaderId">>();
      if (!results.length) break;
      // Active leases protect confirmations. Old links are already unavailable.
      // Leave the rows eligible for retry if a bucket delete fails.
      const individualKeys = results.filter(file=>!file.packLeaderId).map(file=>file.objectKey);
      if (individualKeys.length) await env.BUCKET.delete(individualKeys);
      const ids = JSON.stringify(results.map(file=>file.id));
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE files SET status='expired' WHERE id IN(SELECT value FROM json_each(?)) AND expiresAt<=? AND status NOT IN('deleted','expired')",
        ).bind(ids,cutoff),
        env.DB.prepare("DELETE FROM leases WHERE fileId IN(SELECT value FROM json_each(?)) AND expiresAt<=?")
          .bind(ids,time),
      ]);
      if (results.length < EXPIRY_BATCH_SIZE) break;
    }
    await env.DB.prepare("DELETE FROM pack_attempts WHERE leaseId IN (SELECT leaseId FROM pack_attempts WHERE cleanupAt<=? ORDER BY cleanupAt LIMIT 1000)").bind(time).run();
    await cleanPackObjects(env.DB, env.BUCKET);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expiresAt<=?").bind(
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM leases WHERE expiresAt<=?").bind(Date.now()),
      pruneUploadDemands(env.DB),
      env.DB.prepare("DELETE FROM login_attempts WHERE resetAt<=?").bind(
        Date.now(),
      ),
    ]);
  },
} satisfies ExportedHandler<Env>;

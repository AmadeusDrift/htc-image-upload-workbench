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
type FileRow = {
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
  perDevice: 5,
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
function cursorPage(url: URL) {
  if (!url.searchParams.has("limit") && !url.searchParams.has("cursor"))
    return null;
  const rawLimit = url.searchParams.get("limit") ?? "500";
  const limit = Number(rawLimit);
  if (
    !/^\d+$/.test(rawLimit) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    fail(400, "分页数量必须为1至500的整数");
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
async function authenticate(request: Request, env: Env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  const device = request.headers.get("X-Device-Id");
  if (!token || !device) fail(401, "请先登录");
  const key = await sha(token!);
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
      limits: { global: 20, perUser: 5, perDevice: 5 },
      version: "1.0.8",
    });
  const b = method === "POST" || method === "PATCH" ? await parse(request) : {};
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
  const { u, device, tokenHash } = await authenticate(request, env);
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
        retentionDays: 7,
        perDevice: 5,
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
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
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
        "SELECT * FROM files WHERE taskId=? AND id>? ORDER BY id LIMIT ?",
      )
        .bind(taskId[1], page.cursor, page.limit + 1)
        .all<FileRow>();
      const files = rows.results.slice(0, page.limit);
      return json({
        task,
        files: files.map((f) => fileView(f, url.origin)),
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
  const action = path.match(
    /^\/api\/files\/([^/]+)\/(lease|complete|fail|release)$/,
  );
  if (action && method === "POST") {
    const f = await fileGet(env, action[1]);
    await allow(env, u, f.groupId, "upload");
    if (f.userId !== u.id && u.role !== "admin")
      fail(403, "只能上传自己的文件");
    const op = action[2];
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
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE files SET status='pending',error='上传授权已超时' WHERE status='uploading' AND id IN(SELECT fileId FROM leases WHERE expiresAt<=?)",
        ).bind(Date.now()),
        env.DB.prepare("DELETE FROM leases WHERE expiresAt<=?").bind(
          Date.now(),
        ),
      ]);
      const leaseId = crypto.randomUUID(),
        expiresAt = Date.now() + 300000;
      const lease = await env.DB.prepare(
        `INSERT INTO leases(id,fileId,userId,deviceId,expiresAt) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM leases WHERE expiresAt>?)<20 AND (SELECT COUNT(*) FROM leases WHERE userId=? AND expiresAt>?)<5 AND (SELECT COUNT(*) FROM leases WHERE deviceId=? AND expiresAt>?)<5 AND NOT EXISTS(SELECT 1 FROM leases WHERE fileId=?) AND EXISTS(SELECT 1 FROM files WHERE id=? AND status IN('pending','failed','uploading'))`,
      )
        .bind(
          leaseId,
          f.id,
          u.id,
          device,
          expiresAt,
          Date.now(),
          u.id,
          Date.now(),
          device,
          Date.now(),
          f.id,
          f.id,
        )
        .run();
      if (!lease.meta.changes)
        return json({ error: "上传并发已满，请稍后重试" }, 429, {
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
    if (!lease) fail(409, "上传授权已失效");
    if (op === "complete") {
      const object = await env.BUCKET.head(f.objectKey);
      if (
        !object ||
        object.size !== f.size ||
        object.httpMetadata?.contentType !== f.contentType
      )
        fail(409, "R2文件大小或类型未匹配，尚未确认成功");
      const completed = await env.DB.batch([
        env.DB.prepare(
          "UPDATE files SET status='success',error=NULL,completedAt=? WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM leases WHERE id=? AND expiresAt>?)",
        ).bind(now(), f.id, lease!.id, Date.now()),
        env.DB.prepare("DELETE FROM leases WHERE id=?").bind(lease!.id),
      ]);
      if (!completed[0].meta.changes) fail(409, "文件或授权状态已改变");
      return json({ file: fileView(await fileGet(env, f.id), url.origin) });
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM leases WHERE id=?").bind(lease!.id),
      env.DB.prepare(
        "UPDATE files SET status=?,error=? WHERE id=? AND status='uploading'",
      ).bind(
        op === "fail" ? "failed" : "pending",
        op === "fail" ? String(b.error || "上传失败").slice(0, 500) : null,
        f.id,
      ),
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
      if (f.status === "deleted") continue;
      await env.DB.batch([
        env.DB.prepare("UPDATE files SET status='deleted' WHERE id=?").bind(
          f.id,
        ),
        env.DB.prepare("DELETE FROM leases WHERE fileId=?").bind(f.id),
      ]);
      await env.BUCKET.delete(f.objectKey);
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
    const rows = await env.DB.prepare(
      "SELECT id,objectKey FROM files WHERE expiresAt<=? AND status NOT IN('deleted','expired') LIMIT 500",
    )
      .bind(now())
      .all<{ id: string; objectKey: string }>();
    for (const f of rows.results) {
      await env.BUCKET.delete(f.objectKey);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE files SET status='expired' WHERE id=? AND status<>'deleted'",
        ).bind(f.id),
        env.DB.prepare("DELETE FROM leases WHERE fileId=?").bind(f.id),
      ]);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expiresAt<=?").bind(
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM leases WHERE expiresAt<=?").bind(Date.now()),
      env.DB.prepare("DELETE FROM login_attempts WHERE resetAt<=?").bind(
        Date.now(),
      ),
    ]);
  },
} satisfies ExportedHandler<Env>;

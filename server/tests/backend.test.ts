import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
let mf: Miniflare;
let token: string;
let groupId: string;
const call = async (
  path: string,
  body?: unknown,
  auth = token,
  device = "device-a",
) => {
  const r = await mf.dispatchFetch("http://localhost" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + auth,
      "X-Device-Id": device,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
beforeAll(async () => {
  const b = await build({
    entryPoints: ["server/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: b.outputFiles[0].text,
      compatibilityDate: "2026-10-29",
      d1Databases: ["DB"],
      r2Buckets: ["BUCKET"],
      outboundService: async () =>
        new Response("InvalidAccessKeyId", { status: 403 }),
      bindings: {
        SETUP_TOKEN: "test-setup",
        CONFIG_KEY: "a-very-long-test-config-key",
        R2_ENDPOINT: "https://test.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "test",
      },
    }),
  );
  await (
    await mf.getD1Database("DB")
  ).exec(readFileSync("server/schema.sql", "utf8").replace(/\n/g, " "));
});
afterAll(async () => {
  await mf?.dispose();
});
describe("Worker integration", () => {
  it("gates first setup and rejects anonymous administration", async () => {
    expect(
      (
        await call(
          "/api/setup",
          {
            setupToken: "wrong",
            username: "admin",
            password: "Password123!",
            displayName: "Admin",
          },
          "",
        )
      ).status,
    ).toBe(403);
    const a = await call(
      "/api/setup",
      {
        setupToken: "test-setup",
        username: "admin",
        password: "Password123!",
        displayName: "Admin",
      },
      "",
    );
    expect(a.status).toBe(200);
    token = a.body.token;
    expect((await call("/api/users", undefined, "")).status).toBe(401);
    expect(
      (await call("/api/setup", { setupToken: "test-setup" }, "")).status,
    ).toBe(409);
  });
  it("creates groups and denies unconfigured uploads", async () => {
    const g = await call("/api/groups", { name: "Business" });
    expect(g.status).toBe(200);
    groupId = g.body.group.id;
    const t = await call("/api/tasks", { groupId, name: "Batch" });
    const f = await call("/api/tasks/" + t.body.task.id + "/files", {
      files: [
        {
          clientId: "1",
          name: "a.png",
          relativePath: "a.png",
          size: 3,
          contentType: "image/png",
          sha256: "a".repeat(64),
        },
      ],
    });
    expect(
      (await call("/api/files/" + f.body.files[0].id + "/lease", {})).status,
    ).toBe(503);
  });
  it("searches relative directories", async () => {
    const db = await mf.getD1Database("DB");
    await db.prepare("UPDATE files SET relativePath='folder/a.png'").run();
    expect((await call("/api/files?search=folder")).body.total).toBe(1);
  });
  it("persists export preference and reports uploading tasks", async () => {
    await mf.dispatchFetch("http://localhost/api/settings", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + token,
        "X-Device-Id": "device-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ settings: { exportFormat: "csv" } }),
    });
    expect((await call("/api/settings")).body.settings.exportFormat).toBe(
      "csv",
    );
    await (
      await mf.getD1Database("DB")
    )
      .prepare("UPDATE files SET status='uploading'")
      .run();
    expect((await call("/api/tasks")).body.tasks[0].status).toBe("uploading");
  });
  it("enforces permissions, immediate disable, and the last administrator guard", async () => {
    const u = await call("/api/users", {
      username: "staff",
      password: "Password123!",
      displayName: "Staff",
      role: "employee",
      groupIds: [groupId],
      permissions: { view: true, upload: false, export: false, delete: false },
    });
    expect(u.status).toBe(200);
    const login = await call(
      "/api/login",
      { username: "staff", password: "Password123!", deviceId: "staff-device" },
      "",
    );
    expect(login.status).toBe(200);
    expect(
      (
        await call(
          "/api/tasks",
          { groupId, name: "Forbidden" },
          login.body.token,
          "staff-device",
        )
      ).status,
    ).toBe(403);
    await mf.dispatchFetch("http://localhost/api/users/" + u.body.user.id, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + token,
        "X-Device-Id": "device-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(
      (await call("/api/me", undefined, login.body.token, "staff-device"))
        .status,
    ).toBe(401);
    const me = await call("/api/me");
    expect(
      (
        await mf.dispatchFetch(
          "http://localhost/api/users/" + me.body.user.id,
          {
            method: "PATCH",
            headers: {
              Authorization: "Bearer " + token,
              "X-Device-Id": "device-a",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ status: "disabled" }),
          },
        )
      ).status,
    ).toBe(409);
  });
  it("atomically caps leases, reclaims expiration, HEAD confirms, exports and deletes", async () => {
    expect(
      (
        await call("/api/storage", {
          accessKeyId: "test-key",
          secretAccessKey: "test-secret",
          endpoint: "https://test.r2.cloudflarestorage.com",
          bucket: "test",
        })
      ).status,
    ).toBe(200);
    const t = await call("/api/tasks", { groupId, name: "Concurrency" });
    const f = await call("/api/tasks/" + t.body.task.id + "/files", {
      files: Array.from({ length: 30 }, (_, i) => ({
        clientId: String(i),
        name: `${i}.png`,
        relativePath: `${i}.png`,
        size: 3,
        contentType: "image/png",
        sha256: "b".repeat(64),
      })),
    });
    const ids = f.body.files.map((x: any) => x.id);
    const results = await Promise.all(
      ids
        .slice(0, 6)
        .map((id: string) => call("/api/files/" + id + "/lease", {})),
    );
    expect(results.filter((x) => x.status === 200)).toHaveLength(5);
    expect(results.filter((x) => x.status === 429)).toHaveLength(1);
    const first = results.find((x) => x.status === 200)!;
    const firstId = ids[results.indexOf(first)];
    expect(
      (
        await call("/api/files/" + firstId + "/complete", {
          leaseId: first.body.leaseId,
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("/api/export?groupId=" + groupId)).body.files,
    ).toHaveLength(0);
    const db = await mf.getD1Database("DB");
    const row = await db
      .prepare("SELECT objectKey FROM files WHERE id=?")
      .bind(firstId)
      .first<{ objectKey: string }>();
    await (
      await mf.getR2Bucket("BUCKET")
    ).put(row!.objectKey, "abc", {
      httpMetadata: { contentType: "image/png" },
    });
    expect(
      (
        await call("/api/files/" + firstId + "/complete", {
          leaseId: first.body.leaseId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/api/files/" + firstId + "/complete", {
          leaseId: first.body.leaseId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/export?groupId=" + groupId)).body.files,
    ).toHaveLength(1);
    expect(
      (await mf.dispatchFetch("http://localhost/img/" + firstId)).status,
    ).toBe(200);
    expect(
      (await mf.dispatchFetch("http://localhost/img/" + firstId)).headers.get(
        "Cache-Control",
      ),
    ).toBe("no-store");
    const publicHead=await mf.dispatchFetch("http://localhost/img/"+firstId,{method:"HEAD"});
    expect(publicHead.status).toBe(200);
    expect(publicHead.headers.get("Content-Type")).toBe("image/png");
    expect(publicHead.headers.get("Content-Length")).toBe("3");
    expect((await publicHead.arrayBuffer()).byteLength).toBe(0);
    await db.prepare("UPDATE leases SET expiresAt=0").run();
    expect((await call("/api/files/" + ids[6] + "/lease", {})).status).toBe(
      200,
    );
    for (let u = 0; u < 3; u++) {
      await call("/api/users", {
        username: "u" + u,
        password: "Password123!",
        displayName: "User",
        role: "employee",
        groupIds: [groupId],
        permissions: { upload: true, view: true, export: true, delete: false },
      });
      const l = await call(
        "/api/login",
        { username: "u" + u, password: "Password123!", deviceId: "d" + u },
        "",
      );
      const ut = await call(
        "/api/tasks",
        { groupId, name: "User batch" },
        l.body.token,
        "d" + u,
      );
      const uf = await call(
        "/api/tasks/" + ut.body.task.id + "/files",
        {
          files: Array.from({ length: 5 }, (_, i) => ({
            clientId: String(i),
            name: i + ".png",
            relativePath: i + ".png",
            size: 3,
            contentType: "image/png",
            sha256: "c".repeat(64),
          })),
        },
        l.body.token,
        "d" + u,
      );
      const rs = await Promise.all(
        uf.body.files.map((f: any) =>
          call("/api/files/" + f.id + "/lease", {}, l.body.token, "d" + u),
        ),
      );
      expect(rs.every((x) => x.status === 200)).toBe(true);
    }
    const fill = await Promise.all(
      ids
        .slice(22, 26)
        .map((id: string) => call("/api/files/" + id + "/lease", {})),
    );
    expect(fill.every((x) => x.status === 200)).toBe(true);
    expect((await call("/api/files/" + ids[26] + "/lease", {})).status).toBe(
      429,
    );
    const secondDevice = await call(
      "/api/login",
      {
        username: "admin",
        password: "Password123!",
        deviceId: "second-device",
      },
      "",
    );
    expect(
      (
        await call(
          "/api/files/" + ids[26] + "/lease",
          {},
          secondDevice.body.token,
          "second-device",
        )
      ).status,
    ).toBe(429);
    await call("/api/users", {
      username: "global-check",
      password: "Password123!",
      displayName: "Global",
      groupIds: [groupId],
      permissions: { upload: true, view: true, export: true, delete: false },
    });
    const globalUser = await call(
      "/api/login",
      {
        username: "global-check",
        password: "Password123!",
        deviceId: "global-device",
      },
      "",
    );
    const globalTask = await call(
      "/api/tasks",
      { groupId, name: "Global cap" },
      globalUser.body.token,
      "global-device",
    );
    const globalFile = await call(
      "/api/tasks/" + globalTask.body.task.id + "/files",
      {
        files: [
          {
            clientId: "global",
            name: "global.png",
            relativePath: "global.png",
            size: 3,
            contentType: "image/png",
            sha256: "d".repeat(64),
          },
        ],
      },
      globalUser.body.token,
      "global-device",
    );
    expect(
      (
        await call(
          "/api/files/" + globalFile.body.files[0].id + "/lease",
          {},
          globalUser.body.token,
          "global-device",
        )
      ).status,
    ).toBe(429);
    expect(
      (await call("/api/files/delete", { ids: [firstId] })).body.deleted,
    ).toBe(1);
    expect(
      (await mf.dispatchFetch("http://localhost/img/" + firstId)).status,
    ).toBe(404);
    expect(
      await (await mf.getR2Bucket("BUCKET")).head(row!.objectKey),
    ).toBeNull();
  });
  it("releases slots, records failure, prevents cross-group access and hides encrypted secrets", async () => {
    const db = await mf.getD1Database("DB");
    await db.prepare("UPDATE leases SET expiresAt=0").run();
    const row = await db
      .prepare("SELECT id FROM files WHERE status='pending' LIMIT 1")
      .first<{ id: string }>();
    const lease = await call("/api/files/" + row!.id + "/lease", {});
    expect(lease.status).toBe(200);
    expect(
      (
        await call("/api/files/" + row!.id + "/fail", {
          leaseId: lease.body.leaseId,
          error: "network",
        })
      ).status,
    ).toBe(200);
    const file = await db
      .prepare("SELECT status FROM files WHERE id=?")
      .bind(row!.id)
      .first<{ status: string }>();
    expect(file!.status).toBe("failed");
    const retry = await call("/api/files/" + row!.id + "/lease", {});
    expect(retry.status).toBe(200);
    expect(
      (
        await call("/api/files/" + row!.id + "/release", {
          leaseId: retry.body.leaseId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await db
        .prepare("SELECT COUNT(*) n FROM leases WHERE fileId=?")
        .bind(row!.id)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    const other = await call("/api/groups", { name: "Private" });
    const staff = await call(
      "/api/login",
      { username: "u0", password: "Password123!", deviceId: "d0" },
      "",
    );
    expect(
      (
        await call(
          "/api/files?groupId=" + other.body.group.id,
          undefined,
          staff.body.token,
          "d0",
        )
      ).status,
    ).toBe(403);
    const stored = await db
      .prepare("SELECT value FROM config WHERE key='storage'")
      .first<{ value: string }>();
    expect(stored!.value).not.toContain("test-secret");
    expect(stored!.value).not.toContain("test-key");
    expect(JSON.stringify((await call("/api/settings")).body)).not.toContain(
      "test-secret",
    );
  });
  it("does not report successful storage test for rejected direct upload credentials", async () => {
    expect((await call("/api/storage/test", {})).status).toBe(502);
  });
  it("allows upload-only staff to reconcile their own task but not another task", async () => {
    await call("/api/users", {
      username: "upload-only",
      password: "Password123!",
      displayName: "Uploader",
      groupIds: [groupId],
      permissions: { upload: true, view: false, export: false, delete: false },
    });
    const login = await call(
      "/api/login",
      {
        username: "upload-only",
        password: "Password123!",
        deviceId: "upload-only-device",
      },
      "",
    );
    const task = await call(
      "/api/tasks",
      { groupId, name: "Reconcile" },
      login.body.token,
      "upload-only-device",
    );
    expect(
      (
        await call(
          "/api/tasks/" + task.body.task.id,
          undefined,
          login.body.token,
          "upload-only-device",
        )
      ).status,
    ).toBe(200);
    const other = await call("/api/tasks", { groupId, name: "Other task" });
    expect(
      (
        await call(
          "/api/tasks/" + other.body.task.id,
          undefined,
          login.body.token,
          "upload-only-device",
        )
      ).status,
    ).toBe(403);
  });
  it("makes task creation idempotent with validated client request keys", async () => {
    const clientTaskId = crypto.randomUUID();
    const requests = await Promise.all(
      Array.from({ length: 3 }, () =>
        call("/api/tasks", { groupId, name: "Stable creation", clientTaskId }),
      ),
    );
    expect(requests.every((r) => r.status === 200)).toBe(true);
    expect(new Set(requests.map((r) => r.body.task.id)).size).toBe(1);
    const db = await mf.getD1Database("DB");
    expect(
      (await db
        .prepare("SELECT COUNT(*) n FROM tasks WHERE name='Stable creation'")
        .first<{ n: number }>())!.n,
    ).toBe(1);
    const replay = await call("/api/tasks", {
      groupId,
      name: "Changed replay name",
      clientTaskId,
    });
    expect(replay.body.task).toEqual(requests[0].body.task);
    expect(
      (await db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='task.create' AND json_extract(detail,'$.id')=?",
        )
        .bind(requests[0].body.task.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    const other = await call("/api/groups", {
      name: "Other idempotency group",
    });
    expect(
      (
        await call("/api/tasks", {
          groupId: other.body.group.id,
          name: "Other",
          clientTaskId,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/api/tasks", {
          groupId,
          name: "Invalid",
          clientTaskId: "not-a-uuid",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("/api/tasks", { groupId, name: "Legacy request" })).status,
    ).toBe(200);
  });
  it("defaults legacy settings to PNG compression and validates saved quality", async () => {
    const initial = await call("/api/settings");
    expect(initial.body.settings.compressPng).toBe(true);
    expect(initial.body.settings.jpegQuality).toBe(90);
    const patch = async (settings: unknown) =>
      mf.dispatchFetch("http://localhost/api/settings", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + token,
          "X-Device-Id": "device-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings }),
      });
    expect((await patch({ compressPng: false, jpegQuality: 85 })).status).toBe(
      200,
    );
    const saved = await call("/api/settings");
    expect(saved.body.settings.compressPng).toBe(false);
    expect(saved.body.settings.jpegQuality).toBe(85);
    for (const jpegQuality of [79, 96, 85.5, "85", null])
      expect((await patch({ jpegQuality })).status).toBe(400);
    expect((await patch({ compressPng: "false" })).status).toBe(400);
    expect((await call("/api/settings")).body.settings.jpegQuality).toBe(85);
    expect((await patch({ jpegQuality: 80 })).status).toBe(200);
    expect((await patch({ jpegQuality: 95 })).status).toBe(200);
  });
  it("completes a disposable employee password cycle without revoking the current device", async () => {
    const username = "password-cycle-" + crypto.randomUUID(),
      oldPassword = "InitialPassword123!",
      newPassword = "12345678";
    const created = await call("/api/users", {
      username,
      displayName: "Password cycle",
      password: oldPassword,
      groupIds: [],
      permissions: {},
    });
    expect(created.status).toBe(200);
    expect(created.body.user.mustChangePassword).toBe(true);
    const current = await call(
      "/api/login",
      { username, password: oldPassword, deviceId: "cycle-current" },
      "",
    );
    const other = await call(
      "/api/login",
      { username, password: oldPassword, deviceId: "cycle-other" },
      "",
    );
    expect(current.status).toBe(200);
    expect(other.status).toBe(200);
    const db = await mf.getD1Database("DB");
    const before = await db
      .prepare("SELECT passwordHash FROM users WHERE id=?")
      .bind(created.body.user.id)
      .first<{ passwordHash: string }>();
    expect(
      (
        await call(
          "/api/password",
          { oldPassword: "IncorrectPassword!", newPassword },
          current.body.token,
          "cycle-current",
        )
      ).status,
    ).toBe(403);
    expect(
      (await db
        .prepare("SELECT passwordHash FROM users WHERE id=?")
        .bind(created.body.user.id)
        .first<{ passwordHash: string }>())!.passwordHash,
    ).toBe(before!.passwordHash);
    expect(
      (
        await call(
          "/api/password",
          { oldPassword, newPassword },
          current.body.token,
          "cycle-current",
        )
      ).status,
    ).toBe(200);
    const me = await call(
      "/api/me",
      undefined,
      current.body.token,
      "cycle-current",
    );
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(false);
    expect(
      (await call("/api/me", undefined, other.body.token, "cycle-other"))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          "/api/login",
          { username, password: oldPassword, deviceId: "cycle-current" },
          "",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          "/api/login",
          { username, password: newPassword, deviceId: "cycle-current" },
          "",
        )
      ).status,
    ).toBe(200);
  });
  it("reports duplicate usernames as a conflict without changing the existing account", async () => {
    const data = {
      username: "duplicate-check",
      displayName: "Original",
      password: "InitialPassword123!",
      groupIds: [],
      permissions: {},
    };
    expect((await call("/api/users", data)).status).toBe(200);
    const conflict = await call("/api/users", {
      ...data,
      username: "DUPLICATE-CHECK",
      displayName: "Duplicate",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toContain("用户名");
    const users = (await call("/api/users")).body.users;
    expect(
      users.filter((u: any) => u.username.toLowerCase() === "duplicate-check"),
    ).toHaveLength(1);
    expect(
      users.find((u: any) => u.username === "duplicate-check").displayName,
    ).toBe("Original");
  });
  it("accepts only one concurrent password change using the same old password", async () => {
    const username = "concurrent-password-" + crypto.randomUUID(),
      oldPassword = "InitialPassword123!";
    await call("/api/users", {
      username,
      displayName: "Concurrent password",
      password: oldPassword,
      groupIds: [],
      permissions: {},
    });
    const current = await call(
      "/api/login",
      { username, password: oldPassword, deviceId: "concurrent-password" },
      "",
    );
    const result = await Promise.all(
      ["FirstChangedPassword123!", "SecondChangedPassword123!"].map(
        (newPassword) =>
          call(
            "/api/password",
            { oldPassword, newPassword },
            current.body.token,
            "concurrent-password",
          ),
      ),
    );
    expect(result.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      result.filter((r) => r.status === 403 || r.status === 409),
    ).toHaveLength(1);
    const winner =
      result[0].status === 200
        ? "FirstChangedPassword123!"
        : "SecondChangedPassword123!";
    expect(
      (
        await call(
          "/api/login",
          { username, password: winner, deviceId: "concurrent-password" },
          "",
        )
      ).status,
    ).toBe(200);
  });
});

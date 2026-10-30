const encoder = new TextEncoder();
export const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (n) => n.toString(16).padStart(2, "0")).join(
    "",
  );
export async function sha(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export async function safeEqual(a: string, b: string) {
  const x = await crypto.subtle.digest("SHA-256", encoder.encode(a));
  const y = await crypto.subtle.digest("SHA-256", encoder.encode(b));
  return crypto.subtle.timingSafeEqual(x, y);
}
export async function hashPassword(
  password: string,
  salt = crypto.randomUUID(),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${hex(bits)}`;
}
export async function verifyPassword(password: string, hash: string) {
  const parts = hash.split(":");
  return (
    parts.length === 4 &&
    (await safeEqual(await hashPassword(password, parts[2]), hash))
  );
}
export function passwordValid(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}
export function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
export async function encrypt(value: unknown, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(data)),
  });
}
export async function decrypt<T>(value: string, secret: string): Promise<T> {
  const parsed = JSON.parse(value);
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(parsed.iv) },
        key,
        new Uint8Array(parsed.data),
      ),
    ),
  );
}

import { AwsClient } from "aws4fetch";
import { decrypt } from "./auth";
export type StorageConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
};
export async function storageConfig(env: Env): Promise<StorageConfig | null> {
  if (!env.CONFIG_KEY) return null;
  const row = await env.DB.prepare(
    "SELECT value FROM config WHERE key='storage'",
  ).first<{ value: string }>();
  return row ? decrypt<StorageConfig>(row.value, env.CONFIG_KEY) : null;
}
export async function presign(
  config: StorageConfig,
  key: string,
  contentType: string,
  expiresIn = 300,
  packSha256?: string | null,
) {
  const url = new URL(
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`,
  );
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signer = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (packSha256)
    headers["x-amz-checksum-sha256"] = btoa(String.fromCharCode(...packSha256.match(/../g)!.map(byte => parseInt(byte, 16))));
  const signed = await signer.sign(url.toString(), {
    method: "PUT",
    headers,
    aws: { signQuery: true, allHeaders: !!packSha256 },
  });
  return { uploadUrl: signed.url, headers };
}

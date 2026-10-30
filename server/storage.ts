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
) {
  const url = new URL(
    `${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`,
  );
  url.searchParams.set("X-Amz-Expires", "300");
  const signer = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const signed = await signer.sign(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true },
  });
  return { uploadUrl: signed.url, headers: { "Content-Type": contentType } };
}

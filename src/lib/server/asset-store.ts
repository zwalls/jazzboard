import { randomUUID } from "node:crypto";

import { getRedisForAssets } from "@/lib/server/room-store";

const ASSET_KEY_PREFIX = "jazzboard:asset:";
const REDIS_ASSET_TTL_SECONDS = 7 * 24 * 60 * 60;

type EncodedRoomAsset = {
  name: string;
  mimeType: string;
  bytesBase64: string;
};

export type StoredRoomAsset = {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
};

function assetKey(roomId: string, assetId: string): string {
  return `${ASSET_KEY_PREFIX}${roomId}:${assetId}`;
}

export async function putRedisRoomAsset(input: {
  roomId: string;
  file: File;
}): Promise<{ assetId: string }> {
  const redis = getRedisForAssets();
  if (!redis) throw new Error("Redis asset storage is unavailable.");

  const assetId = randomUUID();
  const encoded: EncodedRoomAsset = {
    name: input.file.name,
    mimeType: input.file.type,
    bytesBase64: Buffer.from(await input.file.arrayBuffer()).toString("base64"),
  };
  await redis.set(
    assetKey(input.roomId, assetId),
    JSON.stringify(encoded),
    "EX",
    REDIS_ASSET_TTL_SECONDS,
  );
  return { assetId };
}

export async function getRedisRoomAsset(
  roomId: string,
  assetId: string,
): Promise<StoredRoomAsset | null> {
  const redis = getRedisForAssets();
  if (!redis) return null;
  const raw = await redis.get(assetKey(roomId, assetId));
  if (!raw) return null;

  try {
    const encoded = JSON.parse(raw) as Partial<EncodedRoomAsset>;
    if (
      typeof encoded.name !== "string" ||
      typeof encoded.mimeType !== "string" ||
      typeof encoded.bytesBase64 !== "string"
    ) {
      return null;
    }
    return {
      name: encoded.name,
      mimeType: encoded.mimeType,
      bytes: new Uint8Array(Buffer.from(encoded.bytesBase64, "base64")),
    };
  } catch {
    return null;
  }
}

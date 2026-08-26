import { z } from "zod";

export const snapshotTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const snapshotIdSchema = z.string().regex(/^snapshot_[0-9a-f-]{36}$/i);

export const snapshotScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room") }).strict(),
  z
    .object({
      kind: z.literal("diagram"),
      diagramId: z.string().min(1).max(128),
      expectedDiagramRevision: z.number().int().positive(),
    })
    .strict(),
]);

export const createReadonlySnapshotRequestSchema = z
  .object({
    expectedRoomRevision: z.number().int().positive(),
    scope: snapshotScopeSchema,
    title: z.string().trim().min(1).max(160).optional(),
    expiresInHours: z.number().int().min(1).max(7 * 24).optional(),
  })
  .strict();

export const revokeReadonlySnapshotRequestSchema = z
  .object({ snapshotId: snapshotIdSchema })
  .strict();

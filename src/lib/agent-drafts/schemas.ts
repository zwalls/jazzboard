import { z } from "zod";

import {
  activityMutationMetadataSchema,
  semanticTransactionSchema,
} from "@/lib/domain/schemas";

const draftId = z.string().regex(/^draft_[A-Za-z0-9_-]{1,120}$/);
const positiveRevision = z.number().int().positive();
const temporaryReferences = z
  .record(z.string().min(1).max(128), z.string().min(1).max(128))
  .refine((references) => Object.keys(references).length <= 256, "At most 256 temporary references are allowed.")
  .refine(
    (references) => new Set(Object.values(references)).size === Object.values(references).length,
    "Temporary references must resolve to unique candidate IDs.",
  );

export const stageAgentCanvasDraftRequestSchema = z
  .object({
    draftId,
    baselineRoomRevision: positiveRevision,
    transaction: semanticTransactionSchema,
    temporaryReferences: temporaryReferences.default({}),
    metadata: activityMutationMetadataSchema.optional(),
  })
  .strict();

export const replaceAgentCanvasDraftRequestSchema = z
  .object({
    expectedDraftRevision: positiveRevision,
    updateMode: z.enum(["replace", "patch"]).default("replace"),
    baselineRoomRevision: positiveRevision,
    transaction: semanticTransactionSchema,
    temporaryReferences: temporaryReferences.default({}),
    metadata: activityMutationMetadataSchema.optional(),
  })
  .strict();

export const keepaliveAgentCanvasDraftRequestSchema = z
  .object({ expectedDraftRevision: positiveRevision })
  .strict();

export const commitAgentCanvasDraftRequestSchema = z
  .object({
    expectedDraftRevision: positiveRevision,
    intentionalFindingAcknowledgements: z.record(
      z.string().min(1).max(200),
      z.string().trim().min(8).max(320),
    ).refine((value) => Object.keys(value).length <= 256, "At most 256 finding acknowledgements are allowed.").optional(),
    intentionalOmittedFindingsAcknowledgement: z.string().trim().min(8).max(320).optional(),
  })
  .strict();

export const discardAgentCanvasDraftRequestSchema = z
  .object({ expectedDraftRevision: positiveRevision })
  .strict();

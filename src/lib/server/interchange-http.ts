import { z } from "zod";

import type { ActorKind } from "@/lib/domain/types";
import { jazzboardTemplateV1Schema } from "@/lib/interchange/schemas";
import type { ProjectArtifactScope } from "@/lib/interchange/types";

import { errorResponse, json, readJsonBody, runMutationRequest } from "./http";
import {
  exportAuthorizedRoomArtifact,
  instantiateAuthorizedRoomTemplate,
  JAZZBOARD_ARTIFACT_EXPORT_FORMATS,
} from "./interchange-service";
import { requireGuestParticipantId } from "./session";

type Context = { params: Promise<{ roomId: string }> };

const id = z.string().min(1).max(128);
const format = z.enum(JAZZBOARD_ARTIFACT_EXPORT_FORMATS);
const exportQuerySchema = z.discriminatedUnion("scope", [
  z.object({ format, scope: z.literal("room") }).strict(),
  z.object({ format, scope: z.literal("diagram"), diagramId: id }).strict(),
  z
    .object({
      format,
      scope: z.literal("selection"),
      objectId: z.array(id).min(1).max(500),
    })
    .strict(),
]);

export const instantiateTemplateRequestSchema = z
  .object({
    expectedRoomRevision: z.number().int().positive(),
    template: jazzboardTemplateV1Schema,
    origin: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    baseZIndex: z.number().int().min(0).max(1_000_000).optional(),
    intent: z.string().trim().min(1).max(1_000).optional(),
    summary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

function queryObject(url: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (key === "objectId") {
      const current = result.objectId;
      result.objectId = Array.isArray(current) ? [...current, value] : [value];
      continue;
    }
    if (key in result) {
      result[key] = [result[key], value];
    } else {
      result[key] = value;
    }
  }
  result.format ??= "semantic_json";
  result.scope ??= "room";
  return result;
}

function projectScope(input: z.output<typeof exportQuerySchema>): ProjectArtifactScope {
  if (input.scope === "room") return { kind: "room" };
  if (input.scope === "diagram") return { kind: "diagram", diagramId: input.diagramId };
  return { kind: "selection", objectIds: input.objectId };
}

export async function handleAuthorizedArtifactExport(
  request: Request,
  context: Context,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const input = exportQuerySchema.parse(queryObject(request.url));
    const result = await exportAuthorizedRoomArtifact({
      roomId,
      participantId,
      actorKind,
      format: input.format,
      scope: projectScope(input),
    });
    return json(
      { ok: true, export: result },
      { headers: { "x-content-type-options": "nosniff" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAuthorizedTemplateInstantiation(
  request: Request,
  context: Context,
  actorKind: ActorKind,
): Promise<Response> {
  try {
    const participantId = requireGuestParticipantId(request);
    const { roomId } = await context.params;
    const body = instantiateTemplateRequestSchema.parse(await readJsonBody(request));
    const { intent, summary, ...mutation } = body;
    const result = await runMutationRequest({
      request,
      participantId,
      roomId,
      operation: "room.template.instantiate",
      actorKind,
      parsedBody: body,
      execute: () => instantiateAuthorizedRoomTemplate({
        roomId,
        participantId,
        actorKind,
        ...mutation,
        metadata: intent || summary ? { intent, summary } : undefined,
      }),
    });
    return json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

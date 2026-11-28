import type { AuthInfo, CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  renderTargetedCanvasPng,
  targetedCanvasPngInputSchema,
  TargetedCanvasPngError,
} from "@/lib/canvas/targeted-png.server";

import { requireMutationRole, requireParticipant } from "@/lib/domain/engine";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { canvasCommandSchema, createCanvasObjectSchema } from "@/lib/domain/schemas";
import type { CanvasObject } from "@/lib/domain/types";
import { runMutationRequest } from "@/lib/server/http";
import { sha256 } from "@/lib/server/idempotency";
import {
  remoteRoomIdSchema,
  requireRemoteMcpGrant,
} from "@/lib/server/remote-mcp-auth";
import { type RemoteMcpConfiguration } from "@/lib/server/remote-mcp-config";
import { readAuthorizedRoom, runSemanticTransaction } from "@/lib/server/room-service";

const MAX_GEOMETRY_BYTES = 256 * 1024;
const revisionSchema = z.number().int().nonnegative();
const imagePatchKeys = ["url", "assetId", "alt", "mimeType", "sourceUrl", "locked"];

const readCanvasInput = z.strictObject({
  roomId: remoteRoomIdSchema,
  expectedRoomRevision: revisionSchema.optional(),
  offset: z.number().int().min(0).max(5000).default(0),
  limit: z.number().int().min(1).max(20).default(20),
  includeGeometry: z.boolean().default(false),
});

const renderPreviewInput = targetedCanvasPngInputSchema.safeExtend({
  roomId: remoteRoomIdSchema,
});

const nativeEdit = z.discriminatedUnion("type", [
  canvasCommandSchema.options[0].strict(),
  canvasCommandSchema.options[1].omit({ leaseId: true }).extend({
    operation: z.enum(["move", "resize", "edit", "connect", "annotate"]),
  }).strict(),
]);

const applyEditsInput = z.strictObject({
  roomId: remoteRoomIdSchema,
  expectedRoomRevision: revisionSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  commands: z.array(nativeEdit).min(1).max(80),
});

function result(data: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
}

const toolErrorMessages = {
  FORBIDDEN: "This connection does not have the requested room access.",
  REVISION_CONFLICT: "The canvas revision changed. Read the current revision before making another edit.",
  OBJECT_NOT_FOUND: "An object in the edit no longer exists.",
  OBJECT_BUSY: "An active edit lease prevents this change.",
  IDEMPOTENCY_CONFLICT: "This idempotency key already names a different operation.",
  INVALID_OPERATION: "The requested canvas operation is not valid.",
  ROOM_CAPACITY_EXCEEDED: "The edit exceeds a room capacity limit.",
  REQUEST_TOO_LARGE: "The edit exceeds the supported request or activity size.",
  MUTATION_OUTCOME_UNKNOWN: "The edit outcome is uncertain. Read the current canvas before attempting another mutation.",
} as const;

export function remoteMcpToolError(error: unknown): CallToolResult {
  const original = isDomainError(error) ? error.code : "INTERNAL_ERROR";
  const code = original === "ROOM_NOT_FOUND" ? "FORBIDDEN" : original;
  const message = Object.hasOwn(toolErrorMessages, code)
    ? toolErrorMessages[code as keyof typeof toolErrorMessages]
    : "Jazzboard could not complete that request.";
  const details = isDomainError(error) && code === "MUTATION_OUTCOME_UNKNOWN" ? error.details : undefined;
  if (details && "replayed" in details && details.replayed === true
    && "committedRoomRevision" in details && typeof details.committedRoomRevision === "number") {
    return result({
      outcome: "already_committed",
      committedRoomRevision: details.committedRoomRevision,
      readCanvasBeforeContinuing: true,
    });
  }
  return result({ error: { code, message } }, true);
}

export async function readRemoteMcpRoom(auth: AuthInfo | undefined, roomId: string) {
  const grant = requireRemoteMcpGrant(auth, roomId, "read");
  return readAuthorizedRoom(roomId, grant.participantId);
}

function summarizeObject(object: CanvasObject) {
  const { id, kind, x, y, width, height, rotation, zIndex, groupId, revision, semanticName, semanticRole, diagramIds } = object;
  return { id, kind, x, y, width, height, rotation, zIndex, groupId, revision, semanticName, semanticRole, diagramIds };
}

function editableObject(object: CanvasObject): Record<string, unknown> {
  if (object.kind === "image") return { ...summarizeObject(object), mediaOmitted: true };
  const parsed = createCanvasObjectSchema.safeParse(object);
  return parsed.success
    ? { ...parsed.data, revision: object.revision, diagramIds: object.diagramIds }
    : { ...summarizeObject(object), geometryOmitted: true };
}

function checkRevision(actual: number, expected: number | undefined) {
  if (expected !== undefined && actual !== expected) {
    throw new DomainError("REVISION_CONFLICT", "The room changed.");
  }
}

export function registerRemoteMcpTools(server: McpServer, config: RemoteMcpConfiguration) {
  server.registerTool("read_canvas", {
    description: "Read an authorized existing Jazzboard canvas by exact room ID. Returns the current room revision, a bounded page of objects and their revisions. Use that revision when reading another page. Set includeGeometry to read native geometry. Private images are represented by bounds only.",
    inputSchema: readCanvasInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input, context) => {
    try {
      const room = await readRemoteMcpRoom(context.http?.authInfo, input.roomId);
      if (input.offset && input.expectedRoomRevision === undefined) {
        throw new DomainError("INVALID_OPERATION", "Follow-up pages require the first page's room revision.");
      }
      checkRevision(room.roomRevision, input.expectedRoomRevision);
      const ids = Object.keys(room.objects).sort();
      const objects: Record<string, unknown>[] = [];
      let bytes = 0;
      for (const id of ids.slice(input.offset, input.offset + input.limit)) {
        const object = room.objects[id];
        let projection = input.includeGeometry ? editableObject(object) : summarizeObject(object);
        let size = Buffer.byteLength(JSON.stringify(projection));
        if (size > MAX_GEOMETRY_BYTES) {
          projection = { ...summarizeObject(object), geometryOmitted: true };
          size = Buffer.byteLength(JSON.stringify(projection));
        }
        if (bytes + size > MAX_GEOMETRY_BYTES) break;
        objects.push(projection);
        bytes += size;
      }
      const next = input.offset + objects.length;
      return result({
        roomId: room.id,
        roomRevision: room.roomRevision,
        title: room.title,
        agentEditPolicy: room.agentEditPolicy,
        objects,
        nextOffset: next < ids.length ? next : null,
      });
    } catch (error) {
      return remoteMcpToolError(error);
    }
  });

  server.registerTool("render_canvas_preview", {
    description: "Render a targeted PNG for explicitly named objects or one group from an authorized room. Use exact object revisions for IDs or the room revision from read_canvas for a group. The response includes an image and cropped bounds. A selection containing an image asset is rejected.",
    inputSchema: renderPreviewInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ roomId, ...preview }, context) => {
    try {
      const room = await readRemoteMcpRoom(context.http?.authInfo, roomId);
      const { bytes, metadata } = await renderTargetedCanvasPng(room, preview);
      return {
        content: [
          { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
          { type: "text", text: JSON.stringify(metadata) },
        ],
      };
    } catch (error) {
      if (error instanceof TargetedCanvasPngError) {
        return result({
          error: {
            code: error.code,
            message: error.message,
          },
        }, true);
      }
      return remoteMcpToolError(error);
    }
  });

  server.registerTool("apply_canvas_edits", {
    description: "Apply one atomic batch of native create/update commands to an authorized existing room. Supply the exact room revision from read_canvas, exact object revisions for updates, and a fresh idempotency key per logical edit. Images and lease tokens are excluded. Rooms in review mode receive a proposal instead of an immediate edit.",
    inputSchema: applyEditsInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => {
    try {
      const grant = requireRemoteMcpGrant(context.http?.authInfo, input.roomId, "write");
      const room = await readAuthorizedRoom(grant.roomId, grant.participantId);
      requireMutationRole(requireParticipant(room, grant.participantId), "agent");
      // The native-kind check must also apply to the snapshot the transaction can commit.
      // Older revisions can only receive an idempotent receipt or a transaction conflict.
      if (input.expectedRoomRevision > room.roomRevision) {
        checkRevision(room.roomRevision, input.expectedRoomRevision);
      }
      for (const command of input.commands) {
        if (
          (command.type === "create" && command.object.kind === "image") ||
          (command.type === "update" && (
            room.objects[command.objectId]?.kind === "image" ||
            imagePatchKeys.some((key) => Object.hasOwn(command.patch, key))
          ))
        ) {
          throw new DomainError("INVALID_OPERATION", "This tool edits native objects only.");
        }
      }

      const key = sha256(JSON.stringify([grant.id, grant.roomId, input.idempotencyKey]));
      const request = new Request(config.resource, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      });
      const receipt = await runMutationRequest({
        request,
        participantId: grant.participantId,
        roomId: grant.roomId,
        operation: "room.remote-mcp.apply",
        actorKind: "agent",
        parsedBody: { expectedRoomRevision: input.expectedRoomRevision, commands: input.commands },
        execute: () => runSemanticTransaction({
          roomId: grant.roomId,
          participantId: grant.participantId,
          actorKind: "agent",
          transaction: { commands: input.commands, diagramCommands: [] },
          expectedRoomRevision: input.expectedRoomRevision,
        }),
      });
      return result(receipt.outcome === "proposed" ? {
        outcome: receipt.outcome,
        roomRevision: receipt.room.roomRevision,
        proposalId: receipt.proposal.id,
      } : {
        outcome: receipt.outcome,
        roomRevision: receipt.room.roomRevision,
        changedObjectIds: receipt.changedObjectIds,
      });
    } catch (error) {
      return remoteMcpToolError(error);
    }
  });
}

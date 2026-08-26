/// <reference types="webmcp-types" />

import { z } from "zod";

import { apiRequest, JazzboardApiError } from "@/lib/client/api";
import {
  persistDisplayName,
  readRecentRooms,
  removeRecentRoom,
  upsertRecentRoom,
} from "@/lib/client/recent-rooms";
import type { RecentRoom, RoomRole, RoomState } from "@/lib/domain/types";

import type {
  JazzboardToolFailure,
  JazzboardToolResult,
  WebMcpRequest,
} from "./types";
import type {
  JazzboardLandingWebMcpBinding,
  JazzboardLandingWebMcpDependencies,
} from "./landing-types";

const displayNameSchema = z.string().trim().min(1).max(48);
const titleSchema = z.string().trim().min(1).max(100);
const roomIdSchema = z.string().min(1).max(512);

const createRoomInputSchema = z
  .object({
    displayName: displayNameSchema,
    title: titleSchema.optional(),
  })
  .strict();

const joinRoomInputSchema = z
  .object({
    code: z.string().regex(/^\d{4}$/, "Room code must be exactly four digits."),
    displayName: displayNameSchema,
    role: z.enum(["participant", "spectator"]).optional(),
  })
  .strict();

const emptyInputSchema = z.object({}).strict();
const recentRoomInputSchema = z.object({ roomId: roomIdSchema }).strict();

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const ROOM_ID_JSON_SCHEMA = { type: "string", minLength: 1, maxLength: 512 } as const;

type RoomResponse = {
  ok: true;
  participantId: string;
  room: RoomState;
};

class LandingToolFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LandingToolFailure";
  }
}

function failure(tool: string, error: unknown): JazzboardToolFailure {
  if (error instanceof JazzboardApiError) {
    return { ok: false, tool, error: error.failure };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      tool,
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "The tool input does not match Jazzboard's room-lifecycle schema.",
        details: {
          issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      },
    };
  }
  if (error instanceof LandingToolFailure) {
    return {
      ok: false,
      tool,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      tool,
      error: { code: "TOOL_ABORTED", message: "The WebMCP tool call was cancelled." },
    };
  }
  return {
    ok: false,
    tool,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: error instanceof Error ? error.message : "Jazzboard could not execute this tool.",
    },
  };
}

function defineTool<TSchema extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  schema: TSchema;
  annotations?: WebMCP.ToolAnnotations;
  execute: (input: z.output<TSchema>, signal: AbortSignal) => Promise<unknown>;
}): WebMCP.ModelContextTool {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    annotations: input.annotations,
    async execute(rawInput, options): Promise<JazzboardToolResult> {
      try {
        const parsed = input.schema.parse(rawInput);
        // The current browser WebMCP implementation may invoke tools without
        // the draft callback-options argument. Keep cancellation when it is
        // supplied, while remaining compatible with that native runtime.
        const signal = options?.signal ?? new AbortController().signal;
        const data = await input.execute(parsed, signal);
        return { ok: true, tool: input.name, data };
      } catch (error) {
        return failure(input.name, error);
      }
    },
  };
}

function post<T>(request: WebMcpRequest, body: unknown, signal: AbortSignal): Promise<T> {
  return request<T>("/api/rooms", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

function roomPath(roomId: string): string {
  return `/room/${encodeURIComponent(roomId)}`;
}

function authorizedRoomPath(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}`;
}

function roomSummary(room: RoomState) {
  return { id: room.id, code: room.code, title: room.title };
}

function membershipRole(response: RoomResponse): RoomRole {
  const role = response.room.participants[response.participantId]?.role;
  if (role !== "participant" && role !== "spectator") {
    throw new LandingToolFailure(
      "ROOM_ACCESS_INVALID",
      "The authorized room response did not contain this browser session's membership.",
    );
  }
  return role;
}

export const JAZZBOARD_LANDING_WEBMCP_TOOL_NAMES = [
  "create_room",
  "join_room",
  "list_recent_rooms",
  "open_recent_room",
  "remove_recent_room",
] as const;

export function createJazzboardLandingWebMcpTools(
  binding: JazzboardLandingWebMcpBinding,
  dependencies: JazzboardLandingWebMcpDependencies = {},
): WebMCP.ModelContextTool[] {
  const request = dependencies.request ?? (apiRequest as WebMcpRequest);
  const storage = dependencies.storage === undefined
    ? (typeof window === "undefined" ? null : window.localStorage)
    : dependencies.storage;
  const now = dependencies.now ?? Date.now;

  function remember(response: RoomResponse, role: RoomRole) {
    const recentRoom: RecentRoom = {
      roomId: response.room.id,
      code: response.room.code,
      title: response.room.title,
      role,
      lastOpenedAt: now(),
    };
    const recent = upsertRecentRoom(recentRoom, storage);
    binding.context.acceptRecentRooms(recent.rooms);
    return { recentRoom, recentReferenceStored: recent.stored };
  }

  function enter(response: RoomResponse, role: RoomRole, displayName: string) {
    const recent = remember(response, role);
    const displayNameStored = persistDisplayName(displayName, storage);
    binding.context.navigateToRoom(response.room.id);
    return {
      room: roomSummary(response.room),
      role,
      path: roomPath(response.room.id),
      ...recent,
      displayNameStored,
    };
  }

  return [
    defineTool({
      name: "create_room",
      title: "Create a Jazzboard room",
      description:
        "Create a private Jazzboard room for this signed browser guest session, remember it only in this browser, and navigate into it as a participant. This does not publish the room to a directory.",
      inputSchema: {
        type: "object",
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 48 },
          title: { type: "string", minLength: 1, maxLength: 100 },
        },
        required: ["displayName"],
        additionalProperties: false,
      },
      schema: createRoomInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const response = await post<RoomResponse>(
          request,
          {
            action: "create",
            displayName: input.displayName,
            title: input.title ?? "Untitled Jazzboard",
          },
          signal,
        );
        signal.throwIfAborted();
        return enter(response, "participant", input.displayName);
      },
    }),
    defineTool({
      name: "join_room",
      title: "Join a Jazzboard by exact code",
      description:
        "Join only the private Jazzboard identified by the exact four-digit code supplied by the caller, remember that authorized room only in this browser, and navigate into it. This tool never searches or enumerates rooms.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", pattern: "^[0-9]{4}$" },
          displayName: { type: "string", minLength: 1, maxLength: 48 },
          role: { enum: ["participant", "spectator"] },
        },
        required: ["code", "displayName"],
        additionalProperties: false,
      },
      schema: joinRoomInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const role = input.role ?? "participant";
        const response = await post<RoomResponse>(
          request,
          { action: "join", code: input.code, displayName: input.displayName, role },
          signal,
        );
        signal.throwIfAborted();
        return enter(response, role, input.displayName);
      },
    }),
    defineTool({
      name: "list_recent_rooms",
      title: "List this browser's recent Jazzboards",
      description:
        "Read up to eight private recent-room references from this browser only after verifying that the current signed guest session is still a member of each exact room ID. This never invokes a room listing, search, or enumeration endpoint.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      schema: emptyInputSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(_input, signal) {
        const candidates = readRecentRooms(storage);
        const verified = await Promise.all(
          candidates.map(async (candidate): Promise<RecentRoom | null> => {
            try {
              const response = await request<RoomResponse>(authorizedRoomPath(candidate.roomId), {
                method: "GET",
                signal,
              });
              if (response.room.id !== candidate.roomId) return null;
              return {
                roomId: response.room.id,
                code: response.room.code,
                title: response.room.title,
                role: membershipRole(response),
                lastOpenedAt: candidate.lastOpenedAt,
              };
            } catch {
              // Fail closed: local storage is only a candidate set. A stale
              // entry must never disclose room metadata to a rotated or
              // otherwise unauthorized signed guest session.
              return null;
            }
          }),
        );
        signal.throwIfAborted();
        return {
          scope: "current_browser_and_signed_session",
          rooms: verified.filter((room): room is RecentRoom => room !== null),
        };
      },
    }),
    defineTool({
      name: "open_recent_room",
      title: "Open an authorized recent Jazzboard",
      description:
        "Open a room only when its exact room ID is already in this browser's private recent-room list. Jazzboard verifies this signed guest session still has server-side access before updating the local shortcut and navigating.",
      inputSchema: {
        type: "object",
        properties: { roomId: ROOM_ID_JSON_SCHEMA },
        required: ["roomId"],
        additionalProperties: false,
      },
      schema: recentRoomInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        const recentRoom = readRecentRooms(storage).find((room) => room.roomId === input.roomId);
        if (!recentRoom) {
          throw new LandingToolFailure(
            "RECENT_ROOM_NOT_FOUND",
            "That room is not in this browser's private recent-room list. Join it with the exact four-digit code instead.",
            { roomId: input.roomId },
          );
        }

        const response = await request<RoomResponse>(authorizedRoomPath(input.roomId), {
          method: "GET",
          signal,
        });
        signal.throwIfAborted();
        const role = membershipRole(response);
        const remembered = remember(response, role);
        binding.context.navigateToRoom(response.room.id);
        return {
          room: roomSummary(response.room),
          role,
          path: roomPath(response.room.id),
          authorizationVerified: true,
          ...remembered,
        };
      },
    }),
    defineTool({
      name: "remove_recent_room",
      title: "Remove a local recent-room shortcut",
      description:
        "Remove a room reference only from this browser's private recent-room list. This never leaves, deletes, modifies, or searches the shared server room.",
      inputSchema: {
        type: "object",
        properties: { roomId: ROOM_ID_JSON_SCHEMA },
        required: ["roomId"],
        additionalProperties: false,
      },
      schema: recentRoomInputSchema,
      annotations: { untrustedContentHint: true },
      async execute(input, signal) {
        signal.throwIfAborted();
        const recent = removeRecentRoom(input.roomId, storage);
        if (!recent.removed) {
          throw new LandingToolFailure(
            "RECENT_ROOM_NOT_FOUND",
            "That room is not in this browser's private recent-room list.",
            { roomId: input.roomId },
          );
        }
        binding.context.acceptRecentRooms(recent.rooms);
        return {
          removedRoom: recent.removed,
          localReferenceRemoved: recent.stored,
          sharedRoomDeleted: false,
          remainingCount: recent.rooms.length,
        };
      },
    }),
  ];
}

/// <reference types="webmcp-types" />

import type { ApiFailure } from "@/lib/client/api";
import type { FollowTarget, RoomRole, RoomState, Viewport } from "@/lib/domain/types";

import type {
  CanvasPreviewArtifact,
  CanvasPreviewPresenter,
  CanvasPreviewRenderRequest,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";

/** The narrow bridge the room UI supplies to the WebMCP client layer. */
export interface JazzboardWebMcpContext {
  getRoom(): RoomState | null;
  getSelection(): readonly string[];
  getViewport(): Viewport | null;
  getFollowTarget(): FollowTarget;
  renderCanvasPreview?(
    request: CanvasPreviewRenderRequest,
    signal: AbortSignal,
  ): Promise<CanvasPreviewArtifact>;
  presentCanvasPreview?: CanvasPreviewPresenter;
  saveCanvasPng?(
    artifact: CanvasPreviewArtifact,
    filename: string,
    signal: AbortSignal,
  ): Promise<void>;
  acceptRoom(room: RoomState): void;
  setFollowTarget(target: FollowTarget): void;
  setDeclinedSpotlight(startedAt: number | null): void;
  leaveRoomView(): void;
}

export type JazzboardWebMcpBinding = {
  roomId: string;
  participantId: string;
  role: RoomRole;
  context: JazzboardWebMcpContext;
};

export type WebMcpRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export type JazzboardToolSuccess<T = unknown> = {
  ok: true;
  tool: string;
  data: T;
};

export type JazzboardToolFailure = {
  ok: false;
  tool: string;
  error: ApiFailure;
};

export type JazzboardToolResult<T = unknown> = JazzboardToolSuccess<T> | JazzboardToolFailure;

export type JazzboardWebMcpDependencies = {
  request?: WebMcpRequest;
  createId?: (prefix: string) => string;
  canvasPreviewTransport?: CanvasPreviewTransportAdapter;
};

export type JazzboardWebMcpRegistrationStatus = {
  supported: boolean;
  roomId: string | null;
  role: RoomRole | null;
  registeredToolNames: string[];
};

export type ModelContextProvider = () => WebMCP.ModelContext | undefined;

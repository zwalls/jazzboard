/// <reference types="webmcp-types" />

import type { ApiFailure } from "@/lib/client/api";
import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import type { AgentDraftPresentationStatus } from "@/lib/canvas/agent-draft-reveal";
import type {
  GuidedWalkthrough,
  GuidedWalkthroughDisplay,
} from "@/lib/canvas/guided-walkthrough";
import type { CanvasRuntime } from "@/lib/canvas/runtime";
import type { FollowTarget, RoomRole, RoomState, Viewport } from "@/lib/domain/types";

import type {
  CanvasPreviewArtifact,
  CanvasInspectionArtifact,
  CanvasPreviewPresenter,
  CanvasPreviewRenderRequest,
  CanvasPreviewTransportAdapter,
} from "./canvas-preview";
import type { WebMcpToolActivityRelease } from "./tool-activity";

/** The narrow bridge the room UI supplies to the WebMCP client layer. */
export interface JazzboardWebMcpContext {
  getRoom(): RoomState | null;
  getSelection(): readonly string[];
  getViewport(): Viewport | null;
  /** Current renderer bridge for reversible, local-only camera operations. */
  getCanvasRuntime?(): CanvasRuntime | null;
  getFollowTarget(): FollowTarget;
  getGuidedWalkthrough?(): GuidedWalkthrough | null;
  getGuidedWalkthroughDisplay?(): GuidedWalkthroughDisplay | null;
  /** Begins a real, browser-local registered tool execution indicator. */
  beginWebMcpToolActivity?(toolName: string): WebMcpToolActivityRelease;
  presentGuidedWalkthrough?(walkthrough: GuidedWalkthrough): void;
  stopGuidedWalkthrough?(walkthroughId?: string): void;
  waitForGuidedWalkthroughDisplay?(
    walkthroughId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  renderCanvasPreview?(
    request: CanvasPreviewRenderRequest,
    signal: AbortSignal,
  ): Promise<CanvasPreviewArtifact>;
  inspectCanvasScope?(
    request: CanvasPreviewRenderRequest,
    signal: AbortSignal,
  ): Promise<CanvasInspectionArtifact>;
  presentCanvasPreview?: CanvasPreviewPresenter;
  saveCanvasPng?(
    artifact: CanvasPreviewArtifact,
    filename: string,
    signal: AbortSignal,
  ): Promise<void>;
  acceptRoom(room: RoomState): void;
  acceptAgentDraft?(draft: AgentCanvasDraftSnapshot): void;
  removeAgentDraft?(draftId: string, revision?: number): void;
  retireCommittedAgentDraft?(
    draftId: string,
    draftRevision: number,
    authoritativeRoomRevision: number,
  ): void;
  getAgentDraftPresentation?(draftId: string, revision: number): AgentDraftPresentationStatus;
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
  waitForDraftPresentation?: (
    draftId: string,
    revision: number,
    signal: AbortSignal,
  ) => Promise<AgentDraftPresentationStatus>;
};

export type JazzboardWebMcpRegistrationStatus = {
  supported: boolean;
  roomId: string | null;
  role: RoomRole | null;
  registeredToolNames: string[];
};

export type ModelContextProvider = () => WebMCP.ModelContext | undefined;

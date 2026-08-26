/// <reference types="webmcp-types" />

import type { BrowserStorage } from "@/lib/client/recent-rooms";
import type { RecentRoom } from "@/lib/domain/types";

import type { WebMcpRequest } from "./types";

/** The UI-only bridge used by landing tools after an authorized operation. */
export interface JazzboardLandingWebMcpContext {
  acceptRecentRooms(rooms: RecentRoom[]): void;
  navigateToRoom(roomId: string): void;
}

export type JazzboardLandingWebMcpBinding = {
  context: JazzboardLandingWebMcpContext;
};

export type JazzboardLandingWebMcpDependencies = {
  request?: WebMcpRequest;
  storage?: BrowserStorage | null;
  now?: () => number;
};

export type JazzboardLandingWebMcpRegistrationStatus = {
  supported: boolean;
  registeredToolNames: string[];
};

export type LandingModelContextProvider = () => WebMCP.ModelContext | undefined;

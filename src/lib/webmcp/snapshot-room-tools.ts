/// <reference types="webmcp-types" />

import type { JazzboardWebMcpBinding, JazzboardWebMcpDependencies } from "./types";

/**
 * Hosted snapshot lifecycle tools are retired. Keep an empty compatibility
 * surface so generated agent-readiness content and external imports cannot
 * accidentally reintroduce the former tools.
 */
export const JAZZBOARD_SNAPSHOT_ROOM_TOOL_NAMES = [] as const;

export function createJazzboardSnapshotRoomWebMcpTools(
  binding: JazzboardWebMcpBinding,
  dependencies?: JazzboardWebMcpDependencies,
): WebMCP.ModelContextTool[] {
  void binding;
  void dependencies;
  return [];
}

import type { ApiFailure } from "@/lib/client/api";

import type { JazzboardToolFailure } from "./types";

type Recovery = NonNullable<ApiFailure["recovery"]>;

function canvasReadTools(tool: string): string[] {
  if (["create_room", "join_room", "open_recent_room", "list_recent_rooms"].includes(tool)) {
    return ["list_recent_rooms"];
  }
  if (tool.includes("draft") || tool === "apply_canvas_transaction") return ["read_canvas_drafts"];
  if (tool.includes("diagram")) return ["read_diagram", "find_diagrams"];
  if (tool.includes("message")) return ["list_agent_messages"];
  if (tool.includes("snapshot")) return [];
  return ["query_objects", "read_room_state"];
}

function recoveryFor(tool: string, failure: ApiFailure): Recovery {
  const commonCanvasTools = canvasReadTools(tool);
  switch (failure.code) {
    case "INVALID_TOOL_INPUT":
    case "INVALID_REQUEST":
      return {
        retry: "after_correction",
        instructions:
          tool === "apply_canvas_transaction"
            ? "Inspect every error.details path and the registered input schema, preserve the requested semantic structure, then correct every issue and retry once. Never recover by deleting a requested Diagram or its membership. A new Diagram uses exactly {op:'create_diagram',tempRef,title,description?,diagramType?,category?,tags?,members?,connectors?}; it has no x/y/width/height, semanticName, semanticRole, or diagramTempRef. diagramTempRef is only for {op:'edit_diagram',diagramTempRef,...} in an exact draft patch and never belongs on object-create operations. For a direct existing-object correction, use operations=[{op:'update_object',objectId,expectedRevision,patch:{...}}]; do not use update_node, changes, or a root expectedRoomRevision. The failed call changed no Jazzboard state."
            : "Inspect error.details and this tool's registered input schema. Correct every reported issue path or invalid field, then retry the corrected call once. The failed call changed no Jazzboard state.",
        suggestedTools: tool === "get_canvas_capabilities" ? [] : ["get_canvas_capabilities"],
      };
    case "DRAFT_REVISION_CONFLICT":
      return {
        retry: "after_refresh",
        instructions:
          "Call read_canvas_drafts for this draft, preserve the latest complete cumulative candidate, then replace or finish using the returned exact draftId and draftRevision. Do not reuse the stale revision.",
        suggestedTools: ["read_canvas_drafts", "finish_canvas_draft"],
      };
    case "INVALID_DRAFT_ID":
      return {
        retry: "after_correction",
        instructions:
          "Use the exact draftId returned by apply_canvas_transaction or read_canvas_drafts. Never invent, truncate, or transform a draft identifier.",
        suggestedTools: ["read_canvas_drafts"],
      };
    case "DUPLICATE_TEMP_REF":
    case "TEMP_REF_ID_CONFLICT":
      return {
        retry: "after_correction",
        instructions:
          "Repair the named temporary-reference collision, preserve one stable tempRef per intended object, and resubmit the complete atomic request. The rejected transaction changed no Jazzboard state.",
        suggestedTools: ["get_canvas_capabilities"],
      };
    case "DUPLICATE_SEMANTIC_ID":
      return {
        retry: "after_refresh",
        instructions:
          "Query the reported semantic ID. Update the existing entity with its exact revision when it is the intended target; otherwise choose a fresh stable ID and retry the complete transaction.",
        suggestedTools: ["query_objects", "find_diagrams"],
      };
    case "RELATIONSHIP_ASSERTION_FAILED":
      return {
        retry: "after_correction",
        instructions:
          "Read error.details.violations and correct each named connector operation or its caller-authored assertion so fromTempRef is the actual start, toTempRef is the actual end, direction matches, and exactLabel matches when supplied. Preserve the requested facts and retry the complete call once. Jazzboard inferred no relationship and the rejected call changed no state.",
        suggestedTools: ["get_canvas_capabilities"],
      };
    case "OBJECT_BUSY":
      return {
        retry: "after_wait",
        instructions:
          "Do not steal or bypass the active-object lease. Read collaboration state, wait until the reported lease expires or disappears, then re-read the affected objects and retry with their current exact revisions.",
        suggestedTools: ["read_collaboration_state", ...commonCanvasTools],
      };
    case "REVISION_CONFLICT":
    case "OBJECT_REVISION_CONFLICT":
    case "ROOM_REVISION_CONFLICT":
    case "DIAGRAM_REVISION_CONFLICT":
      return tool.includes("draft") || tool === "apply_canvas_transaction"
        ? {
            retry: "after_refresh",
            instructions:
              "Read the owned draft and current room. If only the draft revision changed, preserve the latest complete cumulative candidate and use its exact revision. If the baseline room changed, the draft cannot be rebased in place: intentionally discard or reconcile it, then restage the complete cumulative candidate against current authoritative state. Never retry the stale baseline.",
            suggestedTools: ["read_canvas_drafts", "read_room_state", "finish_canvas_draft"],
          }
        : {
            retry: "after_refresh",
            instructions:
              "Re-read only the affected object, Diagram, or room, rebuild the request with current exact revisions, reconsider whether the original intent still applies, and retry only the corrected request.",
            suggestedTools: commonCanvasTools,
          };
    case "MUTATION_OUTCOME_UNKNOWN":
    case "TOOL_EXECUTION_FAILED":
      return {
        retry: "verify_before_retry",
        instructions:
          tool === "finish_canvas_draft"
            ? "The commit may have applied or may remain indeterminate. Read the exact owned draft status, authoritative room state, and attributable activity. If the draft remains committing without authoritative evidence, report the indeterminate outcome and do not replay with a new mutation identity."
            : tool === "apply_canvas_transaction"
              ? "The stage or mutation may have succeeded. First read owned drafts, then query the requested semantic names/tempRefs, authoritative room state, and attributable activity. Recover the returned draft/IDs when present and never blindly replay the request."
              : "The operation may have succeeded. Use the surface-appropriate read tools to verify authoritative state before deciding whether a retry is necessary. Never blindly replay the request.",
        suggestedTools: tool === "finish_canvas_draft" || tool === "apply_canvas_transaction"
          ? ["read_canvas_drafts", "query_objects", "list_activity", "read_room_state"]
          : commonCanvasTools,
      };
    case "AUTH_REQUIRED":
    case "INVALID_GUEST_BOOTSTRAP":
      return {
        retry: "after_refresh",
        instructions:
          "Return to Jazzboard's landing surface, join or create the exact authorized room through its registered lifecycle tool, then rediscover the page-scoped WebMCP tools. Do not use direct APIs or guessed session data.",
        suggestedTools: ["join_room", "create_room"],
      };
    case "FORBIDDEN":
      return {
        retry: "do_not_retry",
        instructions:
          "This signed session or role is not authorized for the operation. Rediscover the role-scoped tool registry and stop; do not bypass permissions, automate hidden UI, or attempt role escalation. A human must grant any required participant role.",
      };
    case "ROOM_NOT_FOUND":
    case "ROOM_ACCESS_INVALID":
      return {
        retry: "do_not_retry",
        instructions:
          "Ask for or reuse the exact private room code or already-authorized recent-room reference. Do not enumerate, search for, or guess rooms.",
        suggestedTools: ["join_room", "list_recent_rooms"],
      };
    case "RECENT_ROOM_NOT_FOUND":
      return {
        retry: "after_refresh",
        instructions:
          "Re-list this browser's private recent rooms and use one exact returned reference, or ask for the exact room code. Do not guess or enumerate rooms.",
        suggestedTools: ["list_recent_rooms", "join_room"],
      };
    case "OBJECT_NOT_FOUND":
    case "DIAGRAM_NOT_FOUND":
      return {
        retry: "after_refresh",
        instructions:
          "Find the intended entity by semantic identity, use the returned stable ID and exact revision, and retry only if it still exists and matches the requested intent.",
        suggestedTools: ["query_objects", "find_diagrams"],
      };
    case "REQUEST_TOO_LARGE":
      return {
        retry: "after_correction",
        instructions:
          "Reduce nonessential detail or divide the work into bounded coherent semantic stages below the reported limit. Preserve stable IDs and relationships; do not raise or evade safety limits.",
        suggestedTools: ["get_canvas_capabilities"],
      };
    case "ROOM_CAPACITY_EXCEEDED":
    case "ASSET_CAPACITY_EXCEEDED":
      return {
        retry: "do_not_retry",
        instructions:
          "The authorized room has reached a server limit. Report the exact limit and ask the user whether to simplify the artifact or continue in a new room; do not discard existing work automatically.",
      };
    case "CLIENT_UPGRADE_REQUIRED":
      return {
        retry: "after_refresh",
        instructions:
          "Reload the current Jazzboard page and rediscover its WebMCP registry before retrying with the current client contract.",
      };
    case "LEASE_NOT_FOUND":
      return {
        retry: "after_refresh",
        instructions:
          "The prior lease is no longer valid. Re-read collaboration and authoritative object state, then begin a fresh revision-checked edit instead of reusing the expired lease.",
        suggestedTools: ["read_collaboration_state", ...commonCanvasTools],
      };
    case "TOOL_ABORTED":
      return {
        retry: "verify_before_retry",
        instructions:
          "Confirm the task is still requested and inspect authoritative state before retrying, because cancellation may have occurred after a mutation was accepted.",
        suggestedTools: commonCanvasTools,
      };
    case "MESSAGE_CLAIM_EXPIRED":
    case "MESSAGE_CLAIM_REQUIRED":
      return {
        retry: "after_refresh",
        instructions:
          "Re-list pending messages and acquire a fresh claim before replying. Never reuse an expired or missing claim token.",
        suggestedTools: ["list_agent_messages", "claim_agent_message"],
      };
    case "MESSAGE_ALREADY_CLAIMED":
      return {
        retry: "after_wait",
        instructions:
          "Re-list the inbox. Do not take over the active claim. If a prior response was lost and no claim token is recoverable, wait until the reported claim expires, then re-list and claim the pending message again.",
        suggestedTools: ["list_agent_messages"],
      };
    case "MESSAGE_ALREADY_ANSWERED":
      return {
        retry: "do_not_retry",
        instructions:
          "Re-list the inbox and continue with another pending message. Do not send a duplicate reply.",
        suggestedTools: ["list_agent_messages"],
      };
    case "IDEMPOTENCY_CONFLICT":
    case "INVALID_IDEMPOTENCY_KEY":
      return {
        retry: "verify_before_retry",
        instructions:
          "Inspect authoritative state before retrying. If a new attempt is still necessary, issue one corrected call and let Jazzboard create a fresh idempotency identity.",
        suggestedTools: commonCanvasTools,
      };
    case "INVALID_OPERATION":
    default:
      return {
        retry: "after_correction",
        instructions:
          "Use the structured code, message, and details to correct the request. Consult the relevant registered capability bundle, preserve the user's intent, and do not repeat an unchanged rejected call.",
        suggestedTools: tool === "get_canvas_capabilities" ? [] : ["get_canvas_capabilities"],
      };
  }
}

/** Adds a machine-readable correction path to every WebMCP rejection. */
export function withActionableRecovery(failure: JazzboardToolFailure): JazzboardToolFailure {
  if (failure.error.recovery) return failure;
  return {
    ...failure,
    error: {
      ...failure.error,
      recovery: recoveryFor(failure.tool, failure.error),
    },
  };
}

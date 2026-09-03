import { describe, expect, it } from "vitest";

import { withActionableRecovery } from "./actionable-failure";

function failure(tool: string, code: string, message = "Rejected.") {
  return withActionableRecovery({ ok: false, tool, error: { code, message } });
}

describe("actionable WebMCP failures", () => {
  it("turns schema rejection into a correct-and-retry contract", () => {
    expect(failure("apply_canvas_transaction", "INVALID_TOOL_INPUT")).toMatchObject({
      error: {
        recovery: {
          retry: "after_correction",
          suggestedTools: ["get_canvas_capabilities"],
          instructions: expect.stringMatching(/error\.details.*preserve the requested semantic structure.*never recover by deleting a requested Diagram.*create_diagram.*members.*connectors.*no x\/y\/width\/height.*diagramTempRef is only for.*edit_diagram.*never belongs on object-create operations.*update_object.*expectedRevision.*patch.*do not use update_node.*failed call changed no Jazzboard state/i),
        },
      },
    });
  });

  it("protects active leases and ambiguous mutations from blind replay", () => {
    expect(failure("update_object", "OBJECT_BUSY")).toMatchObject({
      error: {
        recovery: {
          retry: "after_wait",
          suggestedTools: expect.arrayContaining(["read_collaboration_state"]),
          instructions: expect.stringMatching(/do not steal.*lease.*current exact revisions/i),
        },
      },
    });
    expect(failure("apply_canvas_transaction", "MUTATION_OUTCOME_UNKNOWN")).toMatchObject({
      error: {
        recovery: {
          retry: "verify_before_retry",
          instructions: expect.stringMatching(/may have succeeded.*never blindly replay/i),
        },
      },
    });
  });

  it("gives exact draft-revision recovery without bypassing progressive delivery", () => {
    expect(failure("apply_canvas_transaction", "DRAFT_REVISION_CONFLICT")).toMatchObject({
      error: {
        recovery: {
          retry: "after_refresh",
          suggestedTools: ["read_canvas_drafts", "finish_canvas_draft"],
          instructions: expect.stringMatching(/complete cumulative candidate.*exact draftId and draftRevision/i),
        },
      },
    });
  });

  it("turns a relationship assertion mismatch into one fact-preserving correction", () => {
    expect(failure("apply_canvas_transaction", "RELATIONSHIP_ASSERTION_FAILED")).toMatchObject({
      error: {
        recovery: {
          retry: "after_correction",
          suggestedTools: ["get_canvas_capabilities"],
          instructions: expect.stringMatching(
            /error\.details\.violations.*fromTempRef.*actual start.*toTempRef.*actual end.*preserve the requested facts.*changed no state/i,
          ),
        },
      },
    });
  });

  it("stops permission bypass and room enumeration", () => {
    expect(failure("update_object", "FORBIDDEN")).toMatchObject({
      error: {
        recovery: {
          retry: "do_not_retry",
          instructions: expect.stringMatching(/do not bypass permissions.*role escalation/i),
        },
      },
    });
    expect(failure("join_room", "ROOM_NOT_FOUND")).toMatchObject({
      error: {
        recovery: {
          retry: "do_not_retry",
          instructions: expect.stringMatching(/exact private room code.*do not enumerate/i),
        },
      },
    });
  });

  it("preserves a more specific server-provided recovery contract", () => {
    const result = withActionableRecovery({
      ok: false,
      tool: "custom",
      error: {
        code: "CUSTOM",
        message: "No.",
        recovery: {
          retry: "do_not_retry",
          instructions: "Use the exact server-specific correction.",
        },
      },
    });
    expect(result.error.recovery?.instructions).toBe("Use the exact server-specific correction.");
  });
});

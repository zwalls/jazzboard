import { describe, expect, it } from "vitest";

import {
  assessAuthorEnvironment,
  assessEvaluatorSeparation,
  authorizeAuthorAction,
  scanForCanaries,
  type AuthorEnvironmentAttestation,
  type CleanRoomPolicy,
  type ScopedPixelFence,
} from "./clean-room";

const policy: CleanRoomPolicy = {
  schemaVersion: 1,
  policyId: "policy_dev_v1",
  authorizedRoomUrl: "https://eval.jazzboard.invalid/room/room_123",
  expectedRoomId: "room_123",
  expectedToolNames: ["read_room_state", "inspect_canvas_scope", "transact_canvas"],
  expectedToolDescriptorDigest: "sha256:tools-v1",
  allowedNetworkOrigins: ["https://eval.jazzboard.invalid", "https://assets.jazzboard.invalid"],
  maximumWaitMs: 30_000,
};

const cleanAttestation: AuthorEnvironmentAttestation = {
  schemaVersion: 1,
  attemptId: "attempt_001",
  productCommit: "48a52e0",
  productBuildDigest: "sha256:build",
  runnerDigest: "sha256:runner",
  modelSessionId: "model_session_1",
  browserProfileId: "browser_profile_1",
  guestSessionId: "guest_session_1",
  freshModelContext: true,
  freshBrowserProfile: true,
  freshGuestSession: true,
  emptyWorkingDirectory: true,
  sharedTemporaryStorage: false,
  exposedSurfaces: [],
  observedNetworkOrigins: ["https://eval.jazzboard.invalid", "https://assets.jazzboard.invalid"],
  observedToolNames: ["inspect_canvas_scope", "read_room_state", "transact_canvas"],
  observedToolDescriptorDigest: "sha256:tools-v1",
};

describe("clean-room author policy", () => {
  it("accepts a fresh author environment with the exact frozen tool surface", () => {
    expect(assessAuthorEnvironment(policy, cleanAttestation)).toEqual({
      schemaVersion: 1,
      status: "pass",
      violations: [],
    });
  });

  it("reports every isolation and capability violation without hiding later failures", () => {
    const result = assessAuthorEnvironment(policy, {
      ...cleanAttestation,
      freshModelContext: false,
      freshBrowserProfile: false,
      freshGuestSession: false,
      emptyWorkingDirectory: false,
      sharedTemporaryStorage: true,
      exposedSurfaces: ["repository", "shell", "raw_network"],
      observedNetworkOrigins: ["https://eval.jazzboard.invalid", "https://example.com"],
      observedToolNames: ["read_room_state", "private_mutate"],
      observedToolDescriptorDigest: "sha256:drifted",
    });

    expect(result.status).toBe("policy_violation");
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "AUTHOR_CONTEXT_REUSED",
      "BROWSER_PROFILE_REUSED",
      "GUEST_SESSION_REUSED",
      "WORKING_DIRECTORY_NOT_EMPTY",
      "CROSS_ATTEMPT_STORAGE_EXPOSED",
      "FORBIDDEN_SURFACE_EXPOSED",
      "NETWORK_EGRESS_OUTSIDE_ALLOWLIST",
      "TOOL_INVENTORY_DRIFT",
      "TOOL_DESCRIPTOR_DRIFT",
    ]);
  });

  it("allows only the exact room, frozen WebMCP inventory, and bounded waiting", () => {
    expect(authorizeAuthorAction(policy, {
      kind: "navigate",
      url: "https://eval.jazzboard.invalid/room/room_123/",
    }).allowed).toBe(true);
    expect(authorizeAuthorAction(policy, {
      kind: "webmcp.call",
      pageUrl: policy.authorizedRoomUrl,
      toolName: "transact_canvas",
    }).allowed).toBe(true);
    expect(authorizeAuthorAction(policy, { kind: "wait", durationMs: 30_000 }).allowed).toBe(true);

    expect(authorizeAuthorAction(policy, {
      kind: "navigate",
      url: "https://eval.jazzboard.invalid/room/room_456",
    }).reasonCode).toBe("OUTSIDE_AUTHORIZED_ROOM");
    expect(authorizeAuthorAction(policy, {
      kind: "webmcp.call",
      pageUrl: policy.authorizedRoomUrl,
      toolName: "private_api_mutate",
    }).reasonCode).toBe("UNKNOWN_WEBMCP_TOOL");
    expect(authorizeAuthorAction(policy, { kind: "wait", durationMs: 30_001 }).reasonCode).toBe("INVALID_WAIT");
    expect(authorizeAuthorAction(policy, { kind: "forbidden", surface: "page_evaluate" }).reasonCode)
      .toBe("FORBIDDEN_SURFACE");
  });

  it("delivers pixels only through an exact unexpired revision and scope fence", () => {
    const fence: ScopedPixelFence = {
      inspectionId: "inspection_1",
      roomId: "room_123",
      roomRevision: 7,
      scopeDigest: "sha256:scope",
      expiresAt: 20_000,
    };
    const fences = new Map([[fence.inspectionId, fence]]);

    expect(authorizeAuthorAction(policy, {
      kind: "pixels.receive",
      fence,
      now: 19_999,
    }, fences).allowed).toBe(true);
    expect(authorizeAuthorAction(policy, {
      kind: "pixels.receive",
      fence: { ...fence, roomRevision: 8 },
      now: 19_999,
    }, fences).reasonCode).toBe("ARBITRARY_PIXEL_ACCESS_DENIED");
    expect(authorizeAuthorAction(policy, {
      kind: "pixels.receive",
      fence,
      now: 20_001,
    }, fences).reasonCode).toBe("STALE_PIXEL_FENCE");
  });
});

describe("clean-room evaluator separation", () => {
  it("requires author termination, sealed evidence, a spectator, and separate identities", () => {
    expect(assessEvaluatorSeparation({
      authorSessionId: "author_1",
      evaluatorSessionId: "evaluator_1",
      authorFinishedAt: 100,
      artifactSealedAt: 110,
      evaluatorStartedAt: 120,
      evaluatorRole: "spectator",
      evaluatorMutationToolNames: [],
      evaluatorCanMessageAuthor: false,
      sharedWritableStorage: false,
      sealedArtifactRootBeforeEvaluation: "sha256:root",
      artifactRootObservedByEvaluator: "sha256:root",
    })).toEqual({ status: "pass", violations: [] });
  });

  it("fails closed when the evaluator can influence the author or evidence", () => {
    const result = assessEvaluatorSeparation({
      authorSessionId: "shared",
      evaluatorSessionId: "shared",
      authorFinishedAt: 120,
      artifactSealedAt: 110,
      evaluatorStartedAt: 100,
      evaluatorRole: "participant",
      evaluatorMutationToolNames: ["transact_canvas"],
      evaluatorCanMessageAuthor: true,
      sharedWritableStorage: true,
      sealedArtifactRootBeforeEvaluation: "sha256:before",
      artifactRootObservedByEvaluator: "sha256:after",
    });

    expect(result.status).toBe("policy_violation");
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "SESSION_IDENTITY_REUSED",
      "EVALUATOR_STARTED_BEFORE_SEAL",
      "EVALUATOR_NOT_SPECTATOR",
      "EVALUATOR_HAS_MUTATION_TOOLS",
      "EVALUATOR_CAN_MESSAGE_AUTHOR",
      "WRITABLE_STORAGE_SHARED",
      "ARTIFACT_CHANGED_AFTER_SEAL",
    ]);
  });

  it("detects inaccessible benchmark canaries in authored output", () => {
    expect(scanForCanaries("A normal artifact", [{ id: "vault", token: "HONEY-42" }])).toEqual({
      status: "pass",
      matchedCanaryIds: [],
    });
    expect(scanForCanaries("The hidden answer is HONEY-42", [{ id: "vault", token: "HONEY-42" }])).toEqual({
      status: "policy_violation",
      matchedCanaryIds: ["vault"],
    });
  });
});

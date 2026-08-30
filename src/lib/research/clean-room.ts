export const CLEAN_ROOM_SCHEMA_VERSION = 1 as const;

export const CLEAN_ROOM_FORBIDDEN_SURFACES = [
  "repository",
  "shell",
  "filesystem",
  "raw_network",
  "private_api",
  "page_evaluate",
  "devtools",
  "dom_mutation",
  "ui_canvas_edit",
  "clipboard",
  "cross_attempt_storage",
  "evaluator_messaging",
] as const;

export type CleanRoomForbiddenSurface = typeof CLEAN_ROOM_FORBIDDEN_SURFACES[number];

export type CleanRoomPolicy = {
  schemaVersion: typeof CLEAN_ROOM_SCHEMA_VERSION;
  policyId: string;
  authorizedRoomUrl: string;
  expectedRoomId: string;
  expectedToolNames: string[];
  expectedToolDescriptorDigest: string;
  allowedNetworkOrigins: string[];
  maximumWaitMs: number;
};

export type AuthorEnvironmentAttestation = {
  schemaVersion: typeof CLEAN_ROOM_SCHEMA_VERSION;
  attemptId: string;
  productCommit: string;
  productBuildDigest: string;
  runnerDigest: string;
  modelSessionId: string;
  browserProfileId: string;
  guestSessionId: string;
  freshModelContext: boolean;
  freshBrowserProfile: boolean;
  freshGuestSession: boolean;
  emptyWorkingDirectory: boolean;
  sharedTemporaryStorage: boolean;
  exposedSurfaces: CleanRoomForbiddenSurface[];
  observedNetworkOrigins: string[];
  observedToolNames: string[];
  observedToolDescriptorDigest: string;
};

export type CleanRoomViolationCode =
  | "AUTHOR_CONTEXT_REUSED"
  | "BROWSER_PROFILE_REUSED"
  | "CROSS_ATTEMPT_STORAGE_EXPOSED"
  | "FORBIDDEN_SURFACE_EXPOSED"
  | "GUEST_SESSION_REUSED"
  | "NETWORK_EGRESS_OUTSIDE_ALLOWLIST"
  | "TOOL_DESCRIPTOR_DRIFT"
  | "TOOL_INVENTORY_DRIFT"
  | "WORKING_DIRECTORY_NOT_EMPTY";

export type CleanRoomViolation = {
  code: CleanRoomViolationCode;
  summary: string;
  details?: string[];
};

export type CleanRoomAssessment = {
  schemaVersion: typeof CLEAN_ROOM_SCHEMA_VERSION;
  status: "pass" | "policy_violation";
  violations: CleanRoomViolation[];
};

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function differentValues(expected: readonly string[], observed: readonly string[]): string[] {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  return normalizedUnique([
    ...expected.filter((value) => !observedSet.has(value)).map((value) => `missing:${value}`),
    ...observed.filter((value) => !expectedSet.has(value)).map((value) => `unexpected:${value}`),
  ]);
}

export function assessAuthorEnvironment(
  policy: CleanRoomPolicy,
  attestation: AuthorEnvironmentAttestation,
): CleanRoomAssessment {
  const violations: CleanRoomViolation[] = [];

  if (!attestation.freshModelContext) {
    violations.push({ code: "AUTHOR_CONTEXT_REUSED", summary: "The author did not start from a fresh model context." });
  }
  if (!attestation.freshBrowserProfile) {
    violations.push({ code: "BROWSER_PROFILE_REUSED", summary: "The author reused a browser profile." });
  }
  if (!attestation.freshGuestSession) {
    violations.push({ code: "GUEST_SESSION_REUSED", summary: "The author reused a Jazzboard guest session." });
  }
  if (!attestation.emptyWorkingDirectory) {
    violations.push({ code: "WORKING_DIRECTORY_NOT_EMPTY", summary: "The author sandbox working directory was not empty." });
  }
  if (attestation.sharedTemporaryStorage) {
    violations.push({
      code: "CROSS_ATTEMPT_STORAGE_EXPOSED",
      summary: "The author could read temporary storage shared with another attempt or evaluator.",
    });
  }
  if (attestation.exposedSurfaces.length > 0) {
    violations.push({
      code: "FORBIDDEN_SURFACE_EXPOSED",
      summary: "The author environment exposed capabilities outside the clean-room contract.",
      details: normalizedUnique(attestation.exposedSurfaces),
    });
  }

  const allowedOrigins = new Set(policy.allowedNetworkOrigins);
  const disallowedOrigins = normalizedUnique(
    attestation.observedNetworkOrigins.filter((origin) => !allowedOrigins.has(origin)),
  );
  if (disallowedOrigins.length > 0) {
    violations.push({
      code: "NETWORK_EGRESS_OUTSIDE_ALLOWLIST",
      summary: "The author environment contacted an origin outside the preregistered allowlist.",
      details: disallowedOrigins,
    });
  }

  const toolInventoryDiff = differentValues(policy.expectedToolNames, attestation.observedToolNames);
  if (toolInventoryDiff.length > 0) {
    violations.push({
      code: "TOOL_INVENTORY_DRIFT",
      summary: "The browser-exposed WebMCP inventory differed from the frozen protocol.",
      details: toolInventoryDiff,
    });
  }
  if (attestation.observedToolDescriptorDigest !== policy.expectedToolDescriptorDigest) {
    violations.push({
      code: "TOOL_DESCRIPTOR_DRIFT",
      summary: "The browser-exposed WebMCP descriptor digest differed from the frozen protocol.",
      details: [
        `expected:${policy.expectedToolDescriptorDigest}`,
        `observed:${attestation.observedToolDescriptorDigest}`,
      ],
    });
  }

  return {
    schemaVersion: CLEAN_ROOM_SCHEMA_VERSION,
    status: violations.length === 0 ? "pass" : "policy_violation",
    violations,
  };
}

export type ScopedPixelFence = {
  inspectionId: string;
  roomId: string;
  roomRevision: number;
  scopeDigest: string;
  expiresAt: number;
};

export type AuthorAction =
  | { kind: "navigate"; url: string }
  | { kind: "webmcp.discover"; pageUrl: string }
  | { kind: "webmcp.call"; pageUrl: string; toolName: string }
  | { kind: "pixels.receive"; fence: ScopedPixelFence; now: number }
  | { kind: "wait"; durationMs: number }
  | { kind: "forbidden"; surface: CleanRoomForbiddenSurface; target?: string };

export type AuthorActionDecision = {
  allowed: boolean;
  reasonCode:
    | "ALLOWED"
    | "ARBITRARY_PIXEL_ACCESS_DENIED"
    | "FORBIDDEN_SURFACE"
    | "INVALID_WAIT"
    | "OUTSIDE_AUTHORIZED_ROOM"
    | "STALE_PIXEL_FENCE"
    | "UNKNOWN_WEBMCP_TOOL";
  summary: string;
};

function sameAuthorizedRoomUrl(policy: CleanRoomPolicy, candidate: string): boolean {
  try {
    const expected = new URL(policy.authorizedRoomUrl);
    const observed = new URL(candidate);
    return expected.origin === observed.origin
      && expected.pathname.replace(/\/$/, "") === observed.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export function authorizeAuthorAction(
  policy: CleanRoomPolicy,
  action: AuthorAction,
  issuedPixelFences: ReadonlyMap<string, ScopedPixelFence> = new Map(),
): AuthorActionDecision {
  if (action.kind === "forbidden") {
    return {
      allowed: false,
      reasonCode: "FORBIDDEN_SURFACE",
      summary: `The clean-room author may not use ${action.surface}.`,
    };
  }

  if (action.kind === "wait") {
    const allowed = Number.isFinite(action.durationMs)
      && action.durationMs >= 0
      && action.durationMs <= policy.maximumWaitMs;
    return allowed
      ? { allowed: true, reasonCode: "ALLOWED", summary: "Bounded waiting is permitted." }
      : { allowed: false, reasonCode: "INVALID_WAIT", summary: "The wait exceeds the preregistered bound." };
  }

  if (action.kind === "navigate" || action.kind === "webmcp.discover") {
    const url = action.kind === "navigate" ? action.url : action.pageUrl;
    return sameAuthorizedRoomUrl(policy, url)
      ? { allowed: true, reasonCode: "ALLOWED", summary: "The action targets the authorized Jazzboard room." }
      : {
          allowed: false,
          reasonCode: "OUTSIDE_AUTHORIZED_ROOM",
          summary: "The author may navigate and discover tools only in the supplied room.",
        };
  }

  if (action.kind === "webmcp.call") {
    if (!sameAuthorizedRoomUrl(policy, action.pageUrl)) {
      return {
        allowed: false,
        reasonCode: "OUTSIDE_AUTHORIZED_ROOM",
        summary: "The tool call is not bound to the supplied room.",
      };
    }
    if (!policy.expectedToolNames.includes(action.toolName)) {
      return {
        allowed: false,
        reasonCode: "UNKNOWN_WEBMCP_TOOL",
        summary: "The tool was not present in the frozen browser-exposed inventory.",
      };
    }
    return { allowed: true, reasonCode: "ALLOWED", summary: "The browser-exposed WebMCP call is permitted." };
  }

  const issued = issuedPixelFences.get(action.fence.inspectionId);
  if (!issued
    || issued.roomId !== policy.expectedRoomId
    || issued.roomId !== action.fence.roomId
    || issued.roomRevision !== action.fence.roomRevision
    || issued.scopeDigest !== action.fence.scopeDigest) {
    return {
      allowed: false,
      reasonCode: "ARBITRARY_PIXEL_ACCESS_DENIED",
      summary: "Pixels require an exact evaluator-issued inspection fence for this room revision and scope.",
    };
  }
  if (action.now > issued.expiresAt || action.fence.expiresAt !== issued.expiresAt) {
    return {
      allowed: false,
      reasonCode: "STALE_PIXEL_FENCE",
      summary: "The scoped pixel fence expired before delivery.",
    };
  }
  return { allowed: true, reasonCode: "ALLOWED", summary: "Revision-bound scoped pixels may be delivered." };
}

export type EvaluatorSeparationAttestation = {
  authorSessionId: string;
  evaluatorSessionId: string;
  authorFinishedAt: number;
  artifactSealedAt: number;
  evaluatorStartedAt: number;
  evaluatorRole: "participant" | "spectator";
  evaluatorMutationToolNames: string[];
  evaluatorCanMessageAuthor: boolean;
  sharedWritableStorage: boolean;
  sealedArtifactRootBeforeEvaluation: string | null;
  artifactRootObservedByEvaluator: string | null;
};

export type EvaluatorSeparationCode =
  | "ARTIFACT_CHANGED_AFTER_SEAL"
  | "EVALUATOR_CAN_MESSAGE_AUTHOR"
  | "EVALUATOR_HAS_MUTATION_TOOLS"
  | "EVALUATOR_NOT_SPECTATOR"
  | "EVALUATOR_STARTED_BEFORE_SEAL"
  | "MISSING_SEALED_ARTIFACT_ROOT"
  | "SESSION_IDENTITY_REUSED"
  | "WRITABLE_STORAGE_SHARED";

export type EvaluatorSeparationAssessment = {
  status: "pass" | "policy_violation";
  violations: Array<{ code: EvaluatorSeparationCode; summary: string; details?: string[] }>;
};

export function assessEvaluatorSeparation(
  attestation: EvaluatorSeparationAttestation,
): EvaluatorSeparationAssessment {
  const violations: EvaluatorSeparationAssessment["violations"] = [];
  if (attestation.authorSessionId === attestation.evaluatorSessionId) {
    violations.push({ code: "SESSION_IDENTITY_REUSED", summary: "Author and evaluator reused one session identity." });
  }
  if (attestation.evaluatorStartedAt < attestation.artifactSealedAt
    || attestation.artifactSealedAt < attestation.authorFinishedAt) {
    violations.push({
      code: "EVALUATOR_STARTED_BEFORE_SEAL",
      summary: "Evaluation began before author termination and artifact sealing completed.",
    });
  }
  if (attestation.evaluatorRole !== "spectator") {
    violations.push({ code: "EVALUATOR_NOT_SPECTATOR", summary: "The passive evaluator was not a spectator." });
  }
  if (attestation.evaluatorMutationToolNames.length > 0) {
    violations.push({
      code: "EVALUATOR_HAS_MUTATION_TOOLS",
      summary: "The evaluator received canvas mutation tools.",
      details: normalizedUnique(attestation.evaluatorMutationToolNames),
    });
  }
  if (attestation.evaluatorCanMessageAuthor) {
    violations.push({ code: "EVALUATOR_CAN_MESSAGE_AUTHOR", summary: "The evaluator could communicate with the author." });
  }
  if (attestation.sharedWritableStorage) {
    violations.push({ code: "WRITABLE_STORAGE_SHARED", summary: "Author and evaluator shared writable storage." });
  }
  if (!attestation.sealedArtifactRootBeforeEvaluation || !attestation.artifactRootObservedByEvaluator) {
    violations.push({
      code: "MISSING_SEALED_ARTIFACT_ROOT",
      summary: "The evaluator did not receive a content-addressed sealed artifact root.",
    });
  } else if (attestation.sealedArtifactRootBeforeEvaluation !== attestation.artifactRootObservedByEvaluator) {
    violations.push({
      code: "ARTIFACT_CHANGED_AFTER_SEAL",
      summary: "The artifact root changed after the author evidence was sealed.",
      details: [
        `sealed:${attestation.sealedArtifactRootBeforeEvaluation}`,
        `observed:${attestation.artifactRootObservedByEvaluator}`,
      ],
    });
  }
  return { status: violations.length === 0 ? "pass" : "policy_violation", violations };
}

export type CanaryScan = {
  status: "pass" | "policy_violation";
  matchedCanaryIds: string[];
};

export function scanForCanaries(
  authoredText: string,
  canaries: ReadonlyArray<{ id: string; token: string }>,
): CanaryScan {
  const matchedCanaryIds = canaries
    .filter((canary) => canary.token.length > 0 && authoredText.includes(canary.token))
    .map((canary) => canary.id)
    .sort();
  return {
    status: matchedCanaryIds.length === 0 ? "pass" : "policy_violation",
    matchedCanaryIds,
  };
}

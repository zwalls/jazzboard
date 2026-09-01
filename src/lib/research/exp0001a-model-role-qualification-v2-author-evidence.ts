import {
  EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME,
  qualificationV2CoordinatorStateSchema,
  sealQualificationV2AuthorEvidence,
} from "./exp0001a-model-role-qualification-v2-coordinator";
import {
  projectQualificationV2SanitizedSemanticState,
} from "./exp0001a-model-role-qualification-v2-semantic-projection";
import { assertQualificationV2PngStructure } from "./exp0001a-model-role-qualification-v2-png-sidecar";
import { analyzeQualificationV2NodeReplProgram } from "./exp0001a-model-role-qualification-v2-node-repl-trace";
import { canonicalJson, hashCanonicalJson, sha256Digest, type JsonValue } from "./provenance-crypto";

function clone(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function parseCallResult(input: unknown, imageRequired: boolean) {
  const raw = clone(input);
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") throw new Error("QUALIFICATION_V2_WEBMCP_RESULT_NOT_OBJECT");
  const envelope = raw as Record<string, JsonValue>;
  if (envelope.isError !== false || !Array.isArray(envelope.content)
      || envelope.content.length !== (imageRequired ? 2 : 1)) {
    throw new Error("QUALIFICATION_V2_WEBMCP_RESULT_WRAPPER_INVALID");
  }
  const text = envelope.content[0];
  if (text === null || Array.isArray(text) || typeof text !== "object"
      || (text as Record<string, JsonValue>).type !== "text"
      || typeof (text as Record<string, JsonValue>).text !== "string") {
    throw new Error("QUALIFICATION_V2_WEBMCP_TEXT_RESULT_INVALID");
  }
  const result = clone(JSON.parse((text as { text: string }).text));
  let pngBytes: Buffer | null = null;
  if (imageRequired) {
    const image = envelope.content[1];
    if (image === null || Array.isArray(image) || typeof image !== "object"
        || (image as Record<string, JsonValue>).type !== "image"
        || (image as Record<string, JsonValue>).mimeType !== "image/png"
        || typeof (image as Record<string, JsonValue>).data !== "string") {
      throw new Error("QUALIFICATION_V2_WEBMCP_PNG_RESULT_INVALID");
    }
    pngBytes = Buffer.from((image as { data: string }).data, "base64");
    if (pngBytes.toString("base64") !== (image as { data: string }).data) {
      throw new Error("QUALIFICATION_V2_WEBMCP_PNG_BASE64_NONCANONICAL");
    }
    assertQualificationV2PngStructure(pngBytes);
  }
  return { raw, rawDigest: hashCanonicalJson(raw), result, resultDigest: hashCanonicalJson(result), pngBytes };
}

function object(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`QUALIFICATION_V2_${label}_INVALID`);
  return value as Record<string, JsonValue>;
}

function parseRetainedToolObservation(
  input: unknown,
  expectedToolName: "mcp__codex_app__wait_threads" | "mcp__codex_app__read_thread",
) {
  const cloned = clone(input);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new Error("QUALIFICATION_V2_RETAINED_TOOL_OBSERVATION_REQUIRED");
  }
  const observation = cloned as Record<string, JsonValue>;
  if (observation.schemaVersion !== "exp-0001a-qualification-raw-tool-observation/v2") {
    throw new Error("QUALIFICATION_V2_RETAINED_TOOL_OBSERVATION_REQUIRED");
  }
  const { observationDigest: _observationDigest, ...content } = observation;
  if (observation.toolName !== expectedToolName
      || observation.outcome !== "returned"
      || observation.rawResult === null
      || typeof observation.actionDigest !== "string"
      || !Number.isSafeInteger(observation.invocationOrdinal)
      || typeof observation.rawResultDigest !== "string"
      || hashCanonicalJson(observation.rawResult) !== observation.rawResultDigest
      || typeof _observationDigest !== "string"
      || hashCanonicalJson(content as unknown as JsonValue) !== _observationDigest) {
    throw new Error("QUALIFICATION_V2_RETAINED_TOOL_OBSERVATION_BINDING_INVALID");
  }
  return Object.freeze({
    actionDigest: observation.actionDigest,
    invocationOrdinal: Number(observation.invocationOrdinal),
    observationDigest: _observationDigest,
    rawResult: observation.rawResult,
  });
}

function retainedItemOutputIsTruncated(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(retainedItemOutputIsTruncated);
  const record = value as Record<string, JsonValue>;
  if (record.truncated === true) return true;
  if (typeof record.originalChars === "number" && typeof record.text === "string"
      && record.originalChars > record.text.length) return true;
  return Object.values(record).some(retainedItemOutputIsTruncated);
}

function retainedItemContainsPngImage(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(retainedItemContainsPngImage);
  const record = value as Record<string, JsonValue>;
  if (record.type === "image" && record.mimeType === "image/png"
      && typeof record.data === "string" && record.data.length > 0) return true;
  return Object.values(record).some(retainedItemContainsPngImage);
}

const AUTHOR_SESSION_MARKER_SCHEMA = "exp-0001a-qualification-author-session-marker/v2";

function retainedOutputTexts(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (value === undefined || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => retainedOutputTexts(entry));
  const record = value as Record<string, JsonValue>;
  if (typeof record.text === "string") return [record.text];
  return Object.entries(record)
    .filter(([key]) => key === "content" || key === "output" || key === "result")
    .flatMap(([, entry]) => retainedOutputTexts(entry));
}

function parseMarkerText(text: string): Record<string, JsonValue> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return null;
  const marker = parsed as Record<string, JsonValue>;
  if (marker.schemaVersion !== AUTHOR_SESSION_MARKER_SCHEMA) return null;
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["collaboration", "join", "schemaVersion"])) {
    throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_MARKER_KEYS_INVALID");
  }
  return marker;
}

type AuthorSessionMarker = Readonly<{
  participantId: string;
  displayName: typeof EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME;
  role: "participant";
  roomId: string;
  roomCode: string;
  participantIds: readonly string[];
  joinResultDigest: string;
  collaborationResultDigest: string;
}>;

type AuthorVisualMarker = Readonly<{
  roomId: string;
  roomRevision: number;
  roomUrl: string;
  canvasStateDigest: string;
  inspectionResultDigest: string;
  inspectionRevisionSetDigest: string;
}>;

function canonicalCanvasStateDigest(result: Record<string, unknown>): string {
  const data = result.data;
  if (result.ok !== true || result.tool !== "read_room_state" || data === null
      || Array.isArray(data) || typeof data !== "object") {
    throw new Error("QUALIFICATION_V2_AUTHOR_VISUAL_ROOM_STATE_INVALID");
  }
  const record = data as Record<string, unknown>;
  const room = record.room;
  if (room === null || Array.isArray(room) || typeof room !== "object"
      || typeof (room as Record<string, unknown>).id !== "string"
      || !Number.isSafeInteger((room as Record<string, unknown>).roomRevision)
      || !Array.isArray(record.objects) || !Array.isArray(record.diagrams)) {
    throw new Error("QUALIFICATION_V2_AUTHOR_VISUAL_ROOM_STATE_INVALID");
  }
  const sortRecords = (values: unknown[], label: string) => values.map((value) => {
    if (value === null || Array.isArray(value) || typeof value !== "object"
        || typeof (value as Record<string, unknown>).id !== "string"
        || !Number.isSafeInteger((value as Record<string, unknown>).revision)) {
      throw new Error(`QUALIFICATION_V2_AUTHOR_VISUAL_${label}_INVALID`);
    }
    return clone(value);
  }).sort((left, right) => String((left as Record<string, JsonValue>).id)
    .localeCompare(String((right as Record<string, JsonValue>).id)));
  return hashCanonicalJson({
    room: {
      id: (room as Record<string, unknown>).id,
      roomRevision: (room as Record<string, unknown>).roomRevision,
    },
    objects: sortRecords(record.objects, "OBJECT"),
    diagrams: sortRecords(record.diagrams, "DIAGRAM"),
  } as unknown as JsonValue);
}

type AuthorMutationProof = Readonly<{
  tool: string;
  outcome: string;
  roomRevision: number | null;
  changedObjectIds: readonly string[];
  changedDiagramIds: readonly string[];
  resultDigest: string;
}>;

function uniqueSortedIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length < 1)
      || new Set(value).size !== value.length) {
    throw new Error(`QUALIFICATION_V2_${label}_INVALID`);
  }
  return Object.freeze([...value].sort());
}

function parseAuthorMutationMarkerText(text: string, expectedTool: string): AuthorMutationProof | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return null;
  const marker = parsed as Record<string, unknown>;
  if (marker.schemaVersion !== "exp-0001a-qualification-author-mutation-result/v2") return null;
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["schemaVersion", "toolResult"])) {
    throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_MARKER_KEYS_INVALID");
  }
  if (marker.toolResult === null || Array.isArray(marker.toolResult) || typeof marker.toolResult !== "object") {
    throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_RESULT_INVALID");
  }
  const result = marker.toolResult as Record<string, unknown>;
  if (result.ok !== true || result.tool !== expectedTool || result.data === null
      || Array.isArray(result.data) || typeof result.data !== "object") {
    throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_RESULT_INVALID");
  }
  const data = result.data as Record<string, unknown>;
  if (typeof data.outcome !== "string") throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_OUTCOME_INVALID");
  if (data.outcome !== "applied") {
    return Object.freeze({
      tool: expectedTool,
      outcome: data.outcome,
      roomRevision: null,
      changedObjectIds: Object.freeze([]),
      changedDiagramIds: Object.freeze([]),
      resultDigest: hashCanonicalJson(result as unknown as JsonValue),
    });
  }
  if (!Number.isSafeInteger(data.roomRevision) || Number(data.roomRevision) < 1) {
    throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_REVISION_INVALID");
  }
  const changedObjectIds = uniqueSortedIds(data.changedObjectIds, "AUTHOR_MUTATION_OBJECT_IDS");
  const changedDiagramIds = uniqueSortedIds(data.changedDiagramIds ?? [], "AUTHOR_MUTATION_DIAGRAM_IDS");
  if (changedObjectIds.length + changedDiagramIds.length < 1) {
    throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_EMPTY_APPLIED_RESULT");
  }
  return Object.freeze({
    tool: expectedTool,
    outcome: data.outcome,
    roomRevision: Number(data.roomRevision),
    changedObjectIds,
    changedDiagramIds,
    resultDigest: hashCanonicalJson(result as unknown as JsonValue),
  });
}

function parseAuthorVisualMarkerText(text: string): AuthorVisualMarker | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return null;
  const marker = parsed as Record<string, unknown>;
  if (marker.schemaVersion !== "exp-0001a-qualification-author-visual-marker/v2") return null;
  if (JSON.stringify(Object.keys(marker).sort())
      !== JSON.stringify(["inspection", "pageUrl", "roomState", "schemaVersion"])) {
    throw new Error("QUALIFICATION_V2_AUTHOR_VISUAL_MARKER_KEYS_INVALID");
  }
  if (typeof marker.pageUrl !== "string" || marker.roomState === null
      || Array.isArray(marker.roomState) || typeof marker.roomState !== "object"
      || marker.inspection === null || Array.isArray(marker.inspection)
      || typeof marker.inspection !== "object") {
    throw new Error("QUALIFICATION_V2_AUTHOR_VISUAL_MARKER_INVALID");
  }
  const roomState = marker.roomState as Record<string, unknown>;
  const inspection = marker.inspection as Record<string, unknown>;
  const data = roomState.data;
  const room = data !== null && !Array.isArray(data) && typeof data === "object"
    ? (data as Record<string, unknown>).room
    : null;
  const inspectionData = inspection.data;
  const sceneContext = inspectionData !== null && !Array.isArray(inspectionData)
    && typeof inspectionData === "object"
    ? (inspectionData as Record<string, unknown>).sceneContext
    : null;
  const sceneRevisions = sceneContext !== null && !Array.isArray(sceneContext)
    && typeof sceneContext === "object"
    ? (sceneContext as Record<string, unknown>).revisions
    : null;
  const explicitCoverage = sceneRevisions !== null && !Array.isArray(sceneRevisions)
    && typeof sceneRevisions === "object"
    ? (sceneRevisions as Record<string, unknown>).explicitObjectRevisionCoverage
    : null;
  if (roomState.ok !== true || roomState.tool !== "read_room_state"
      || room === null || Array.isArray(room) || typeof room !== "object"
      || typeof (room as Record<string, unknown>).id !== "string"
      || !Number.isSafeInteger((room as Record<string, unknown>).roomRevision)
      || Number((room as Record<string, unknown>).roomRevision) < 1
      || inspection.ok !== true || inspection.tool !== "inspect_canvas_scope"
      || sceneRevisions === null || Array.isArray(sceneRevisions) || typeof sceneRevisions !== "object"
      || (sceneRevisions as Record<string, unknown>).roomRevision
        !== (room as Record<string, unknown>).roomRevision
      || explicitCoverage === null || Array.isArray(explicitCoverage) || typeof explicitCoverage !== "object"
      || typeof (explicitCoverage as Record<string, unknown>).fullSetDigest !== "string") {
    throw new Error("QUALIFICATION_V2_AUTHOR_VISUAL_MARKER_READ_INVALID");
  }
  return Object.freeze({
    roomId: String((room as Record<string, unknown>).id),
    roomRevision: Number((room as Record<string, unknown>).roomRevision),
    roomUrl: marker.pageUrl,
    canvasStateDigest: canonicalCanvasStateDigest(roomState),
    inspectionResultDigest: hashCanonicalJson(inspection as unknown as JsonValue),
    inspectionRevisionSetDigest: String((explicitCoverage as Record<string, unknown>).fullSetDigest),
  });
}

function parseAuthorSessionMarker(marker: Record<string, JsonValue>): AuthorSessionMarker {
  const join = object(marker.join as JsonValue, "AUTHOR_SESSION_JOIN");
  const collaboration = object(marker.collaboration as JsonValue, "AUTHOR_SESSION_COLLABORATION");
  const joinData = object(join.data as JsonValue, "AUTHOR_SESSION_JOIN_DATA");
  const joinRoom = object(joinData.room as JsonValue, "AUTHOR_SESSION_JOIN_ROOM");
  const collaborationData = object(collaboration.data as JsonValue, "AUTHOR_SESSION_COLLABORATION_DATA");
  const collaborationRoom = object(collaborationData.room as JsonValue, "AUTHOR_SESSION_COLLABORATION_ROOM");
  const session = object(collaborationData.session as JsonValue, "AUTHOR_SESSION_COLLABORATION_SESSION");
  if (join.ok !== true || join.tool !== "join_room" || joinData.role !== "participant"
      || collaboration.ok !== true || collaboration.tool !== "read_collaboration_state"
      || session.role !== "participant" || typeof session.participantId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(session.participantId)
      || typeof joinRoom.id !== "string" || typeof joinRoom.code !== "string"
      || collaborationRoom.id !== joinRoom.id || collaborationRoom.code !== joinRoom.code
      || !Array.isArray(collaborationData.participants)) {
    throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_MARKER_RESULT_INVALID");
  }
  const participantIds = collaborationData.participants.map((value) => {
    const participant = object(value, "AUTHOR_SESSION_COLLABORATION_PARTICIPANT");
    if (typeof participant.participantId !== "string" || typeof participant.displayName !== "string"
        || (participant.role !== "participant" && participant.role !== "spectator")) {
      throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_MARKER_PARTICIPANT_INVALID");
    }
    if (participant.participantId === session.participantId
        && (participant.displayName !== EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME
          || participant.role !== "participant")) {
      throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_MARKER_SELF_INVALID");
    }
    return participant.participantId;
  }).sort();
  if (new Set(participantIds).size !== participantIds.length
      || !participantIds.includes(session.participantId)) {
    throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_MARKER_PARTICIPANT_SET_INVALID");
  }
  return Object.freeze({
    participantId: session.participantId,
    displayName: EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME,
    role: "participant",
    roomId: joinRoom.id,
    roomCode: joinRoom.code,
    participantIds: Object.freeze(participantIds),
    joinResultDigest: hashCanonicalJson(join as unknown as JsonValue),
    collaborationResultDigest: hashCanonicalJson(collaboration as unknown as JsonValue),
  });
}

function stableFNV1aDigest(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function deriveTrace(input: Readonly<{
  readThreadCallResults: readonly unknown[];
  waitThreadCallResults: readonly unknown[];
  expectedActionDigest: string;
  expectedTaskId: string;
  expectedHostId: string;
  expectedRawTerminalToolResultDigest: string;
}>) {
  const toolNames: string[] = [];
  const sessionMarkers: AuthorSessionMarker[] = [];
  const visualMarkers: Array<AuthorVisualMarker & { eventIndex: number }> = [];
  const mutationProofs: Array<AuthorMutationProof & { eventIndex: number }> = [];
  const mutationProgramEvents: number[] = [];
  const visualProgramEvents: number[] = [];
  const unobservableMutationProgramEvents: number[] = [];
  const unobservableVisualProgramEvents: number[] = [];
  let sessionResultOutputOmitted = false;
  let nestedResultOutputObserved = false;
  let nestedResultOutputOmitted = false;
  let nodeCallCount = 0;
  let eventIndex = 0;
  let lastMutationEventIndex = -1;
  const persistedToolResultBindings = new Map<string, string>();
  const mutationTools = new Set([
    "apply_canvas_transaction", "create_diagram", "create_node", "create_shape", "create_text", "create_drawing",
    "create_path", "create_polygon", "draw_connection", "edit_diagram", "update_object", "move_objects",
    "delete_objects", "group_objects", "layout_objects", "finish_canvas_draft",
  ]);
  const readObservations = input.readThreadCallResults.map((result, index) => {
    const observation = parseRetainedToolObservation(result, "mcp__codex_app__read_thread");
    if (observation.actionDigest !== input.expectedActionDigest || observation.invocationOrdinal !== index + 1) {
      throw new Error("QUALIFICATION_V2_AUTHOR_READ_THREAD_CHAIN_INVALID");
    }
    return observation;
  });
  const waitObservations = input.waitThreadCallResults.map((result, index) => {
    const observation = parseRetainedToolObservation(result, "mcp__codex_app__wait_threads");
    if (observation.actionDigest !== input.expectedActionDigest || observation.invocationOrdinal !== index + 1) {
      throw new Error("QUALIFICATION_V2_AUTHOR_WAIT_THREAD_CHAIN_INVALID");
    }
    return observation;
  });
  if (readObservations.length === 0 || waitObservations.length === 0
      || hashCanonicalJson({
        waits: waitObservations.map((observation) => observation.observationDigest),
        reads: readObservations.map((observation) => observation.observationDigest),
        evidenceReadReceiptDigest: null,
      }) !== input.expectedRawTerminalToolResultDigest) {
    throw new Error("QUALIFICATION_V2_AUTHOR_TERMINAL_TOOL_CHAIN_INVALID");
  }
  const turnIds = new Set<string>();
  for (const observation of readObservations) {
    const retained = parseCallResult(observation.rawResult, false);
    const page = object(retained.result, "READ_THREAD_PAGE");
    const thread = object(page.thread as JsonValue, "READ_THREAD_THREAD");
    if (thread.id !== input.expectedTaskId || thread.hostId !== input.expectedHostId) {
      throw new Error("QUALIFICATION_V2_AUTHOR_READ_THREAD_IDENTITY_INVALID");
    }
    if (!Array.isArray(page.turns)) throw new Error("QUALIFICATION_V2_READ_THREAD_TURNS_INVALID");
    for (const turnValue of page.turns) {
      const turn = object(turnValue, "READ_THREAD_TURN");
      if (typeof turn.id !== "string") throw new Error("QUALIFICATION_V2_READ_THREAD_TURN_ID_INVALID");
      turnIds.add(turn.id);
      if (!Array.isArray(turn.items)) throw new Error("QUALIFICATION_V2_READ_THREAD_ITEMS_INVALID");
      for (const itemValue of turn.items) {
        eventIndex += 1;
        const item = object(itemValue, "READ_THREAD_ITEM");
        if (retainedItemOutputIsTruncated(item as unknown as JsonValue)) {
          throw new Error("QUALIFICATION_V2_AUTHOR_TRACE_OUTPUT_TRUNCATED");
        }
        if (item.type !== "mcpToolCall") continue;
        if (item.server !== "node_repl" || item.tool !== "js") throw new Error("QUALIFICATION_V2_AUTHOR_TRACE_TOOL_INVALID");
        nodeCallCount += 1;
        const args = object(item.arguments as JsonValue, "READ_THREAD_ARGUMENTS");
        if (typeof args.code !== "string") throw new Error("QUALIFICATION_V2_AUTHOR_TRACE_CODE_INVALID");
        let programAnalysis: ReturnType<typeof analyzeQualificationV2NodeReplProgram>;
        try {
          programAnalysis = analyzeQualificationV2NodeReplProgram(args.code);
        } catch {
          throw new Error("QUALIFICATION_V2_AUTHOR_TRACE_CODE_INVALID");
        }
        const callNames = programAnalysis.toolCalls.map((toolCall) => toolCall.toolName);
        for (const binding of programAnalysis.declaredBindings) {
          persistedToolResultBindings.delete(binding);
        }
        for (const toolCall of programAnalysis.toolCalls) {
          if (toolCall.resultBinding !== null) {
            persistedToolResultBindings.set(toolCall.resultBinding, toolCall.toolName);
          }
        }
        for (const binding of programAnalysis.mutatedBindings) {
          persistedToolResultBindings.delete(binding);
        }
        const mutationCallNames = callNames.filter((name) => mutationTools.has(name));
        if (mutationCallNames.length > 0) {
          lastMutationEventIndex = eventIndex;
          if (mutationCallNames.length !== 1 || item.status !== "completed"
              || programAnalysis.mutationProofTool !== mutationCallNames[0]) {
            throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_PROOF_PROTOCOL_INVALID");
          }
        }
        if (item.status === "completed") {
          const hasRetainedNestedResult = Object.prototype.hasOwnProperty.call(item, "output")
            || Object.prototype.hasOwnProperty.call(item, "result");
          if (hasRetainedNestedResult) nestedResultOutputObserved = true;
          else nestedResultOutputOmitted = true;
          const outputTexts = [
            ...retainedOutputTexts(item.output),
            ...retainedOutputTexts(item.result),
          ];
          const sessionBinding = programAnalysis.sessionMarkerBindings;
          const sessionProtocolBound = sessionBinding !== null
            && persistedToolResultBindings.get(sessionBinding.join) === "join_room"
            && persistedToolResultBindings.get(sessionBinding.collaboration) === "read_collaboration_state";
          if (sessionProtocolBound && !hasRetainedNestedResult) sessionResultOutputOmitted = true;
          for (const text of outputTexts) {
            const marker = parseMarkerText(text);
            if (marker !== null) {
              if (!sessionProtocolBound) {
                throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_MARKER_PROTOCOL_INVALID");
              }
              sessionMarkers.push(parseAuthorSessionMarker(marker));
            }
          }
          if (mutationCallNames.length === 1) {
            mutationProgramEvents.push(eventIndex);
            if (!hasRetainedNestedResult) unobservableMutationProgramEvents.push(eventIndex);
            const proofs = outputTexts.flatMap((text) => {
              const proof = parseAuthorMutationMarkerText(text, mutationCallNames[0]!);
              return proof === null ? [] : [proof];
            });
            if (hasRetainedNestedResult && proofs.length !== 1) {
              throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_RESULT_PROOF_MISSING");
            }
            if (proofs.length === 1) mutationProofs.push({ ...proofs[0]!, eventIndex });
          }
          if (programAnalysis.visualProofBound) {
            visualProgramEvents.push(eventIndex);
            if (!hasRetainedNestedResult) unobservableVisualProgramEvents.push(eventIndex);
          }
          if (programAnalysis.visualProofBound && hasRetainedNestedResult
              && retainedItemContainsPngImage(item as unknown as JsonValue)) {
            for (const text of [
              ...retainedOutputTexts(item.output),
              ...retainedOutputTexts(item.result),
            ]) {
              const marker = parseAuthorVisualMarkerText(text);
              if (marker !== null) visualMarkers.push({ ...marker, eventIndex });
            }
          }
        }
        toolNames.push(...callNames);
      }
    }
  }
  if (turnIds.size !== 1) throw new Error("QUALIFICATION_V2_AUTHOR_TRACE_TURN_SET_INVALID");
  const unique = [...new Set(toolNames)].sort();
  if (nodeCallCount === 0 || !unique.includes("join_room")
      || !unique.includes("read_collaboration_state") || !unique.includes("read_room_state")
      || sessionMarkers.length > 1) {
    throw new Error("QUALIFICATION_V2_AUTHOR_TRACE_WEBMCP_DISCOVERY_INVALID");
  }
  const inspectionTools = new Set(["inspect_canvas_scope", "render_canvas_preview", "export_canvas_png"]);
  return {
    webMcpCallCount: "unobservable" as const,
    // read_thread retains the outer node_repl status, not necessarily each
    // inner WebMCP result. A `.call()` may return `{ok:false}` while the JS
    // invocation itself completes, so reporting zero here would be false
    // precision. Exact failures remain unobservable unless the host exposes a
    // separately bound per-call result stream.
    webMcpFailureCount: "unobservable" as const,
    mutationToolMentioned: toolNames.some((name) => mutationTools.has(name)),
    inspectionToolMentioned: toolNames.some((name) => inspectionTools.has(name)),
    visualMarkers,
    visualProgramEvents,
    unobservableVisualProgramEvents,
    mutationProofs,
    mutationProgramEvents,
    unobservableMutationProgramEvents,
    sessionResultOutputOmitted,
    nestedWebMcpResultObservation:
      nestedResultOutputOmitted || !nestedResultOutputObserved ? "unobservable" as const : "observed" as const,
    lastMutationEventIndex,
    authorSessionMarker: sessionMarkers[0] ?? null,
    webMcpTraceDigest: hashCanonicalJson({
      waitThreadCallResults: input.waitThreadCallResults.map((result) => clone(result)),
      readThreadCallResults: input.readThreadCallResults.map((result) => clone(result)),
    }),
  };
}

type RawRoomState = Readonly<{
  room: Record<string, JsonValue>;
  objects: readonly Record<string, JsonValue>[];
  diagrams: readonly Record<string, JsonValue>[];
  participants: readonly Record<string, JsonValue>[];
}>;

function parseRawRoomState(result: JsonValue, label: string): RawRoomState {
  const resultObject = object(result, `${label}_RESULT`);
  const data = object(resultObject.data as JsonValue, `${label}_DATA`);
  const room = object(data.room as JsonValue, `${label}_ROOM`);
  if (resultObject.ok !== true || resultObject.tool !== "read_room_state"
      || typeof room.id !== "string" || typeof room.code !== "string"
      || typeof room.selfParticipantId !== "string" || !Number.isSafeInteger(room.roomRevision)
      || !Array.isArray(data.objects) || !Array.isArray(data.diagrams) || !Array.isArray(data.participants)) {
    throw new Error(`QUALIFICATION_V2_${label}_INVALID`);
  }
  const records = (values: JsonValue[], kind: string) => values.map((value) => {
    const record = object(value, `${label}_${kind}`);
    if (typeof record.id !== "string" || !Number.isSafeInteger(record.revision)
        || Number(record.revision) < 1) throw new Error(`QUALIFICATION_V2_${label}_${kind}_INVALID`);
    return record;
  });
  const participants = data.participants.map((value) => {
    const participant = object(value, `${label}_PARTICIPANT`);
    if (typeof participant.participantId !== "string" || typeof participant.displayName !== "string"
        || (participant.role !== "participant" && participant.role !== "spectator")) {
      throw new Error(`QUALIFICATION_V2_${label}_PARTICIPANT_INVALID`);
    }
    return participant;
  });
  const objects = records(data.objects, "OBJECT");
  const diagrams = records(data.diagrams, "DIAGRAM");
  for (const values of [objects, diagrams]) {
    if (new Set(values.map((value) => value.id)).size !== values.length) {
      throw new Error(`QUALIFICATION_V2_${label}_DUPLICATE_ID`);
    }
  }
  if (new Set(participants.map((value) => value.participantId)).size !== participants.length) {
    throw new Error(`QUALIFICATION_V2_${label}_DUPLICATE_PARTICIPANT`);
  }
  return Object.freeze({ room, objects, diagrams, participants });
}

function actorMatches(record: Record<string, JsonValue>, field: "createdBy" | "lastEditedBy", participantId: string) {
  const actor = object(record[field] as JsonValue, `AUTHOR_ATTRIBUTION_${field.toUpperCase()}`);
  return actor.participantId === participantId
    && actor.displayName === EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME
    && actor.kind === "agent";
}

function deriveAttributedMutationSet(
  before: RawRoomState,
  after: RawRoomState,
  participantId: string,
) {
  const changes: Array<Record<string, JsonValue>> = [];
  for (const [entityKind, beforeValues, afterValues] of [
    ["object", before.objects, after.objects],
    ["diagram", before.diagrams, after.diagrams],
  ] as const) {
    const beforeById = new Map(beforeValues.map((record) => [String(record.id), record]));
    const afterById = new Map(afterValues.map((record) => [String(record.id), record]));
    for (const [id, prior] of beforeById) {
      const current = afterById.get(id);
      if (current === undefined) throw new Error("QUALIFICATION_V2_AUTHOR_ATTRIBUTION_DELETION_UNOBSERVABLE");
      const beforeRevision = Number(prior.revision);
      const afterRevision = Number(current.revision);
      if (afterRevision < beforeRevision
          || (afterRevision === beforeRevision
            && canonicalJson(prior as unknown as JsonValue) !== canonicalJson(current as unknown as JsonValue))) {
        throw new Error("QUALIFICATION_V2_AUTHOR_ATTRIBUTION_REVISION_INVALID");
      }
      if (afterRevision > beforeRevision) {
        if (!actorMatches(current, "lastEditedBy", participantId)) {
          throw new Error("QUALIFICATION_V2_AUTHOR_ATTRIBUTION_EDITOR_MISMATCH");
        }
        changes.push({ entityKind, id, mutationKind: "updated", beforeRevision, afterRevision });
      }
    }
    for (const [id, current] of afterById) {
      if (beforeById.has(id)) continue;
      if (!actorMatches(current, "createdBy", participantId)
          || !actorMatches(current, "lastEditedBy", participantId)) {
        throw new Error("QUALIFICATION_V2_AUTHOR_ATTRIBUTION_CREATOR_MISMATCH");
      }
      changes.push({ entityKind, id, mutationKind: "created", beforeRevision: null, afterRevision: current.revision });
    }
  }
  changes.sort((left, right) => `${left.entityKind}:${left.id}`.localeCompare(`${right.entityKind}:${right.id}`));
  if (changes.length === 0) throw new Error("QUALIFICATION_V2_AUTHOR_ATTRIBUTION_NO_MUTATION");
  return Object.freeze(changes);
}

export function deriveQualificationV2AuthorEvidence(input: Readonly<{
  state: unknown;
  waitThreadCallResults: readonly unknown[];
  readThreadCallResults: readonly unknown[];
  preAuthorRoomReadCallResult: unknown;
  closingRoomReadCallResult: unknown;
  inspectionCallResult: unknown;
  pngExportCallResult: unknown;
  retainedAt: string;
}>) {
  const state = qualificationV2CoordinatorStateSchema.parse(input.state);
  if (state.currentTaskIndex >= state.tasks.length) throw new Error("QUALIFICATION_V2_AUTHOR_EVIDENCE_TASK_MISSING");
  const task = state.tasks[state.currentTaskIndex];
  if (task.phase !== "awaiting_author_evidence" || task.room === null || task.authorReceipt === null
      || task.authorReceipt.terminalStatus !== "completed" || task.authorReceipt.createdTaskId === null) {
    throw new Error("QUALIFICATION_V2_AUTHOR_EVIDENCE_NOT_EXPECTED");
  }
  const [preAuthorRoomRead, roomRead, inspection, pngExport] = [
    parseCallResult(input.preAuthorRoomReadCallResult, false),
    parseCallResult(input.closingRoomReadCallResult, false),
    parseCallResult(input.inspectionCallResult, false),
    parseCallResult(input.pngExportCallResult, true),
  ];
  const preAuthorState = parseRawRoomState(preAuthorRoomRead.result, "PRE_AUTHOR_ROOM_STATE");
  const closingState = parseRawRoomState(roomRead.result, "CLOSING_ROOM_STATE");
  const roomReadObject = object(roomRead.result, "ROOM_READ_RESULT");
  const roomData = object(roomReadObject.data as JsonValue, "ROOM_READ_DATA");
  const room = object(roomData.room as JsonValue, "ROOM_READ_ROOM");
  const semanticState = projectQualificationV2SanitizedSemanticState(roomRead.result);
  const expectedRevisions = semanticState.objects
    .map((value) => ({ objectId: value.id, revision: value.revision }))
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  const inspectionResult = object(inspection.result, "INSPECTION_RESULT");
  const inspectionData = object(inspectionResult.data as JsonValue, "INSPECTION_DATA");
  const inspectionScene = object(inspectionData.sceneContext as JsonValue, "INSPECTION_SCENE_CONTEXT");
  const inspectionScope = object(inspectionScene.scope as JsonValue, "INSPECTION_SCOPE");
  const inspectionRevisions = object(inspectionScene.revisions as JsonValue, "INSPECTION_REVISIONS");
  const explicitCoverage = object(
    inspectionRevisions.explicitObjectRevisionCoverage as JsonValue,
    "INSPECTION_EXPLICIT_COVERAGE",
  );
  const inspectionCoverage = object(inspectionScene.coverage as JsonValue, "INSPECTION_COVERAGE");
  const inspectionPixels = object(inspectionScene.pixels as JsonValue, "INSPECTION_PIXELS");
  const pngResult = object(pngExport.result, "PNG_RESULT");
  const pngData = object(pngResult.data as JsonValue, "PNG_DATA");
  const pngRevisions = object(pngData.sourceRevisions as JsonValue, "PNG_REVISIONS");
  const explicitRevisionLimit = explicitCoverage.limit;
  const explicitRevisionReturnedCount = explicitCoverage.returnedCount;
  const expectedReturnedRevisionCount = Number.isSafeInteger(explicitRevisionLimit)
    && Number(explicitRevisionLimit) > 0
    ? Math.min(semanticState.objects.length, Number(explicitRevisionLimit))
    : -1;
  if (roomReadObject.ok !== true || roomReadObject.tool !== "read_room_state"
      || inspectionResult.ok !== true || inspectionResult.tool !== "inspect_canvas_scope"
      || pngResult.ok !== true || pngResult.tool !== "export_canvas_png"
      || room.id !== task.room.roomId || typeof room.roomRevision !== "number"
      || inspectionRevisions.roomRevision !== room.roomRevision || pngRevisions.roomRevision !== room.roomRevision
      || inspectionScene.schemaVersion !== 2 || inspectionScope.kind !== "objects"
      || inspectionCoverage.allExplicitTargetsRepresented !== true
      || inspectionCoverage.scopeObjectCount !== semanticState.objects.length
      || explicitCoverage.totalCount !== semanticState.objects.length
      || explicitRevisionReturnedCount !== expectedReturnedRevisionCount
      || explicitCoverage.omittedCount !== semanticState.objects.length - expectedReturnedRevisionCount
      || explicitCoverage.truncated !== (expectedReturnedRevisionCount < semanticState.objects.length)
      || explicitCoverage.fullSetDigest !== stableFNV1aDigest(expectedRevisions)
      || inspectionData.visualInspectionStatus !== "not_performed"
      || inspectionPixels.visualInspectionStatus !== "not_performed"
      || pngData.persistedByJazzboard !== false || pngData.mimeType !== "image/png"
      || pngExport.pngBytes === null || pngData.byteLength !== pngExport.pngBytes.length) {
    throw new Error("QUALIFICATION_V2_AUTHOR_EVIDENCE_REVISION_BINDING_INVALID");
  }
  const explicitRevisions = Array.isArray(inspectionRevisions.explicitObjectRevisions)
    ? inspectionRevisions.explicitObjectRevisions.map((value) => object(value, "INSPECTION_EXPLICIT_REVISION"))
    : [];
  const observedRevisions = explicitRevisions
    .map((value) => ({ objectId: value.objectId, revision: value.revision }))
    .sort((left, right) => String(left.objectId).localeCompare(String(right.objectId)));
  const expectedReturnedRevisions = expectedRevisions.slice(0, expectedReturnedRevisionCount);
  if (new Set(observedRevisions.map((value) => value.objectId)).size !== observedRevisions.length
      || canonicalJson(observedRevisions as unknown as JsonValue)
        !== canonicalJson(expectedReturnedRevisions as unknown as JsonValue)) {
    throw new Error("QUALIFICATION_V2_AUTHOR_EVIDENCE_EXPLICIT_TARGET_COVERAGE_INVALID");
  }
  const trace = deriveTrace({
    waitThreadCallResults: input.waitThreadCallResults,
    readThreadCallResults: input.readThreadCallResults,
    expectedActionDigest: task.authorReceipt.actionDigest,
    expectedTaskId: task.authorReceipt.createdTaskId,
    expectedHostId: task.authorReceipt.hostId!,
    expectedRawTerminalToolResultDigest: task.authorReceipt.rawTerminalToolResultDigest,
  });
  const initialParticipantIds = preAuthorState.participants
    .map((participant) => String(participant.participantId)).sort();
  const closingParticipantIds = closingState.participants
    .map((participant) => String(participant.participantId)).sort();
  const addedParticipants = closingState.participants.filter(
    (participant) => !initialParticipantIds.includes(String(participant.participantId)),
  );
  const retainedAuthorSession = trace.authorSessionMarker;
  const authoritativeSessionCandidate = retainedAuthorSession === null
    && addedParticipants.length === 1
    && addedParticipants[0]!.displayName === EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME
    && addedParticipants[0]!.role === "participant"
    ? addedParticipants[0]!
    : null;
  if (retainedAuthorSession === null && authoritativeSessionCandidate === null) {
    throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_RESULT_UNOBSERVABLE_WITHOUT_AUTHORITY_DELTA");
  }
  const authorSession = retainedAuthorSession ?? {
    participantId: String(authoritativeSessionCandidate!.participantId),
    displayName: EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME,
    role: "participant" as const,
    roomId: String(closingState.room.id),
    roomCode: String(closingState.room.code),
    participantIds: Object.freeze([...closingParticipantIds]),
    joinResultDigest: null,
    collaborationResultDigest: null,
  };
  const sessionBindingMethod = retainedAuthorSession === null
    ? "authoritative_participant_delta" as const
    : "retained_result_marker" as const;
  const expectedClosingParticipantIds = [...initialParticipantIds, authorSession.participantId].sort();
  const closingAuthor = closingState.participants.find(
    (participant) => participant.participantId === authorSession.participantId,
  );
  if (preAuthorState.room.id !== task.room.roomId || closingState.room.id !== task.room.roomId
      || preAuthorState.room.code !== authorSession.roomCode || closingState.room.code !== authorSession.roomCode
      || authorSession.roomId !== task.room.roomId
      || preAuthorState.room.roomRevision !== task.room.initialRoomRevision
      || preAuthorState.objects.length !== task.room.initialObjectCount
      || preAuthorState.room.selfParticipantId !== closingState.room.selfParticipantId
      || initialParticipantIds.includes(authorSession.participantId)
      || (retainedAuthorSession !== null
        && canonicalJson(authorSession.participantIds as unknown as JsonValue)
          !== canonicalJson(expectedClosingParticipantIds as unknown as JsonValue))
      || canonicalJson(closingParticipantIds as unknown as JsonValue)
        !== canonicalJson(expectedClosingParticipantIds as unknown as JsonValue)
      || closingAuthor?.displayName !== EXP0001A_QUALIFICATION_V2_AUTHOR_DISPLAY_NAME
      || closingAuthor.role !== "participant") {
    throw new Error("QUALIFICATION_V2_AUTHOR_SESSION_AUTHORITY_BINDING_INVALID");
  }
  const authoritativeSessionBindingDigest = hashCanonicalJson({
    roomId: task.room.roomId,
    controllerParticipantId: preAuthorState.room.selfParticipantId,
    initialParticipantIds,
    closingParticipantIds,
    authorParticipantId: authorSession.participantId,
    authorDisplayName: authorSession.displayName,
    authorRole: authorSession.role,
    sessionBindingMethod,
  } as unknown as JsonValue);
  const attributedMutations = deriveAttributedMutationSet(
    preAuthorState,
    closingState,
    authorSession.participantId,
  );
  const appliedMutationProofs = trace.mutationProofs.filter((proof) => proof.outcome === "applied");
  const provenObjectIds = [...new Set(appliedMutationProofs.flatMap((proof) => proof.changedObjectIds))].sort();
  const provenDiagramIds = [...new Set(appliedMutationProofs.flatMap((proof) => proof.changedDiagramIds))].sort();
  const attributedObjectIds = attributedMutations
    .filter((change) => change.entityKind === "object").map((change) => String(change.id)).sort();
  const attributedDiagramIds = attributedMutations
    .filter((change) => change.entityKind === "diagram").map((change) => String(change.id)).sort();
  const mutationProofRevisionInvalid = appliedMutationProofs.some((proof) => proof.roomRevision === null
        || proof.roomRevision <= task.room!.initialRoomRevision
        || proof.roomRevision > Number(room.roomRevision));
  const proofIdsAreSubset = provenObjectIds.every((id) => attributedObjectIds.includes(id))
    && provenDiagramIds.every((id) => attributedDiagramIds.includes(id));
  const observedMutationProofsInvalid = trace.unobservableMutationProgramEvents.length === 0
    && (appliedMutationProofs.length < 1
      || canonicalJson(provenObjectIds as unknown as JsonValue)
        !== canonicalJson(attributedObjectIds as unknown as JsonValue)
      || canonicalJson(provenDiagramIds as unknown as JsonValue)
        !== canonicalJson(attributedDiagramIds as unknown as JsonValue));
  if (trace.mutationProgramEvents.length < 1 || mutationProofRevisionInvalid
      || !proofIdsAreSubset || observedMutationProofsInvalid) {
    throw new Error("QUALIFICATION_V2_AUTHOR_MUTATION_PROOF_ATTRIBUTION_MISMATCH");
  }
  const expectedRoomUrl = `https://www.jazzboard.xyz/room/${encodeURIComponent(task.room.roomId)}`;
  const closingCanvasStateDigest = canonicalCanvasStateDigest(roomRead.result as unknown as Record<string, unknown>);
  const qualifyingVisualInspections = trace.visualMarkers.filter((marker) => (
    marker.eventIndex > trace.lastMutationEventIndex
    && marker.roomId === task.room!.roomId
    && marker.roomRevision === room.roomRevision
    && marker.roomUrl === expectedRoomUrl
    && marker.canvasStateDigest === closingCanvasStateDigest
    && marker.inspectionRevisionSetDigest === explicitCoverage.fullSetDigest
  ));
  const qualifyingVisualPrograms = trace.unobservableVisualProgramEvents.filter(
    (eventIndex) => eventIndex > trace.lastMutationEventIndex,
  );
  const visualProofMethod = qualifyingVisualInspections.length > 0
    ? "retained_result_marker" as const
    : "completed_bound_program_plus_controller_capture" as const;
  const authoritativeMutationConfirmed = room.roomRevision > task.room.initialRoomRevision
    && trace.mutationToolMentioned
    && (task.room.initialStateKind !== "blank" || semanticState.objects.length > 0);
  if (!authoritativeMutationConfirmed
      || (qualifyingVisualInspections.length < 1
        && (trace.unobservableVisualProgramEvents.length < 1
          || qualifyingVisualPrograms.length < 1))) {
    throw new Error("QUALIFICATION_V2_AUTHOR_EVIDENCE_ACTIVITY_INSUFFICIENT");
  }
  const visualProofDigest = hashCanonicalJson((visualProofMethod === "retained_result_marker"
    ? qualifyingVisualInspections.map((marker) => ({
      eventIndex: marker.eventIndex,
      roomId: marker.roomId,
      roomRevision: marker.roomRevision,
      roomUrl: marker.roomUrl,
      canvasStateDigest: marker.canvasStateDigest,
      inspectionResultDigest: marker.inspectionResultDigest,
      inspectionRevisionSetDigest: marker.inspectionRevisionSetDigest,
    }))
    : [{
      completedBoundProgramEventIndexes: qualifyingVisualPrograms,
      closingCanvasStateDigest,
      controllerInspectionDigest: inspection.rawDigest,
      controllerPngDigest: sha256Digest(pngExport.pngBytes),
      roomRevision: room.roomRevision,
    }]) as unknown as JsonValue);
  const leaves = [
    trace.webMcpTraceDigest,
    hashCanonicalJson({
      participantId: authorSession.participantId,
      displayName: authorSession.displayName,
      role: authorSession.role,
      joinResultDigest: authorSession.joinResultDigest,
      collaborationResultDigest: authorSession.collaborationResultDigest,
      authoritativeSessionBindingDigest,
    }),
    preAuthorRoomRead.rawDigest,
    roomRead.rawDigest,
    sha256Digest(pngExport.pngBytes),
    hashCanonicalJson(semanticState as unknown as JsonValue),
    task.authorReceipt.terminalResultDigest,
    hashCanonicalJson(attributedMutations as unknown as JsonValue),
    inspection.rawDigest,
    visualProofDigest,
  ];
  const authorSessionIdentity = {
    participantId: authorSession.participantId,
    displayName: authorSession.displayName,
    role: authorSession.role,
    joinResultDigest: authorSession.joinResultDigest,
    collaborationResultDigest: authorSession.collaborationResultDigest,
    authoritativeSessionBindingDigest,
    bindingDigest: leaves[1],
  };
  const evidence = sealQualificationV2AuthorEvidence({
    schemaVersion: "exp-0001a-qualification-author-evidence/v2",
    taskId: task.taskId,
    authorTaskId: task.authorReceipt.createdTaskId,
    roomId: task.room.roomId,
    authorOutcome: "completed",
    authorSessionIdentity,
    webMcpDiscovered: true,
    webMcpTraceDigest: leaves[0],
    webMcpCallCount: trace.webMcpCallCount,
    webMcpFailureCount: trace.webMcpFailureCount,
    nestedWebMcpResultObservation: trace.nestedWebMcpResultObservation,
    sessionBindingMethod,
    visualProofMethod,
    // The independently captured authoritative revision delta proves at least
    // one committed mutation without trusting the author's final prose or the
    // outer JavaScript status. It does not claim a per-call success count.
    successfulAuthoritativeMutationCount: trace.unobservableMutationProgramEvents.length === 0
      ? appliedMutationProofs.length
      : 1,
    // inspect_canvas_scope truthfully says its JSON did not inspect pixels;
    // only an exact retained screenshot+emitImage result counts here.
    visualInspectionCount: visualProofMethod === "retained_result_marker"
      ? qualifyingVisualInspections.length
      : qualifyingVisualPrograms.length,
    preAuthoritativeReadDigest: leaves[2],
    closingAuthoritativeReadDigest: leaves[3],
    finalAuthoritativeRoomRevision: room.roomRevision,
    revisionMatchedPngDigest: leaves[4],
    pngRoomRevision: room.roomRevision,
    sanitizedSemanticStateDigest: leaves[5],
    semanticStateRoomRevision: room.roomRevision,
    terminalResultDigest: leaves[6],
    attributedMutationSetDigest: leaves[7],
    controllerInspectionDigest: leaves[8],
    visualProofDigest: leaves[9],
    criticalBoundaryViolations: [],
    evidenceRoot: hashCanonicalJson(leaves),
    retainedAt: input.retainedAt,
  });
  return Object.freeze({
    evidence,
    sanitizedSemanticState: semanticState,
    exactRevisionPngBytes: Buffer.from(pngExport.pngBytes),
    retainedSourceDigests: Object.freeze({
      roomReadCallResult: roomRead.rawDigest,
      preAuthorRoomReadCallResult: preAuthorRoomRead.rawDigest,
      inspectionCallResult: inspection.rawDigest,
      pngExportCallResult: pngExport.rawDigest,
    }),
  });
}

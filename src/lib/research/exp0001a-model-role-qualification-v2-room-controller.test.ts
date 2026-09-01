import { describe, expect, it } from "vitest";

import developmentBenchmarkJson from "../../../research/benchmarks/development-v2.json";
import developmentFixtureSpecsJson from "../../../research/benchmarks/development-fixture-specs-v2.json";
import developmentRubricsJson from "../../../research/benchmarks/development-evaluator-rubrics-v2.json";
import baselineReceiptV3Json from "../../../research/data/baseline-freeze-v3.json";
import productionBindingV3Json from "../../../research/data/exp0001a-model-role-qualification-launch-binding-v3.json";
import {
  compileBenchmarkTaskExecution,
  parseBenchmarkExecutionBundle,
} from "./benchmark-execution";
import { canonicalJson, hashCanonicalJson, type JsonValue } from "./provenance-crypto";
import { qualificationV2RoomControllerInternalsForTesting as controller } from "./exp0001a-model-role-qualification-v2-room-controller";
import {
  sealQualificationV2CaptureAuthorization,
  sealQualificationV2CaptureReleaseJournal,
} from "./exp0001a-model-role-qualification-v2-room-controller-receipts";

const descriptor = (name: string) => ({
  name,
  title: `${name} title`,
  description: `${name} description`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
});

describe("EXP-0001A qualification-v2 room controller", () => {
  it("builds an order-independent, exact semantic tool contract", () => {
    const first = controller.toolContract([descriptor("beta"), descriptor("alpha")]);
    const second = controller.toolContract([descriptor("alpha"), descriptor("beta")]);
    expect(first).toEqual(second);
    expect(first.descriptors.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(() => controller.assertFrozenToolContract(first, second, "TEST")).not.toThrow();
    expect(() => controller.assertFrozenToolContract(
      controller.toolContract([descriptor("alpha")]),
      second,
      "TEST",
    )).toThrow("QUALIFICATION_V2_TEST_TOOL_CONTRACT_DRIFT");
  });

  it("wraps exact browser WebMCP evidence without changing its semantic result", () => {
    const result = { ok: true, tool: "read_room_state", data: { room: { id: "room_test", roomRevision: 3 } } };
    const wrapped = controller.asCallToolResult(result);
    expect(wrapped.isError).toBe(false);
    expect(wrapped.content).toHaveLength(1);
    const text = wrapped.content[0]?.type === "text" ? wrapped.content[0].text : undefined;
    expect(text).toBeDefined();
    expect(JSON.parse(text!)).toEqual(JSON.parse(canonicalJson(result)));
  });

  it("fails capture closed when executable harness provenance changed after provisioning", () => {
    const provenance = {
      controllerBundleDigest: `sha256:${"1".repeat(64)}`,
      wrapperSourceDigest: `sha256:${"2".repeat(64)}`,
      dependencyLockfileDigest: `sha256:${"3".repeat(64)}`,
      gitCommit: "4".repeat(40),
      gitTree: "5".repeat(40),
      worktreeClean: true as const,
    };
    const provision = {
      schemaVersion: "exp-0001a-qualification-room-controller-provision/v3",
      taskId: "dev-architecture-create-checkout",
      roomReceiptDigest: `sha256:${"6".repeat(64)}`,
      storageStateDigest: `sha256:${"7".repeat(64)}`,
      productionBindingDigest: productionBindingV3Json.bindingDigest,
      baselineFreezeDigest: baselineReceiptV3Json.receiptDigest,
      harnessRuntimeProvenance: provenance,
    };
    const room = {
      taskId: provision.taskId,
      receiptDigest: provision.roomReceiptDigest,
    };
    expect(() => controller.assertCaptureProvisionBinding(
      provision,
      room,
      provision.storageStateDigest,
      provenance,
    )).not.toThrow();
    expect(() => controller.assertCaptureProvisionBinding(
      provision,
      room,
      provision.storageStateDigest,
      { ...provenance, wrapperSourceDigest: `sha256:${"8".repeat(64)}` },
    )).toThrow("QUALIFICATION_V2_CAPTURE_PROVISION_BINDING_MISMATCH");
  });

  it("consumes the exact coordinator-minted capture acknowledgement and rejects substitutions", () => {
    const request = {
      operation: "capture_author_evidence" as const,
      roomReceiptPath: "/private/tmp/room.json",
      provisionControllerReceiptPath: "/private/tmp/provision.json",
      storageStatePath: "/private/tmp/storage.json",
      outputDirectory: "/private/tmp/capture",
      at: "2026-08-31T20:00:00.000Z",
    };
    const authorization = sealQualificationV2CaptureAuthorization({
      schemaVersion: "exp-0001a-qualification-capture-authorization/v2",
      taskId: "dev-architecture-create-checkout",
      roomReceiptDigest: `sha256:${"1".repeat(64)}`,
      provisionControllerReceiptDigest: `sha256:${"2".repeat(64)}`,
      storageStateDigest: `sha256:${"3".repeat(64)}`,
      captureNonce: `sha256:${"4".repeat(64)}`,
      request,
      requestBindingDigest: hashCanonicalJson(request as unknown as JsonValue),
      preparedAt: "2026-08-31T20:00:00.000Z",
    });
    const journal = sealQualificationV2CaptureReleaseJournal({
      schemaVersion: "exp-0001a-qualification-capture-release-journal/v2",
      captureActionDigest: authorization.actionDigest,
      captureNonce: authorization.captureNonce,
      requestBindingDigest: authorization.requestBindingDigest,
      invokedAt: "2026-08-31T20:00:01.000Z",
      invocationOrdinal: 1,
      retryPermitted: false,
    });
    expect(() => controller.assertCaptureDispatchBinding(authorization, journal, request)).not.toThrow();
    expect(() => controller.assertCaptureDispatchBinding(
      authorization,
      { ...journal, captureNonce: `sha256:${"5".repeat(64)}` },
      request,
    )).toThrow("QUALIFICATION_V2_CAPTURE_AUTHORIZATION_REQUEST_BINDING_INVALID");
    expect(() => controller.assertCaptureDispatchBinding(
      authorization,
      journal,
      { ...request, outputDirectory: "/private/tmp/other-capture" },
    )).toThrow("QUALIFICATION_V2_CAPTURE_AUTHORIZATION_REQUEST_BINDING_INVALID");
  });

  it("derives a deterministic exhaustive exact-revision scope", () => {
    expect(controller.exactObjectScope([
      { id: "object_z", revision: 9 },
      { id: "object_a", revision: 2 },
    ])).toEqual({
      kind: "objects",
      targets: [
        { objectId: "object_a", expectedRevision: 2 },
        { objectId: "object_z", expectedRevision: 9 },
      ],
    });
    expect(() => controller.exactObjectScope([{ id: "object_a", revision: 0 }])).toThrow(
      "QUALIFICATION_V2_EVIDENCE_OBJECT_TARGET_INVALID",
    );
    const targets = [
      { objectId: "object_a", expectedRevision: 2 },
      { objectId: "object_z", expectedRevision: 9 },
    ];
    expect(() => controller.assertExactRevisionList([
      { objectId: "object_z", revision: 9 },
      { objectId: "object_a", revision: 2 },
    ], targets, "TEST")).not.toThrow();
    expect(() => controller.assertExactRevisionList([
      { objectId: "object_a", revision: 2 },
    ], targets, "TEST")).toThrow("QUALIFICATION_V2_TEST_REVISIONS_MISMATCH");

    const manyTargets = Array.from({ length: 65 }, (_, index) => ({
      objectId: `object_${String(index).padStart(2, "0")}`,
      expectedRevision: index + 1,
    }));
    const exactRevisions = manyTargets.map((target) => ({
      objectId: target.objectId,
      revision: target.expectedRevision,
    }));
    expect(() => controller.assertExactInspectionSceneContext({
      sceneContext: {
        schemaVersion: 2,
        scope: { kind: "objects" },
        revisions: {
          roomRevision: 72,
          explicitObjectRevisions: exactRevisions.slice(0, 64),
          explicitObjectRevisionCoverage: {
            totalCount: 65,
            returnedCount: 64,
            omittedCount: 1,
            limit: 64,
            truncated: true,
            fullSetDigest: controller.stableFNV1aDigest(exactRevisions),
          },
        },
        coverage: {
          scopeObjectCount: 65,
          visualContributorCount: 65,
          allExplicitTargetsRepresented: true,
        },
      },
    }, manyTargets, 72)).not.toThrow();
  });

  it("validates every compiled fixture object and first-class Diagram separately", () => {
    const bundle = parseBenchmarkExecutionBundle(
      developmentBenchmarkJson,
      developmentRubricsJson,
      developmentFixtureSpecsJson,
    );
    const execution = compileBenchmarkTaskExecution(bundle, "dev-architecture-edit-uncertainty");
    const setup = execution.trustedCoordinator.preBriefSetup;
    expect(setup).not.toBeNull();
    if (setup === null) throw new Error("Fixture unexpectedly missing.");

    const refs = Object.fromEntries(setup.input.operations
      .filter((operation) => "tempRef" in operation)
      .map((operation, index) => [operation.tempRef, `semantic_${index}`]));
    const resolve = (reference: { tempRef: string } | { objectId: string }) => (
      "tempRef" in reference ? refs[reference.tempRef] : reference.objectId
    );
    const records = setup.input.operations.map((operation): Record<string, unknown> => {
      if (!("tempRef" in operation)) throw new Error("Unexpected fixture update.");
      const base = {
        id: refs[operation.tempRef],
        revision: 1,
        ...( "semanticName" in operation ? { semanticName: operation.semanticName } : {}),
        ...( "semanticRole" in operation ? { semanticRole: operation.semanticRole } : {}),
      };
      if (operation.op === "create_diagram") return {
        ...base,
        title: operation.title,
        description: operation.description,
        diagramType: operation.diagramType,
        category: operation.category,
        tags: operation.tags,
        memberObjectIds: operation.members.map(resolve),
        connectorIds: operation.connectors.map(resolve),
      };
      if (operation.op === "create_node") return {
        ...base, kind: "shape", shape: "rectangle", label: operation.label, nodeType: operation.nodeType,
        x: operation.x, y: operation.y, width: operation.width, height: operation.height, zIndex: operation.zIndex,
      };
      if (operation.op === "create_shape") return {
        ...base, kind: "shape", shape: operation.shape, label: operation.label,
        fill: operation.fill, stroke: operation.stroke,
        x: operation.x, y: operation.y, width: operation.width, height: operation.height, zIndex: operation.zIndex,
      };
      if (operation.op === "create_text") return {
        ...base, kind: "text", content: operation.content, color: operation.color,
        size: operation.size, align: operation.align,
        x: operation.x, y: operation.y, width: operation.width, height: operation.height, zIndex: operation.zIndex,
      };
      if (operation.op === "connect") return {
        ...base, kind: "connector", start: { objectId: resolve(operation.start) },
        end: { objectId: resolve(operation.end) }, routing: operation.routing,
        direction: operation.direction, label: operation.label, color: operation.color,
      };
      if (operation.op === "create_drawing") return {
        ...base, kind: "draw", color: operation.color, size: operation.size,
        rotation: operation.rotation, zIndex: operation.zIndex, groupId: operation.groupId,
      };
      return {
        ...base, kind: "path", fill: operation.fill, stroke: operation.stroke,
        strokeWidth: operation.strokeWidth, opacity: operation.opacity, lineCap: operation.lineCap,
        lineJoin: operation.lineJoin, fillRule: operation.fillRule, rotation: operation.rotation,
        zIndex: operation.zIndex, groupId: operation.groupId,
      };
    });
    const objects = records.filter((record) => record.kind !== undefined);
    const diagrams = records.filter((record) => record.kind === undefined);
    for (const object of objects) object.diagramIds = [];
    for (const operation of setup.input.operations) {
      if (operation.op !== "create_diagram") continue;
      const diagramId = refs[operation.tempRef];
      for (const reference of [...operation.members, ...operation.connectors]) {
        const object = objects.find((candidate) => candidate.id === resolve(reference));
        if (!object || !Array.isArray(object.diagramIds)) throw new Error("Fixture membership test setup failed.");
        object.diagramIds.push(diagramId);
      }
    }
    const participant = { participantId: "participant_controller", displayName: "Qualification Controller", role: "participant" };
    const transaction = {
      ok: true,
      tool: setup.toolName,
      data: {
        outcome: "applied",
        roomRevision: 7,
        temporaryReferences: refs,
        changedObjectIds: objects.map((record) => record.id),
        changedDiagramIds: diagrams.map((record) => record.id),
        objects,
        diagrams,
      },
    };
    const state = {
      ok: true,
      tool: "read_room_state",
      data: {
        room: {
          id: "room_fixture", code: "ABC234", title: "Qualification workspace",
          selfParticipantId: participant.participantId, roomRevision: 7,
        },
        objects,
        diagrams,
        participants: [participant],
      },
    };
    const blank = {
      ok: true,
      tool: "read_room_state",
      data: {
        room: { ...state.data.room, roomRevision: 6 },
        objects: [],
        diagrams: [],
        participants: [participant],
      },
    };

    expect(() => controller.verifyCompiledFixture(
      "dev-architecture-edit-uncertainty",
      transaction,
      state,
      blank,
    )).not.toThrow();

    expect(() => controller.verifyCompiledFixture(
      "dev-architecture-edit-uncertainty",
      transaction,
      { ...state, data: { ...state.data, diagrams: [] } },
      blank,
    )).toThrow("QUALIFICATION_V2_FIXTURE_DIAGRAM_COUNT_MISMATCH");
  });
});

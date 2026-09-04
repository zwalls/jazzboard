// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { applySemanticTransaction, normalizeRoomSemanticState } from "@/lib/domain/engine";
import type { Participant, RoomState } from "@/lib/domain/types";
import { createJazzboardSemanticWebMcpTools } from "@/lib/webmcp/semantic-tools";
import type { JazzboardToolResult, JazzboardWebMcpBinding, WebMcpRequest } from "@/lib/webmcp/types";

const packetPath: string = "./exp0036-frozen-packet.mjs";
const fixturePath: string = "./exp0035-context-fixture.mjs";
const {
  createExp0036FrozenPacketBundle,
  createExp0036BlindedReviewPacket,
  createExp0036ArtifactMetadata,
  createExp0036ProvisioningFixture,
  gradeExp0036ContextFixture,
  renderExp0036AuthorPrompt,
  validateExp0036PairReviewResult,
} = await import(packetPath);
const { createExp0035ContextFixture } = await import(fixturePath);

const NOW = 36_000_000;

function participant(): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId: "controller",
    displayName: "Controller",
    color: "blue",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

function fixtureHarness() {
  let room = normalizeRoomSemanticState({
    id: "exp0036-room",
    code: "X0036A",
    title: "EXP-0036 frozen fixture",
    roomRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { controller: participant() },
    objects: {},
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  });
  let createIndex = 0;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "GET") return { room };
    const body = JSON.parse(String(init?.body)) as {
      transaction: Parameters<typeof applySemanticTransaction>[3];
    };
    const result = applySemanticTransaction(room, "controller", "agent", body.transaction, NOW + room.roomRevision);
    room = result.room;
    return { ok: true, outcome: "applied", ...result, activity: null, proposal: null };
  }) as unknown as WebMcpRequest;
  const binding: JazzboardWebMcpBinding = {
    roomId: room.id,
    participantId: "controller",
    role: "participant",
    context: {
      getRoom: () => room,
      getSelection: () => [],
      getViewport: () => null,
      getFollowTarget: () => null,
      acceptRoom: (next) => { room = next; },
      setFollowTarget: () => {},
      setDeclinedSpotlight: () => {},
      leaveRoomView: () => {},
    },
  };
  const tool = createJazzboardSemanticWebMcpTools(binding, {
    request,
    createId: (prefix) => `${prefix}_exp0036_${++createIndex}`,
  }).find((candidate) => candidate.name === "apply_canvas_transaction");
  if (!tool) throw new Error("Missing apply_canvas_transaction.");
  return {
    getRoom: () => structuredClone(room),
    async apply(input: Record<string, unknown>) {
      return await tool.execute(input, { signal: new AbortController().signal }) as JazzboardToolResult;
    },
  };
}

async function compiledContext(family: "inventory" | "repair", seed: string) {
  const fixture = createExp0035ContextFixture({
    family,
    seed,
  });
  const harness = fixtureHarness();
  for (const transaction of fixture.provisioning.transactions) {
    expect(await harness.apply(transaction)).toMatchObject({ ok: true });
  }
  return { fixture, room: harness.getRoom() };
}

async function compiledInventory() {
  return await compiledContext("inventory", "20260904-exp0036-inventory-2");
}

function roomForReview(roomRevision: number) {
  return {
    id: "private-room-id",
    code: "SECRET",
    roomRevision,
    participants: { author: { displayName: "Condition A1 author" } },
    createdAt: 1,
    updatedAt: 2,
    objects: {
      shape1: {
        id: "shape1",
        kind: "shape",
        semanticName: "Checkout API",
        semanticRole: "architecture.service",
        x: 10,
        y: 20,
        width: 180,
        height: 80,
        rotation: 0,
        zIndex: 1,
        revision: 3,
        groupId: null,
        diagramIds: ["diagram1"],
        createdAt: 1,
        updatedAt: 2,
        createdBy: { participantId: "private-author", actorKind: "agent" },
        lastEditedBy: { participantId: "private-author", actorKind: "agent" },
        shape: "rectangle",
        nodeType: "service",
        label: "Checkout API",
        fill: "blue",
        stroke: "black",
      },
    },
    diagrams: {
      diagram1: {
        id: "diagram1",
        title: "Checkout",
        description: "Public task artifact",
        diagramType: "architecture",
        category: "service",
        tags: [],
        memberObjectIds: ["shape1"],
        connectorIds: [],
        bounds: { x: 10, y: 20, width: 180, height: 80 },
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
        createdBy: { participantId: "private-author", actorKind: "agent" },
        lastEditedBy: { participantId: "private-author", actorKind: "agent" },
      },
    },
  };
}

describe("EXP-0036 frozen packet and grader manifest", () => {
  it("freezes the exact eight-attempt order and exact build identities", () => {
    const { graderManifest } = createExp0036FrozenPacketBundle();
    expect(graderManifest.builds).toMatchObject({
      A0: { role: "baseline", commit: "f7762da4ea7d1603671a35b4912143c4bff83f34" },
      A1: { role: "candidate", commit: "5a67b21505b50c643bf282774f0e7bf4698edf05" },
    });
    expect(graderManifest.fixedAttemptOrder.map((item: { attemptId: string; arm: string }) => [
      item.attemptId, item.arm,
    ])).toEqual([
      ["attempt01", "A0"], ["attempt02", "A1"],
      ["attempt03", "A1"], ["attempt04", "A0"],
      ["attempt05", "A1"], ["attempt06", "A0"],
      ["attempt07", "A0"], ["attempt08", "A1"],
    ]);
    expect(graderManifest.deterministicSeeds).toEqual({
      inventory: "20260904-exp0036-inventory-2",
      metadataEdit: "20260904-exp0036-repair-2",
    });
    const inventory = createExp0036ProvisioningFixture("exp0036-existing-inventory");
    expect(inventory).toMatchObject({
      schemaVersion: "jazzboard-exp0036-context-fixture/v1",
      protocolId: "EXP-0036",
      family: "inventory",
      seed: "20260904-exp0036-inventory-2",
    });
    expect(JSON.stringify(inventory.provisioning)).not.toContain("expectedAnswer");
  });

  it("copies the complete public development-v2 creation packets and complete matching rubrics", () => {
    const benchmark = JSON.parse(readFileSync("research/benchmarks/development-v2.json", "utf8"));
    const rubrics = JSON.parse(readFileSync("research/benchmarks/development-evaluator-rubrics-v2.json", "utf8"));
    const { authorManifest, graderManifest } = createExp0036FrozenPacketBundle();
    for (const taskId of ["dev-architecture-create-checkout", "dev-drawing-create-layered-portrait"]) {
      expect(authorManifest.taskPackets.find((item: { id: string }) => item.id === taskId))
        .toEqual(benchmark.tasks.find((item: { id: string }) => item.id === taskId));
      expect(graderManifest.creationGraders[taskId])
        .toEqual(rubrics.rubrics.find((item: { taskId: string }) => item.taskId === taskId));
    }
  });

  it("keeps controller answers, arm identities, commits, and review mappings out of author packets", () => {
    const { authorManifest, graderManifest } = createExp0036FrozenPacketBundle();
    const authorJson = JSON.stringify(authorManifest);
    const firstPrivateName = graderManifest.contextGraders["exp0036-existing-inventory"]
      .expectedAnswer.openQuestionNames[0];
    expect(authorJson).not.toContain(firstPrivateName);
    expect(authorJson).not.toContain("expectedAnswer");
    expect(authorJson).not.toContain("f7762da4ea7d1603671a35b4912143c4bff83f34");
    expect(authorJson).not.toContain("5a67b21505b50c643bf282774f0e7bf4698edf05");
    expect(authorJson).not.toContain("checkout-kestrel");
    expect(authorManifest.attempts.every((item: Record<string, unknown>) => !("arm" in item))).toBe(true);
    expect(authorManifest.status).toBe("prepared_not_authorized");
  });

  it("renders only a unique-host room prompt and never embeds credentials in the frozen packet", () => {
    const { authorManifest } = createExp0036FrozenPacketBundle();
    const attempt = authorManifest.attempts[0];
    expect(attempt.promptTemplate).toContain("{{ORIGIN}}");
    expect(attempt.promptTemplate).toContain("{{ROOM_CODE}}");
    const rendered = renderExp0036AuthorPrompt({
      attempt,
      origin: "http://exp0036-attempt01-cafe.localhost:3103",
      roomCode: "ABC234",
    });
    expect(rendered).toContain("http://exp0036-attempt01-cafe.localhost:3103/");
    expect(rendered).toContain("ABC234");
    expect(() => renderExp0036AuthorPrompt({ attempt, origin: "http://127.0.0.1:3103", roomCode: "ABC234" }))
      .toThrow(/invalid/i);
  });

  it("accepts omitted or exact-zero absent kinds while keeping every other inventory fact strict", async () => {
    const { fixture, room } = await compiledInventory();
    const answer = structuredClone(fixture.controller.expectedAnswer);
    const omitted = gradeExp0036ContextFixture({
      family: "inventory", beforeRoom: room, afterRoom: structuredClone(room), finalAnswer: answer,
    });
    expect(omitted).toMatchObject({ passed: true, policy: "absent_supported_kinds_may_be_omitted_or_zero" });

    const explicitZero = structuredClone(answer);
    Object.assign(explicitZero.objectCounts, { connector: 0, image: 0, draw: 0 });
    expect(gradeExp0036ContextFixture({
      family: "inventory", beforeRoom: room, afterRoom: structuredClone(room), finalAnswer: explicitZero,
    })).toMatchObject({ passed: true });

    const nonzeroAbsent = structuredClone(explicitZero);
    nonzeroAbsent.objectCounts.connector = 1;
    expect(gradeExp0036ContextFixture({
      family: "inventory", beforeRoom: room, afterRoom: structuredClone(room), finalAnswer: nonzeroAbsent,
    })).toMatchObject({ passed: false });

    const unknownKind = structuredClone(explicitZero);
    unknownKind.objectCounts.frame = 0;
    expect(gradeExp0036ContextFixture({
      family: "inventory", beforeRoom: room, afterRoom: structuredClone(room), finalAnswer: unknownKind,
    })).toMatchObject({ passed: false });

    const mutated = structuredClone(room) as RoomState;
    Object.values(mutated.objects)[0]!.x += 1;
    expect(gradeExp0036ContextFixture({
      family: "inventory", beforeRoom: room, afterRoom: mutated, finalAnswer: explicitZero,
    })).toMatchObject({ passed: false });
  }, 30_000);

  it("retains strict metadata-edit lifecycle, revision, and protected-state grading", async () => {
    const { fixture, room } = await compiledContext("repair", "20260904-exp0036-repair-2");
    const after = structuredClone(room) as RoomState;
    const targetNames = new Set(fixture.controller.expectedAnswer.updatedOpenQuestionNames);
    for (const object of Object.values(after.objects)) {
      if (!targetNames.has(object.semanticName)) continue;
      if (object.kind !== "shape") throw new Error("Expected a shape target.");
      if (object.nodeMetadata?.kind !== "open_question") {
        throw new Error("Expected open-question metadata.");
      }
      object.nodeMetadata = {
        ...object.nodeMetadata,
        status: "deferred",
        resolution: fixture.controller.invariants.targetResolution,
        resolvedAt: NOW + 1,
      };
      object.revision += 1;
    }
    expect(gradeExp0036ContextFixture({
      family: "repair",
      beforeRoom: room,
      afterRoom: after,
      finalAnswer: fixture.controller.expectedAnswer,
    })).toMatchObject({ passed: true, policy: "strict_repair" });

    const protectedMutation = structuredClone(after) as RoomState;
    const protectedObject = Object.values(protectedMutation.objects)
      .find((object) => !targetNames.has(object.semanticName));
    if (!protectedObject) throw new Error("Missing protected object.");
    protectedObject.x += 1;
    expect(gradeExp0036ContextFixture({
      family: "repair",
      beforeRoom: room,
      afterRoom: protectedMutation,
      finalAnswer: fixture.controller.expectedAnswer,
    })).toMatchObject({ passed: false });
  }, 30_000);

  it("freezes two independent reversed-display reviews per creation pair and an exact output contract", () => {
    const { graderManifest } = createExp0036FrozenPacketBundle();
    const assignments = graderManifest.blindedPairReview.assignments;
    expect(assignments).toHaveLength(4);
    for (const taskId of ["dev-architecture-create-checkout", "dev-drawing-create-layered-portrait"]) {
      const pair = assignments.filter((item: { taskId: string }) => item.taskId === taskId);
      expect(pair).toHaveLength(2);
      expect(pair[0].display.left.attemptId).toBe(pair[1].display.right.attemptId);
      expect(pair[0].display.right.attemptId).toBe(pair[1].display.left.attemptId);
    }
    const instructions = readFileSync(graderManifest.blindedPairReview.instructionsPath, "utf8");
    expect(instructions).toContain("jazzboard-exp0036-pair-review-result/v1");
    expect(instructions).toContain("Include every supplied criterion exactly once");
    expect(instructions).toContain("author transcript");
    expect(graderManifest.blindedPairReview.reviewerInputPolicy.exclude)
      .toEqual(expect.arrayContaining(["arm or condition", "timing", "room credential", "peer verdict"]));

    const assignment = assignments[0];
    const rubric = graderManifest.creationGraders[assignment.taskId];
    const result = {
      schemaVersion: "jazzboard-exp0036-pair-review-result/v1",
      reviewSlotId: assignment.reviewSlotId,
      taskId: assignment.taskId,
      artifacts: [
        [assignment.display.left.label, "left"],
        [assignment.display.right.label, "right"],
      ].map(([label, displaySide]) => ({
        label,
        displaySide,
        criteria: rubric.criteria.map((item: { criterionId: string }) => ({
          criterionId: item.criterionId,
          result: "pass",
          evidence: "Visible and supported in the supplied pixels and state.",
        })),
        hardGate: "pass",
        blockingDefects: [],
      })),
      preference: "tie",
      preferenceEvidence: "No meaningful supported visual advantage.",
    };
    expect(validateExp0036PairReviewResult(result, assignment, rubric)).toEqual({
      schemaVersion: "jazzboard-exp0036-pair-review-validation/v1",
      valid: true,
      reasons: [],
    });
    result.artifacts[0].label = "candidate";
    expect(validateExp0036PairReviewResult(result, assignment, rubric)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(["ARTIFACT_1_BINDING_INVALID"]),
    });

    const artifactMetadataByAttempt = Object.fromEntries([
      assignment.display.left.attemptId,
      assignment.display.right.attemptId,
    ].map((attemptId, index) => [attemptId, {
      ...createExp0036ArtifactMetadata({
        finalRevision: index + 7,
        finalState: {
          ...roomForReview(index + 7),
        },
        pixels: {
          revision: index + 7,
          mimeType: "image/png",
          width: 1600,
          height: 1000,
          sha256: `sha256:${String(index + 1).repeat(64)}`,
          attachmentReference: `attachment:checkout-review-1-${index === 0 ? "left" : "right"}`,
        },
      }),
    }]));
    const reviewPacket = createExp0036BlindedReviewPacket({
      reviewSlotId: assignment.reviewSlotId,
      artifactMetadataByAttempt,
    });
    const reviewJson = JSON.stringify(reviewPacket);
    expect(reviewPacket.artifacts.map((item: { label: string }) => item.label)).toEqual([
      assignment.display.left.label,
      assignment.display.right.label,
    ]);
    expect(reviewJson).not.toContain(assignment.display.left.attemptId);
    expect(reviewJson).not.toContain(assignment.display.right.attemptId);
    expect(reviewJson).not.toMatch(/\bA[01]\b|baseline|candidate/i);
    expect(JSON.stringify(reviewPacket.artifacts)).not.toMatch(
      /participants|createdAt|updatedAt|createdBy|lastEditedBy|roomId/,
    );
    expect(reviewPacket.artifacts[0].finalPixels).toMatchObject({
      attachmentReference: "attachment:checkout-review-1-left",
      revision: 7,
      width: 1600,
      height: 1000,
    });
    const tampered = structuredClone(artifactMetadataByAttempt);
    tampered[assignment.display.left.attemptId].pixels.revision += 1;
    expect(() => createExp0036BlindedReviewPacket({
      reviewSlotId: assignment.reviewSlotId,
      artifactMetadataByAttempt: tampered,
    })).toThrow(/invalid controller-prepared metadata/i);
  });

  it("matches the committed generated public and private manifests byte-for-byte", () => {
    const bundle = createExp0036FrozenPacketBundle();
    expect(readFileSync("research/data/exp-0036-author-packets-v1.json", "utf8"))
      .toBe(`${JSON.stringify(bundle.authorManifest, null, 2)}\n`);
    expect(readFileSync("research/data/exp-0036-grader-manifest-v1.json", "utf8"))
      .toBe(`${JSON.stringify(bundle.graderManifest, null, 2)}\n`);
  });
});

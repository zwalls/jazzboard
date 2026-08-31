import { describe, expect, it } from "vitest";

import historicalDevelopmentManifest from "../../../research/benchmarks/development-v1.json";
import historicalDevelopmentRubrics from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import historicalDevelopmentFixtureSpecs from "../../../research/benchmarks/development-fixture-specs-v1.json";
import developmentManifest from "../../../research/benchmarks/development-v2.json";
import developmentRubrics from "../../../research/benchmarks/development-evaluator-rubrics-v2.json";
import developmentFixtureSpecs from "../../../research/benchmarks/development-fixture-specs-v2.json";

import {
  CAPABILITY_NEUTRAL_AUTHOR_INSTRUCTIONS,
  DEVELOPMENT_EXECUTION_BUNDLE_DIGEST_V1,
  DEVELOPMENT_EXECUTION_BUNDLE_DIGEST_V2,
  benchmarkCommitments,
  canonicalSha256,
  compileBenchmarkExecution,
  compileBenchmarkTaskExecution,
  compileConcurrentEvent,
  compilePreBriefFixture,
  normalizedPointsToWorld,
  parseBenchmarkExecutionBundle,
  preflightFixtureSeedReadability,
  publicAuthorPacket,
  renderPublicAuthorBrief,
  type BenchmarkCanvasOperation,
} from "./benchmark-execution";

const bundle = parseBenchmarkExecutionBundle(
  developmentManifest,
  developmentRubrics,
  developmentFixtureSpecs,
);

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
}

function operationByTempRef(operations: readonly BenchmarkCanvasOperation[], tempRef: string) {
  return operations.find((operation) => "tempRef" in operation && operation.tempRef === tempRef);
}

describe("benchmark execution bundle boundary", () => {
  it("keeps the historical v1 bundle verifiable while selecting v2 prospectively", () => {
    const historical = parseBenchmarkExecutionBundle(
      historicalDevelopmentManifest,
      historicalDevelopmentRubrics,
      historicalDevelopmentFixtureSpecs,
    );
    expect(historical.benchmark.benchmarkId).toBe("jazzboard-development-v1");
    expect(canonicalSha256({
      benchmark: historicalDevelopmentManifest,
      rubrics: historicalDevelopmentRubrics,
      fixtureSpecs: historicalDevelopmentFixtureSpecs,
    })).toBe(DEVELOPMENT_EXECUTION_BUNDLE_DIGEST_V1);
    expect(canonicalSha256({
      benchmark: developmentManifest,
      rubrics: developmentRubrics,
      fixtureSpecs: developmentFixtureSpecs,
    })).toBe(DEVELOPMENT_EXECUTION_BUNDLE_DIGEST_V2);
  });

  it("strictly validates the three-file bundle before compilation", () => {
    expect(bundle.benchmark.tasks).toHaveLength(12);
    expect(bundle.fixtureSpecs.fixtures).toHaveLength(10);
    expect(bundle.fixtureSpecs.concurrentEvents).toHaveLength(2);

    const invalid = structuredClone(developmentManifest) as Record<string, unknown>;
    invalid.hiddenAnswer = "not allowed";
    expect(() => parseBenchmarkExecutionBundle(invalid, developmentRubrics, developmentFixtureSpecs)).toThrow();
  });

  it("compiles each of the 12 task strata with exactly one matching rubric", () => {
    const execution = compileBenchmarkExecution(
      developmentManifest,
      developmentRubrics,
      developmentFixtureSpecs,
    );
    expect(execution.tasks).toHaveLength(12);
    expect(new Set(execution.tasks.map((task) => task.taskId)).size).toBe(12);
    for (const task of execution.tasks) {
      expect(task.evaluator.rubric.taskId).toBe(task.taskId);
      expect(task.commitments).toEqual(execution.commitments.tasks[task.taskId]);
      expect(Object.keys(task.author.packet)).toEqual([
        "instructions",
        "brief",
        "publicTaskPacket",
        "acceptanceCriteria",
      ]);
    }
  });
});

describe("public author boundary", () => {
  it("is an exact projection of only public fields and capability-neutral instructions", () => {
    for (const task of bundle.benchmark.tasks) {
      const packet = publicAuthorPacket(task);
      expect(packet).toEqual({
        instructions: [...CAPABILITY_NEUTRAL_AUTHOR_INSTRUCTIONS],
        brief: task.brief,
        publicTaskPacket: task.publicTaskPacket,
        acceptanceCriteria: task.acceptanceCriteria,
      });
      expect(keysDeep(packet)).not.toEqual(expect.arrayContaining([
        "requiredCapabilities",
        "initialState",
        "concurrentEventFixtureId",
        "roomId",
        "roomCode",
        "sessionId",
        "rubric",
        "semanticReference",
        "drawingReference",
        "evaluatorProcedure",
        "passCondition",
        "geometryThresholds",
        "guardrails",
        "fixtureId",
        "eventFixtureId",
        "operations",
        "bounds",
        "x",
        "y",
        "zIndex",
        "issueTags",
        "nodeType",
      ]));
    }
  });

  it("renders only the exact public packet and contains no fixture/rubric identifiers", () => {
    for (const task of bundle.benchmark.tasks) {
      const packet = publicAuthorPacket(task);
      const rendered = renderPublicAuthorBrief(packet);
      expect(rendered).toContain(task.brief);
      for (const criterion of task.acceptanceCriteria) expect(rendered).toContain(criterion.text);
      for (const material of task.publicTaskPacket.materials) expect(rendered).toContain(material.content);
      expect(rendered).not.toMatch(/fixture-(?:architecture|drawing)-/);
      expect(rendered).not.toContain("evaluatorProcedure");
      expect(rendered).not.toContain("issueTags");
      expect(rendered).not.toContain("requiredCapabilities");
    }
  });

  it("does not mutate source manifests when callers mutate the author projection", () => {
    const task = bundle.benchmark.tasks[0]!;
    const packet = publicAuthorPacket(task);
    packet.acceptanceCriteria[0]!.text = "mutated external copy";
    expect(task.acceptanceCriteria[0]!.text).not.toBe("mutated external copy");
  });
});

describe("pre-brief fixture compiler", () => {
  it("compiles every one of the 10 retained/versioned setups to executable transaction vocabulary", () => {
    for (const fixture of bundle.fixtureSpecs.fixtures) {
      const plan = compilePreBriefFixture(fixture);
      expect(plan.toolName).toBe("apply_canvas_transaction");
      expect(plan.input.operations.length).toBeGreaterThan(0);
      expect(plan.input.responseDetail).toBe("detailed");
      expect(plan.requiredResolvedObjectRefs).toEqual([]);
      expect(JSON.stringify(plan.input)).not.toContain("issueTags");
      expect(JSON.stringify(plan.input)).not.toContain("issue_tags");

      const validOps = new Set([
        "create_node",
        "create_shape",
        "create_text",
        "create_drawing",
        "create_path",
        "create_polygon",
        "connect",
        "update",
        "create_diagram",
      ]);
      for (const operation of plan.input.operations) expect(validOps.has(operation.op)).toBe(true);

      const createdSourceOps = fixture.preBriefSetup.operations.filter((operation) => operation.type === "create_object");
      for (const source of createdSourceOps) {
        const tempRef = plan.tempRefBySemanticRef[source.objectRef]!;
        expect(tempRef).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
        const compiled = operationByTempRef(plan.input.operations, tempRef)!;
        expect(compiled).toMatchObject({
          semanticName: source.semanticName,
          semanticRole: source.semanticRole,
          zIndex: source.bounds.zIndex,
        });
        if (compiled.op === "create_node" || compiled.op === "create_shape" || compiled.op === "create_text") {
          expect(compiled).toMatchObject({
            x: source.bounds.x,
            y: source.bounds.y,
            width: source.bounds.width,
            height: source.bounds.height,
          });
        }
        if (source.objectKind === "path" || source.objectKind === "draw") {
          const expectedPoints = normalizedPointsToWorld(source.bounds, source.pathGeometry!.normalizedPoints);
          if (compiled.op === "create_polygon" || compiled.op === "create_drawing") {
            expect(compiled.points).toEqual(expectedPoints);
          } else if (compiled.op === "create_path") {
            expect([compiled.start, ...compiled.segments.map((segment) => segment.to)]).toEqual(expectedPoints);
          } else {
            throw new Error(`Expected vector operation for ${source.objectRef}`);
          }
        }
      }
    }
  });

  it("blocks author-brief compilation when a seed already violates undeclared renderer text criteria", () => {
    const historicalDefective = bundle.fixtureSpecs.fixtures.find(
      (fixture) => fixture.fixtureId === "fixture-architecture-primary-path-v1",
    )!;
    expect(() => preflightFixtureSeedReadability(historicalDefective)).toThrow(
      /FIXTURE_SEED_READABILITY_PREFLIGHT_FAILED:fixture-architecture-primary-path-v1:.*audit-sink:SHAPE_LABEL_LIKELY_TRUNCATED.*latency-note:TEXT_CONTENT_LIKELY_TRUNCATED/,
    );

    const releaseCandidate = structuredClone(bundle);
    const task = releaseCandidate.benchmark.tasks.find(
      (candidate) => candidate.id === "dev-architecture-edit-primary-path",
    )!;
    task.initialState = { kind: "fixture", fixtureId: historicalDefective.fixtureId };
    expect(() => compileBenchmarkTaskExecution(releaseCandidate, task.id)).toThrow(
      /FIXTURE_SEED_READABILITY_PREFLIGHT_FAILED/,
    );
  });

  it("passes the corrected versioned seed and binds its preflight to the task execution", () => {
    const corrected = bundle.fixtureSpecs.fixtures.find(
      (fixture) => fixture.fixtureId === "fixture-architecture-primary-path-v2",
    )!;
    const preflight = preflightFixtureSeedReadability(corrected);
    expect(preflight).toMatchObject({
      schemaVersion: 1,
      fixtureId: corrected.fixtureId,
      rendererContract: "jazzboard-semantic-text-layout/v1",
      status: "pass",
      intentionallyDeclaredFindingCount: 0,
      findings: [],
    });
    expect(preflight.receiptDigest).toBe(canonicalSha256({
      schemaVersion: preflight.schemaVersion,
      fixtureId: preflight.fixtureId,
      rendererContract: preflight.rendererContract,
      status: preflight.status,
      checkedObjectCount: preflight.checkedObjectCount,
      intentionallyDeclaredFindingCount: preflight.intentionallyDeclaredFindingCount,
      findings: preflight.findings,
    }));

    const execution = compileBenchmarkTaskExecution(bundle, "dev-architecture-edit-primary-path");
    expect(execution.trustedCoordinator.seedReadabilityPreflight).toEqual(preflight);
  });

  it("uses explicit architecture node classification and first-class Diagram membership", () => {
    for (const fixture of bundle.fixtureSpecs.fixtures.filter((candidate) => candidate.domain === "architecture")) {
      const plan = compilePreBriefFixture(fixture);
      const sourceNodes = fixture.preBriefSetup.operations.flatMap((operation) =>
        operation.type === "create_object" && operation.objectKind === "shape" && operation.nodeType !== null
          ? [operation]
          : []);
      for (const sourceNode of sourceNodes) {
        expect(operationByTempRef(plan.input.operations, plan.tempRefBySemanticRef[sourceNode.objectRef]!)).toMatchObject({
          op: "create_node",
          nodeType: sourceNode.nodeType,
          semanticName: sourceNode.semanticName,
          semanticRole: sourceNode.semanticRole,
        });
      }

      const diagram = plan.input.operations.find((operation) => operation.op === "create_diagram");
      expect(diagram).toMatchObject({
        op: "create_diagram",
        title: "Architecture fixture",
        description: "",
        diagramType: "architecture",
        category: "research_fixture",
        tags: [],
      });
      if (!diagram || diagram.op !== "create_diagram") throw new Error("missing Diagram");
      const objectRefs = fixture.preBriefSetup.operations
        .filter((operation) => operation.type === "create_object")
        .map((operation) => ({ tempRef: plan.tempRefBySemanticRef[operation.objectRef]! }));
      const connectorRefs = fixture.preBriefSetup.operations
        .filter((operation) => operation.type === "create_relationship")
        .map((operation) => ({ tempRef: plan.tempRefBySemanticRef[operation.relationshipRef]! }));
      expect(diagram.members).toEqual(objectRefs);
      expect(diagram.connectors).toEqual(connectorRefs);
    }
  });

  it("preserves relationship endpoint references, direction, and explicit routing", () => {
    for (const fixture of bundle.fixtureSpecs.fixtures) {
      const plan = compilePreBriefFixture(fixture);
      for (const relationship of fixture.preBriefSetup.operations.filter((operation) => operation.type === "create_relationship")) {
        const compiled = operationByTempRef(plan.input.operations, plan.tempRefBySemanticRef[relationship.relationshipRef]!);
        expect(compiled).toMatchObject({
          op: "connect",
          start: { tempRef: plan.tempRefBySemanticRef[relationship.fromObjectRef] },
          end: { tempRef: plan.tempRefBySemanticRef[relationship.toObjectRef] },
          direction: relationship.direction,
          label: relationship.label,
          semanticRole: "fixture_relationship",
        });
        if (!compiled || compiled.op !== "connect") throw new Error("missing connector");
        expect(compiled.routing.mode).toBe(relationship.routing);
      }
    }
  });

  it("converts normalized points to exact declared world coordinates", () => {
    expect(normalizedPointsToWorld(
      { x: -40, y: 25, width: 200, height: 80 },
      [{ x: 0, y: 0 }, { x: 0.25, y: 0.5 }, { x: 1, y: 1 }],
    )).toEqual([
      { x: -40, y: 25 },
      { x: 10, y: 65 },
      { x: 160, y: 105 },
    ]);
  });

  it("emits explicit world geometry for open vector paths and freehand drawings", () => {
    const synthetic = {
      fixtureId: "fixture-drawing-world-geometry-v1",
      domain: "drawing",
      description: "Synthetic public compiler-contract geometry fixture.",
      frozenVersion: 1,
      preBriefSetup: {
        operations: [
          {
            type: "create_object",
            objectRef: "open-vector",
            objectKind: "path",
            nodeType: null,
            semanticName: "Open vector",
            semanticRole: "scene_part",
            content: "open vector",
            bounds: { x: 10, y: 20, width: 100, height: 50, zIndex: 3, opacity: 0.75 },
            style: { fill: "none", stroke: "blue" },
            pathGeometry: { closed: false, normalizedPoints: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }] },
            issueTags: ["none"],
          },
          {
            type: "create_object",
            objectRef: "freehand",
            objectKind: "draw",
            nodeType: null,
            semanticName: "Freehand",
            semanticRole: "scene_part",
            content: "freehand",
            bounds: { x: -20, y: 100, width: 80, height: 40, zIndex: 4, opacity: 1 },
            style: { fill: "none", stroke: "red" },
            pathGeometry: { closed: false, normalizedPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
            issueTags: ["none"],
          },
        ],
      },
    };
    const plan = compilePreBriefFixture(synthetic as never);
    expect(operationByTempRef(plan.input.operations, plan.tempRefBySemanticRef["open-vector"]!)).toEqual({
      op: "create_path",
      tempRef: plan.tempRefBySemanticRef["open-vector"],
      start: { x: 10, y: 20 },
      segments: [
        { kind: "line", to: { x: 60, y: 70 } },
        { kind: "line", to: { x: 110, y: 20 } },
      ],
      closed: false,
      fill: "none",
      stroke: "blue",
      strokeWidth: 3.5,
      opacity: 0.75,
      lineCap: "round",
      lineJoin: "round",
      fillRule: "nonzero",
      rotation: 0,
      zIndex: 3,
      groupId: null,
      semanticName: "Open vector",
      semanticRole: "scene_part",
    });
    expect(operationByTempRef(plan.input.operations, plan.tempRefBySemanticRef.freehand!)).toMatchObject({
      op: "create_drawing",
      points: [{ x: -20, y: 100 }, { x: 60, y: 140 }],
      semanticName: "Freehand",
      semanticRole: "scene_part",
      zIndex: 4,
    });
  });

  it("keeps issue tags in trusted provenance only", () => {
    for (const fixture of bundle.fixtureSpecs.fixtures) {
      const plan = compilePreBriefFixture(fixture);
      expect(Object.keys(plan.provenance.issueTagsBySemanticRef).length).toBeGreaterThan(0);
      expect(keysDeep(plan.input)).not.toContain("issueTags");
      expect(keysDeep(plan.input)).not.toContain("issueTagsBySemanticRef");
    }
  });
});

describe("observable concurrent events", () => {
  it("compiles both events while preserving their semantic trigger exactly", () => {
    const observed = new Set<string>();
    for (const event of bundle.fixtureSpecs.concurrentEvents) {
      const plan = compileConcurrentEvent(event);
      expect(plan.observableTrigger).toEqual(event.observableTrigger);
      expect(plan.input.operations).toHaveLength(event.operations.length);
      expect(JSON.stringify(plan.input)).not.toContain("issueTags");
      observed.add(plan.observableTrigger.observable);
    }
    expect(observed).toEqual(new Set(["first_author_mutation", "first_visual_inspection"]));
  });

  it("preserves first_draft_staged and resolved cross-transaction references", () => {
    const synthetic = {
      eventFixtureId: "event-architecture-draft-reference-v1",
      domain: "architecture",
      description: "Synthetic public compiler-contract reference event.",
      observableTrigger: { kind: "after_observable", observable: "first_draft_staged", occurrence: 1 },
      operations: [{
        type: "create_relationship",
        relationshipRef: "external-link",
        fromObjectRef: "external-a",
        toObjectRef: "external-b",
        label: "handoff",
        direction: "end",
        routing: "elbow",
        issueTags: ["none"],
      }],
    };
    const plan = compileConcurrentEvent(synthetic as never, {
      resolvedObjectIds: { "external-a": "shape_a", "external-b": "shape_b" },
    });
    expect(plan.observableTrigger.observable).toBe("first_draft_staged");
    expect(plan.input.operations[0]).toMatchObject({
      op: "connect",
      start: { objectId: "shape_a" },
      end: { objectId: "shape_b" },
      routing: { mode: "elbow", elbowMidPoint: 0.5 },
    });
    expect(() => compileConcurrentEvent(synthetic as never)).toThrow(/external-a, external-b/);
  });

  it("attaches only the two declared events to their matching task executions", () => {
    const tasks = bundle.benchmark.tasks.map((task) => compileBenchmarkTaskExecution(bundle, task.id));
    const withEvent = tasks.filter((task) => task.trustedCoordinator.concurrentEvent !== null);
    expect(withEvent.map((task) => task.taskId).sort()).toEqual([
      "dev-architecture-stress-stale-revision",
      "dev-drawing-stress-concurrent-collage",
    ]);
  });
});

describe("canonical commitments", () => {
  it("is invariant to object key insertion order and sensitive to values", () => {
    expect(canonicalSha256({ a: 1, b: { c: 2 } })).toBe(canonicalSha256({ b: { c: 2 }, a: 1 }));
    expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: 2 }));
    expect(canonicalSha256({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("produces stable task/public/setup/event/rubric and full-bundle commitments", () => {
    const first = benchmarkCommitments(bundle);
    const reparsed = parseBenchmarkExecutionBundle(
      structuredClone(developmentManifest),
      structuredClone(developmentRubrics),
      structuredClone(developmentFixtureSpecs),
    );
    const second = benchmarkCommitments(reparsed);
    expect(first).toEqual(second);
    expect(first.fullBundle).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(first.tasks)).toHaveLength(12);
    for (const commitments of Object.values(first.tasks)) {
      expect(Object.keys(commitments).sort()).toEqual(["event", "publicPacket", "rubric", "setup", "task"]);
      for (const commitment of Object.values(commitments)) expect(commitment).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });
});

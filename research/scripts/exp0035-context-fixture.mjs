const SCHEMA_VERSION = "jazzboard-exp0035-context-fixture/v1";
const RESOLUTION = "Awaiting dependency review";
const OBJECT_KINDS = ["shape", "text", "path"];
const IGNORED_TARGET_RUNTIME_FIELDS = new Set(["revision", "updatedAt", "lastEditedBy"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedText(seed) {
  if (typeof seed === "number") {
    assert(Number.isSafeInteger(seed), "EXP-0035 seed numbers must be safe integers.");
    return String(seed);
  }
  assert(typeof seed === "string" && seed.length > 0, "EXP-0035 seed must be a non-empty string or safe integer.");
  return seed;
}

function seededRandom(seed) {
  let hash = 2166136261;
  for (const character of seedText(seed)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [result[index], result[replacement]] = [result[replacement], result[index]];
  }
  return result;
}

function serial(index) {
  return String(index + 1).padStart(3, "0");
}

function position(index, columns, random) {
  return {
    x: 80 + (index % columns) * 248 + Math.floor(random() * 17),
    y: 80 + Math.floor(index / columns) * 126 + Math.floor(random() * 13),
  };
}

function shapeOperation({ index, prefix, random, nodeType = "component", nodeMetadata }) {
  const point = position(index, 18, random);
  const labels = ["Review", "Dependency", "Gateway", "Milestone", "Follow-up", "Owner check"];
  return {
    op: "create_node",
    tempRef: `s${serial(index)}`,
    semanticName: `${prefix}.shape.${serial(index)}`,
    semanticRole: nodeType === "open_question" ? "planning.open_question" : `planning.${nodeType}`,
    label: labels[index % labels.length],
    nodeType,
    ...(nodeMetadata ? { nodeMetadata } : {}),
    ...point,
    width: 196 + (index % 3) * 12,
    height: 74 + (index % 2) * 8,
    rotation: 0,
    zIndex: index,
    groupId: null,
  };
}

function textOperation({ index, prefix, random, zIndex }) {
  const point = position(index + 9, 18, random);
  const content = ["Status review", "Dependency review", "Owner follow-up", "Status review"][index % 4];
  return {
    op: "create_text",
    tempRef: `t${serial(index)}`,
    semanticName: `${prefix}.text.${serial(index)}`,
    semanticRole: "planning.annotation",
    content,
    color: ["black", "grey", "violet"][index % 3],
    size: ["s", "m", "l"][index % 3],
    align: ["start", "middle", "end"][index % 3],
    ...point,
    width: 214 + (index % 4) * 10,
    height: 48 + (index % 2) * 8,
    rotation: 0,
    zIndex,
    groupId: null,
  };
}

function pathOperation({ index, prefix, random, zIndex }) {
  const point = position(index + 15, 18, random);
  const width = 96 + (index % 5) * 11;
  const height = 38 + (index % 3) * 9;
  return {
    op: "create_path",
    tempRef: `p${serial(index)}`,
    semanticName: `${prefix}.path.${serial(index)}`,
    semanticRole: "planning.divider",
    start: point,
    segments: index % 2 === 0
      ? [
          { kind: "quadratic", control: { x: point.x + width / 2, y: point.y - height }, to: { x: point.x + width, y: point.y } },
          { kind: "line", to: { x: point.x + width + 24, y: point.y + height / 2 } },
        ]
      : [
          { kind: "line", to: { x: point.x + width, y: point.y + height } },
          { kind: "line", to: { x: point.x + width + 24, y: point.y + 4 } },
        ],
    closed: false,
    fill: "none",
    stroke: ["grey", "light-violet", "blue"][index % 3],
    strokeWidth: 2 + (index % 3),
    opacity: 0.65 + (index % 3) * 0.1,
    lineCap: "round",
    lineJoin: "round",
    fillRule: "nonzero",
    rotation: 0,
    zIndex,
    groupId: null,
  };
}

function inventoryFixture(seed) {
  const random = seededRandom(`inventory:${seedText(seed)}`);
  const prefix = `inventory-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0")}`;
  const lifecycle = new Map();
  const openQuestionIndexes = shuffled(Array.from({ length: 180 }, (_, index) => index), random).slice(0, 20);
  openQuestionIndexes.forEach((index, questionIndex) => {
    const metadata = questionIndex < 8
      ? { kind: "open_question", status: "open", owner: "Mira", resolution: null }
      : questionIndex < 12
        ? { kind: "open_question", status: "answered", owner: "Mira", resolution: "Recorded in the planning notes" }
        : questionIndex < 16
          ? { kind: "open_question", status: "open", owner: ["Noah", "Priya"][questionIndex % 2], resolution: null }
          : { kind: "open_question", status: "deferred", owner: "Mira", resolution: "Waiting for the next planning cycle" };
    lifecycle.set(index, metadata);
  });

  const shapes = Array.from({ length: 180 }, (_, index) => shapeOperation({
    index,
    prefix,
    random,
    nodeType: lifecycle.has(index) ? "open_question" : ["component", "service", "requirement"][index % 3],
    nodeMetadata: lifecycle.get(index),
  }));
  const texts = Array.from({ length: 90 }, (_, index) => textOperation({ index, prefix, random, zIndex: 180 + index }));
  const paths = Array.from({ length: 90 }, (_, index) => pathOperation({ index, prefix, random, zIndex: 270 + index }));
  const records = shuffled([...shapes, ...texts, ...paths], random);
  const transactions = Array.from({ length: 6 }, (_, diagramIndex) => {
    const members = records.slice(diagramIndex * 60, (diagramIndex + 1) * 60);
    return {
      intent: "Provision one section of the EXP-0035 inventory board.",
      summary: `Created inventory section ${diagramIndex + 1} of 6.`,
      operations: [
        ...members,
        {
          op: "create_diagram",
          tempRef: `d${diagramIndex + 1}`,
          title: `Planning area ${diagramIndex + 1}`,
          description: "Existing planning records for compact context recovery.",
          diagramType: ["architecture", "flow", "hierarchy", "system_context", "process", "custom"][diagramIndex],
          category: "context-recovery",
          tags: ["exp0035", "inventory"],
          members: members.map(({ tempRef }) => ({ tempRef })),
          connectors: [],
        },
      ],
    };
  });
  const openQuestionNames = shapes
    .filter((operation) => operation.nodeMetadata?.kind === "open_question"
      && operation.nodeMetadata.status === "open"
      && operation.nodeMetadata.owner === "Mira")
    .map((operation) => operation.semanticName)
    .sort();
  const expectedAnswer = {
    objectCounts: { shape: 180, text: 90, path: 90 },
    diagramCount: 6,
    openQuestionNames,
  };
  return {
    publicBrief: "Inspect the existing board without changing it. Return only one JSON object with objectCounts giving the count for each object kind present, diagramCount giving the number of Diagrams, and openQuestionNames giving the alphabetically sorted exact semantic names of unresolved open questions owned by Mira.",
    transactions,
    expectedAnswer,
    invariants: {
      totalObjectCount: 360,
      objectCounts: expectedAnswer.objectCounts,
      diagramCount: 6,
      miraOpenQuestionCount: openQuestionNames.length,
      requiresNoMutation: true,
    },
  };
}

function repairFixture(seed) {
  const random = seededRandom(`repair:${seedText(seed)}`);
  const prefix = `repair-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0")}`;
  const shuffledIndexes = shuffled(Array.from({ length: 120 }, (_, index) => index), random);
  const targets = new Set(shuffledIndexes.slice(0, 12));
  const miraAnswered = new Set(shuffledIndexes.slice(12, 16));
  const miraDeferred = new Set(shuffledIndexes.slice(16, 20));
  const miraClosed = new Set(shuffledIndexes.slice(20, 24));
  const otherOpen = new Set(shuffledIndexes.slice(24, 36));
  const unownedOpen = new Set(shuffledIndexes.slice(36, 48));
  const decisions = new Set(shuffledIndexes.slice(48, 56));
  const shapes = Array.from({ length: 120 }, (_, index) => {
    let nodeType = ["component", "service", "requirement"][index % 3];
    let nodeMetadata;
    if (targets.has(index)) {
      nodeType = "open_question";
      nodeMetadata = { kind: "open_question", status: "open", owner: "Mira", resolution: null };
    } else if (miraAnswered.has(index)) {
      nodeType = "open_question";
      nodeMetadata = { kind: "open_question", status: "answered", owner: "Mira", resolution: "Answer already recorded" };
    } else if (miraDeferred.has(index)) {
      nodeType = "open_question";
      nodeMetadata = { kind: "open_question", status: "deferred", owner: "Mira", resolution: "Existing deferral" };
    } else if (miraClosed.has(index)) {
      nodeType = "open_question";
      nodeMetadata = { kind: "open_question", status: "closed", owner: "Mira", resolution: "Closed after review" };
    } else if (otherOpen.has(index)) {
      nodeType = "open_question";
      nodeMetadata = { kind: "open_question", status: "open", owner: ["Noah", "Priya", "Sam"][index % 3], resolution: null };
    } else if (unownedOpen.has(index)) {
      nodeType = "open_question";
      nodeMetadata = { kind: "open_question", status: "open", owner: null, resolution: null };
    } else if (decisions.has(index)) {
      nodeType = "decision";
      nodeMetadata = index % 2 === 0
        ? { kind: "decision", status: "proposed", owner: "Mira", resolution: null }
        : { kind: "decision", status: "accepted", owner: "Mira", resolution: "Approved before this task" };
    }
    return shapeOperation({ index, prefix, random, nodeType, nodeMetadata });
  });
  const texts = Array.from({ length: 60 }, (_, index) => textOperation({ index, prefix, random, zIndex: 120 + index }));
  const paths = Array.from({ length: 60 }, (_, index) => pathOperation({ index, prefix, random, zIndex: 180 + index }));
  const records = shuffled([...shapes, ...texts, ...paths], random);
  const targetSemanticNames = shapes.filter((operation) => targets.has(Number(operation.tempRef.slice(1)) - 1))
    .map((operation) => operation.semanticName).sort();
  return {
    publicBrief: `Update every open question owned by Mira that is currently open: set its status to deferred and its resolution to ${JSON.stringify(RESOLUTION)}. Preserve every other object, all geometry, labels, and styles. Return only one JSON object with updatedOpenQuestionNames containing the alphabetically sorted exact semantic names changed and updatedCount containing their count.`,
    transactions: [0, 1].map((batchIndex) => ({
      intent: "Provision the EXP-0035 local repair board.",
      summary: `Created repair records ${batchIndex * 120 + 1}-${(batchIndex + 1) * 120}.`,
      operations: records.slice(batchIndex * 120, (batchIndex + 1) * 120),
    })),
    expectedAnswer: { updatedOpenQuestionNames: targetSemanticNames, updatedCount: 12 },
    invariants: {
      totalObjectCount: 240,
      objectCounts: { shape: 120, text: 60, path: 60 },
      diagramCount: 0,
      targetCount: 12,
      targetSemanticNames,
      targetOwner: "Mira",
      targetInitialStatus: "open",
      targetFinalStatus: "deferred",
      targetResolution: RESOLUTION,
      preserveAllOtherObjectFields: true,
    },
  };
}

export function createExp0035ContextFixture(options = {}) {
  const family = options.family ?? "inventory";
  const seed = options.seed ?? "exp0035-development";
  assert(family === "inventory" || family === "repair", "EXP-0035 family must be inventory or repair.");
  const fixture = family === "inventory" ? inventoryFixture(seed) : repairFixture(seed);
  assert(fixture.transactions.every(({ operations }) => operations.length > 0 && operations.length <= 200), "EXP-0035 transaction chunks must contain 1-200 operations.");
  return {
    schemaVersion: SCHEMA_VERSION,
    protocolId: "EXP-0035",
    family,
    seed: seedText(seed),
    public: { brief: fixture.publicBrief },
    provisioning: { mode: "create-only", transactions: fixture.transactions },
    controller: { expectedAnswer: fixture.expectedAnswer, invariants: fixture.invariants },
  };
}

export const createExp0035Fixture = createExp0035ContextFixture;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function structuredAnswer(answer) {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(answer);
  } catch {
    return Symbol("invalid-json");
  }
}

function targetWithoutRuntimeFields(entity) {
  return Object.fromEntries(Object.entries(entity).filter(([key]) => !IGNORED_TARGET_RUNTIME_FIELDS.has(key)));
}

function preservedLifecycleFields(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !["status", "resolution", "resolvedAt"].includes(key)));
}

function targetObjects(room) {
  return Object.values(room?.objects ?? {}).filter((object) => object.kind === "shape"
    && object.nodeType === "open_question"
    && object.nodeMetadata?.kind === "open_question"
    && object.nodeMetadata.status === "open"
    && object.nodeMetadata.owner === "Mira");
}

function check(name, passed, detail) {
  return { name, passed, ...(passed ? {} : { detail }) };
}

export function gradeExp0035ContextFixture({ family, beforeRoom, afterRoom, finalAnswer, answer } = {}) {
  assert(family === "inventory" || family === "repair", "EXP-0035 grade family must be inventory or repair.");
  assert(beforeRoom && typeof beforeRoom === "object", "EXP-0035 grade requires beforeRoom.");
  assert(afterRoom && typeof afterRoom === "object", "EXP-0035 grade requires afterRoom.");
  const submittedAnswer = structuredAnswer(finalAnswer ?? answer);
  const checks = [];

  if (family === "inventory") {
    const counts = {};
    for (const object of Object.values(beforeRoom.objects ?? {})) counts[object.kind] = (counts[object.kind] ?? 0) + 1;
    const openQuestionNames = targetObjects(beforeRoom).map((object) => object.semanticName).sort();
    const expected = {
      objectCounts: Object.fromEntries(OBJECT_KINDS.filter((kind) => counts[kind]).map((kind) => [kind, counts[kind]])),
      diagramCount: Object.keys(beforeRoom.diagrams ?? {}).length,
      openQuestionNames,
    };
    checks.push(check("inventory fixture cardinality", Object.keys(beforeRoom.objects ?? {}).length === 360
      && counts.shape === 180
      && counts.text === 90
      && counts.path === 90
      && Object.keys(counts).length === 3
      && expected.diagramCount === 6
      && openQuestionNames.length === 8, "The before state is not the complete EXP-0035 inventory fixture."));
    checks.push(check("authoritative document unchanged", canonical({ objects: afterRoom.objects, diagrams: afterRoom.diagrams }) === canonical({ objects: beforeRoom.objects, diagrams: beforeRoom.diagrams }), "Inventory work mutated authoritative objects or Diagrams."));
    checks.push(check("exact structured answer", canonical(submittedAnswer) === canonical(expected), "The final JSON does not exactly match authoritative counts, Diagram count, and sorted Mira open-question names."));
  } else {
    const targets = targetObjects(beforeRoom);
    const targetIds = new Set(targets.map((object) => object.id));
    const beforeIds = Object.keys(beforeRoom.objects ?? {}).sort();
    const afterIds = Object.keys(afterRoom.objects ?? {}).sort();
    const beforeCounts = Object.values(beforeRoom.objects ?? {}).reduce((counts, object) => {
      counts[object.kind] = (counts[object.kind] ?? 0) + 1;
      return counts;
    }, {});
    checks.push(check("repair fixture cardinality", beforeIds.length === 240
      && beforeCounts.shape === 120
      && beforeCounts.text === 60
      && beforeCounts.path === 60
      && Object.keys(beforeCounts).length === 3
      && Object.keys(beforeRoom.diagrams ?? {}).length === 0
      && targets.length === 12, "The before state is not the complete EXP-0035 repair fixture."));
    checks.push(check("object identity set preserved", canonical(afterIds) === canonical(beforeIds), "Objects were added or removed."));
    checks.push(check("Diagrams preserved", canonical(afterRoom.diagrams ?? {}) === canonical(beforeRoom.diagrams ?? {}), "A Diagram was created, removed, or rewritten."));
    for (const id of beforeIds) {
      const before = beforeRoom.objects[id];
      const after = afterRoom.objects?.[id];
      if (!after) continue;
      if (targetIds.has(id)) {
        const beforeComparable = targetWithoutRuntimeFields(before);
        const afterComparable = targetWithoutRuntimeFields(after);
        const { nodeMetadata: beforeMetadata, ...beforeRest } = beforeComparable;
        const { nodeMetadata: afterMetadata, ...afterRest } = afterComparable;
        checks.push(check(`target fields:${id}`, canonical(afterRest) === canonical(beforeRest), `Target ${id} changed outside lifecycle metadata.`));
        checks.push(check(`target lifecycle:${id}`, canonical(preservedLifecycleFields(afterMetadata)) === canonical(preservedLifecycleFields(beforeMetadata))
          && afterMetadata?.status === "deferred"
          && afterMetadata?.resolution === RESOLUTION
          && Number.isFinite(afterMetadata?.resolvedAt), `Target ${id} does not have the exact deferred lifecycle state.`));
        checks.push(check(`target revision:${id}`, Number.isInteger(after.revision) && after.revision > before.revision, `Target ${id} did not advance its authoritative revision.`));
      } else {
        checks.push(check(`protected object:${id}`, canonical(after) === canonical(before), `Protected object ${id} changed.`));
      }
    }
    const expectedAnswer = {
      updatedOpenQuestionNames: targets.map((object) => object.semanticName).sort(),
      updatedCount: targets.length,
    };
    checks.push(check("exact structured answer", canonical(submittedAnswer) === canonical(expectedAnswer), "The final JSON does not exactly name every and only changed target in sorted order."));
  }

  const failedChecks = checks.filter((item) => !item.passed);
  return {
    schemaVersion: "jazzboard-exp0035-context-grade/v1",
    family,
    passed: failedChecks.length === 0,
    score: failedChecks.length === 0 ? 1 : 0,
    checks,
    failedCheckCount: failedChecks.length,
  };
}

export const gradeExp0035Fixture = gradeExp0035ContextFixture;
export { RESOLUTION as EXP0035_REPAIR_RESOLUTION, SCHEMA_VERSION as EXP0035_CONTEXT_FIXTURE_SCHEMA_VERSION };

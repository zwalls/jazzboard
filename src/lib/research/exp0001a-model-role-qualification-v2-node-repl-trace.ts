import { parse as parseJavaScript } from "acorn";
import { Linter } from "eslint/universal";

type AstNode = Readonly<{ type: string; [key: string]: unknown }>;

function node(value: unknown): AstNode | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
      && typeof (value as { type?: unknown }).type === "string"
    ? value as AstNode
    : null;
}

function walk(root: AstNode, visit: (candidate: AstNode) => void): void {
  visit(root);
  for (const [key, value] of Object.entries(root)) {
    if (["start", "end", "loc"].includes(key)) continue;
    const child = node(value);
    if (child !== null) walk(child, visit);
    else if (Array.isArray(value)) {
      for (const entry of value) {
        const arrayChild = node(entry);
        if (arrayChild !== null) walk(arrayChild, visit);
      }
    }
  }
}

function identifier(value: unknown): string | null {
  const candidate = node(value);
  return candidate?.type === "Identifier" && typeof candidate.name === "string" ? candidate.name : null;
}

function staticString(value: unknown): string | null {
  const candidate = node(value);
  return candidate?.type === "Literal" && typeof candidate.value === "string" ? candidate.value : null;
}

function unwrap(value: unknown): AstNode | null {
  const candidate = node(value);
  return candidate?.type === "AwaitExpression" ? node(candidate.argument) : candidate;
}

function memberProperty(value: unknown): string | null {
  const candidate = node(value);
  if (candidate?.type !== "MemberExpression") return null;
  return candidate.computed === true ? staticString(candidate.property) : identifier(candidate.property);
}

function memberRoot(value: unknown): string | null {
  let candidate = node(value);
  while (candidate?.type === "MemberExpression") candidate = node(candidate.object);
  return identifier(candidate);
}

function call(value: unknown): AstNode | null {
  const candidate = unwrap(value);
  return candidate?.type === "CallExpression" ? candidate : null;
}

function directMemberCall(value: unknown, objectName: string, propertyName: string): AstNode | null {
  const candidate = call(value);
  const callee = node(candidate?.callee);
  return callee?.type === "MemberExpression" && callee.computed !== true
      && identifier(callee.object) === objectName && identifier(callee.property) === propertyName
    ? candidate
    : null;
}

function objectPropertyValue(value: unknown, key: string): AstNode | null {
  const candidate = node(value);
  if (candidate?.type !== "ObjectExpression" || !Array.isArray(candidate.properties)) return null;
  for (const propertyValue of candidate.properties) {
    const property = node(propertyValue);
    if (property?.type !== "Property" || property.computed === true || property.kind !== "init") continue;
    if ((identifier(property.key) ?? staticString(property.key)) === key) return node(property.value);
  }
  return null;
}

function exactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  const candidate = node(value);
  if (candidate?.type !== "ObjectExpression" || !Array.isArray(candidate.properties)) return false;
  const keys = candidate.properties.map((propertyValue) => {
    const property = node(propertyValue);
    return property?.type === "Property" && property.computed !== true && property.kind === "init"
      ? identifier(property.key) ?? staticString(property.key)
      : null;
  });
  return keys.every((key) => key !== null)
    && JSON.stringify([...keys].sort()) === JSON.stringify([...expected].sort());
}

function markerObjectFromWrite(value: unknown): AstNode | null {
  const writeCall = directMemberCall(value, "nodeRepl", "write");
  const writeArguments = Array.isArray(writeCall?.arguments) ? writeCall.arguments : [];
  if (writeArguments.length !== 1) return null;
  const stringifyCall = directMemberCall(writeArguments[0], "JSON", "stringify");
  const stringifyArguments = Array.isArray(stringifyCall?.arguments) ? stringifyCall.arguments : [];
  return stringifyArguments.length === 1 ? node(stringifyArguments[0]) : null;
}

function programStatements(root: AstNode): AstNode[] {
  return root.type === "Program" && Array.isArray(root.body)
    ? root.body.map(node).filter((entry): entry is AstNode => entry !== null)
    : [];
}

function collectPatternBindings(value: unknown, bindings: Set<string>): void {
  const candidate = node(value);
  if (candidate === null) return;
  if (candidate.type === "Identifier" && typeof candidate.name === "string") {
    bindings.add(candidate.name);
    return;
  }
  if (candidate.type === "RestElement") {
    collectPatternBindings(candidate.argument, bindings);
    return;
  }
  if (candidate.type === "AssignmentPattern") {
    collectPatternBindings(candidate.left, bindings);
    return;
  }
  if (candidate.type === "ObjectPattern" && Array.isArray(candidate.properties)) {
    for (const propertyValue of candidate.properties) {
      const property = node(propertyValue);
      if (property?.type === "Property") collectPatternBindings(property.value, bindings);
      else if (property?.type === "RestElement") collectPatternBindings(property.argument, bindings);
    }
    return;
  }
  if (candidate.type === "ArrayPattern" && Array.isArray(candidate.elements)) {
    for (const element of candidate.elements) collectPatternBindings(element, bindings);
  }
}

function topLevelBindings(root: AstNode): Set<string> {
  const bindings = new Set<string>();
  for (const statement of programStatements(root)) {
    if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
      for (const declarationValue of statement.declarations) {
        const declaration = node(declarationValue);
        collectPatternBindings(declaration?.id, bindings);
      }
    } else if (["FunctionDeclaration", "ClassDeclaration"].includes(statement.type)) {
      collectPatternBindings(statement.id, bindings);
    }
  }
  return bindings;
}

function expressionFromStatement(statement: AstNode): AstNode | null {
  return statement.type === "ExpressionStatement" ? node(statement.expression) : null;
}

function variableDeclarations(statement: AstNode): Array<{ name: string; init: AstNode; kind: string }> {
  if (statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations)) return [];
  return statement.declarations.flatMap((declarationValue) => {
    const declaration = node(declarationValue);
    const name = identifier(declaration?.id);
    const init = unwrap(declaration?.init);
    return name !== null && init !== null ? [{ name, init, kind: String(statement.kind) }] : [];
  });
}

function exactToolCallFromExpression(value: unknown): string | null {
  const toolCall = directMemberCall(value, "tools", "call");
  const argumentsValue = Array.isArray(toolCall?.arguments) ? toolCall.arguments : [];
  return argumentsValue.length >= 1 ? staticString(argumentsValue[0]) : null;
}

function exactBrowserClientPath(value: string): boolean {
  return /^\/Users\/[^/]+\/\.codex\/plugins\/cache\/openai-bundled\/browser\/26\.825\.51511\/scripts\/browser-client\.mjs$/.test(value);
}

const forbiddenIdentifiers = new Set([
  "global", "globalThis", "window", "process", "require", "module", "eval", "Function", "fetch",
  "XMLHttpRequest", "WebSocket", "Reflect", "Deno", "Bun",
]);
const forbiddenMemberNames = new Set([
  "constructor", "__proto__", "getBuiltinModule", "evaluate", "evaluateHandle", "fetch", "requestUrl",
  "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf", "setPrototypeOf",
  "defineProperty", "defineProperties",
]);
const forbiddenModuleLiterals = /^(?:node:)?(?:child_process|fs|fs\/promises|http|https|net|tls|dns|dgram|worker_threads|vm|module)$/;

export type QualificationV2NodeReplProgramAnalysis = Readonly<{
  toolCalls: readonly Readonly<{ toolName: string; resultBinding: string | null }>[];
  declaredBindings: readonly string[];
  mutatedBindings: readonly string[];
  sessionMarkerBindings: Readonly<{ join: string; collaboration: string }> | null;
  mutationProofTool: string | null;
  visualProofBound: boolean;
}>;

export function analyzeQualificationV2NodeReplProgram(code: string): QualificationV2NodeReplProgramAnalysis {
  const root = parseJavaScript(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  }) as unknown as AstNode;
  const statements = programStatements(root);
  const toolCalls: Array<{ toolName: string; resultBinding: string | null }> = [];
  const declarationByName = new Map<string, { init: AstNode; statementIndex: number; kind: string }>();
  for (const [statementIndex, statement] of statements.entries()) {
    for (const declaration of variableDeclarations(statement)) {
      declarationByName.set(declaration.name, { init: declaration.init, statementIndex, kind: declaration.kind });
      const toolName = exactToolCallFromExpression(declaration.init);
      if (toolName !== null) toolCalls.push({ toolName, resultBinding: declaration.name });
    }
    const expression = expressionFromStatement(statement);
    const toolName = exactToolCallFromExpression(expression);
    if (toolName !== null) toolCalls.push({ toolName, resultBinding: null });
  }
  const mutatedBindings = new Set<string>();
  const mutatingMemberMethods = new Set([
    "copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift",
    "set", "add", "delete", "clear",
  ]);
  walk(root, (candidate) => {
    const target = candidate.type === "AssignmentExpression"
      ? node(candidate.left)
      : candidate.type === "UpdateExpression"
        ? node(candidate.argument)
        : candidate.type === "UnaryExpression" && candidate.operator === "delete"
          ? node(candidate.argument)
        : null;
    const name = memberRoot(target) ?? identifier(target);
    if (name !== null) mutatedBindings.add(name);
    if (candidate.type === "CallExpression") {
      const callee = node(candidate.callee);
      const method = memberProperty(callee);
      const receiverRoot = callee?.type === "MemberExpression" ? memberRoot(callee.object) : null;
      if (receiverRoot !== null && mutatingMemberMethods.has(method ?? "")) {
        mutatedBindings.add(receiverRoot);
      }
      if (callee?.type === "MemberExpression" && memberRoot(callee.object) === "Object"
          && method === "assign" && Array.isArray(candidate.arguments)) {
        const assignedRoot = memberRoot(candidate.arguments[0]) ?? identifier(candidate.arguments[0]);
        if (assignedRoot !== null) mutatedBindings.add(assignedRoot);
      }
    }
  });

  let sessionMarkerBindings: { join: string; collaboration: string } | null = null;
  let mutationProofTool: string | null = null;
  let visualProofBound = false;
  for (const [statementIndex, statement] of statements.entries()) {
    const expression = expressionFromStatement(statement);
    if (expression === null) continue;
    const marker = markerObjectFromWrite(expression);
    if (marker !== null) {
      const schemaVersion = staticString(objectPropertyValue(marker, "schemaVersion"));
      if (schemaVersion === "exp-0001a-qualification-author-session-marker/v2"
          && exactObjectKeys(marker, ["schemaVersion", "join", "collaboration"])) {
        const join = identifier(objectPropertyValue(marker, "join"));
        const collaboration = identifier(objectPropertyValue(marker, "collaboration"));
        const localJoin = join === null ? undefined : declarationByName.get(join);
        const localCollaboration = collaboration === null ? undefined : declarationByName.get(collaboration);
        if (join !== null && collaboration !== null
            && (localJoin === undefined || localJoin.statementIndex < statementIndex)
            && (localCollaboration === undefined || localCollaboration.statementIndex < statementIndex)
            && !mutatedBindings.has(join) && !mutatedBindings.has(collaboration)) {
          sessionMarkerBindings = { join, collaboration };
        }
      }
      if (schemaVersion === "exp-0001a-qualification-author-mutation-result/v2"
          && exactObjectKeys(marker, ["schemaVersion", "toolResult"])) {
        const resultName = identifier(objectPropertyValue(marker, "toolResult"));
        const declaration = resultName === null ? undefined : declarationByName.get(resultName);
        const toolName = declaration === undefined ? null : exactToolCallFromExpression(declaration.init);
        if (resultName === "qualificationMutationResult" && declaration?.kind === "var"
            && toolName !== null && declaration.statementIndex === 0
            && statementIndex === 1 && statements.length === 2
            && !mutatedBindings.has(resultName)) {
          mutationProofTool = toolName;
        }
      }
    }
  }

  const visualBindings = [
    ["visualRoomState", "tools", "call", "read_room_state"],
    ["visualInspection", "tools", "call", "inspect_canvas_scope"],
    ["visualPageUrl", "tab", "url", null],
    ["visualPixels", "tab", "screenshot", null],
  ] as const;
  const visualIndexes: number[] = [];
  let visualDeclarationsValid = true;
  for (const [name, objectName, methodName, toolName] of visualBindings) {
    const declaration = declarationByName.get(name);
    const boundCall = declaration === undefined ? null : directMemberCall(declaration.init, objectName, methodName);
    const args = Array.isArray(boundCall?.arguments) ? boundCall.arguments : [];
    if (declaration?.kind !== "const" || boundCall === null
        || (toolName !== null && staticString(args[0]) !== toolName)) {
      visualDeclarationsValid = false;
      break;
    }
    visualIndexes.push(declaration.statementIndex);
  }
  if (visualDeclarationsValid && visualIndexes.every((value, index) => index === 0 || value > visualIndexes[index - 1]!)) {
    const markerIndex = statements.findIndex((statement) => {
      const marker = markerObjectFromWrite(expressionFromStatement(statement));
      return marker !== null
        && staticString(objectPropertyValue(marker, "schemaVersion"))
          === "exp-0001a-qualification-author-visual-marker/v2"
        && exactObjectKeys(marker, ["schemaVersion", "pageUrl", "roomState", "inspection"])
        && identifier(objectPropertyValue(marker, "pageUrl")) === "visualPageUrl"
        && identifier(objectPropertyValue(marker, "roomState")) === "visualRoomState"
        && identifier(objectPropertyValue(marker, "inspection")) === "visualInspection";
    });
    const imageIndex = statements.findIndex((statement) => {
      const emit = directMemberCall(expressionFromStatement(statement), "nodeRepl", "emitImage");
      const args = Array.isArray(emit?.arguments) ? emit.arguments : [];
      return args.length === 1 && identifier(args[0]) === "visualPixels";
    });
    visualProofBound = JSON.stringify(visualIndexes) === JSON.stringify([0, 1, 2, 3])
      && markerIndex === 4 && imageIndex === 5 && statements.length === 6
      && visualBindings.every(([name]) => !mutatedBindings.has(name));
  }

  return Object.freeze({
    toolCalls: Object.freeze(toolCalls.map((entry) => Object.freeze(entry))),
    declaredBindings: Object.freeze([...declarationByName.keys()]),
    mutatedBindings: Object.freeze([...mutatedBindings]),
    sessionMarkerBindings: sessionMarkerBindings === null ? null : Object.freeze(sessionMarkerBindings),
    mutationProofTool,
    visualProofBound,
  });
}

export function validateQualificationV2NodeReplIsolation(input: Readonly<{
  codeBlocks: readonly string[];
  role: "author" | "primary_reviewer" | "adjudicator";
  privateInviteUrl?: string;
  exactRevisionPngUrl?: string;
}>): boolean {
  if (input.codeBlocks.length === 0) return false;
  const linter = new Linter({ configType: "flat" });
  const stableGlobals: Record<string, "readonly"> = {
    nodeRepl: "readonly", JSON: "readonly", Object: "readonly", Array: "readonly",
    Math: "readonly", Number: "readonly", String: "readonly", Boolean: "readonly",
    Error: "readonly", Promise: "readonly", URL: "readonly", Date: "readonly",
    RegExp: "readonly", Map: "readonly", Set: "readonly", undefined: "readonly",
    NaN: "readonly", Infinity: "readonly",
  };
  const retainedBindings = new Set<string>();
  const roots: AstNode[] = [];
  for (const code of input.codeBlocks) {
    let root: AstNode;
    try {
      root = parseJavaScript(code, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
      }) as unknown as AstNode;
    } catch {
      return false;
    }
    const retainedGlobals = Object.fromEntries(
      [...retainedBindings].map((binding) => [binding, "readonly" as const]),
    );
    const lintMessages = linter.verify(code, [{
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        globals: { ...stableGlobals, ...retainedGlobals },
      },
      rules: {
        "no-undef": "error",
        "no-eval": "error",
        "no-implied-eval": "error",
        "no-new-func": "error",
      },
    }]);
    if (lintMessages.some((message) => message.severity === 2 || message.fatal)) return false;
    roots.push(root);
    for (const binding of topLevelBindings(root)) retainedBindings.add(binding);
  }
  const allowedUrls = new Set<string>();
  if (input.role === "author" && input.privateInviteUrl !== undefined) {
    allowedUrls.add(input.privateInviteUrl);
    allowedUrls.add("https://www.jazzboard.xyz");
    allowedUrls.add("https://www.jazzboard.xyz/");
  }
  if (input.role !== "author" && input.exactRevisionPngUrl !== undefined) {
    allowedUrls.add(input.exactRevisionPngUrl);
    allowedUrls.add(new URL(input.exactRevisionPngUrl).origin);
  }
  const callableMemberAliases = new Set<string>();
  let bootstrapImportCount = 0;
  let browserDocumentationCount = 0;
  let freshTabCount = 0;
  let navigationCount = 0;
  let rejected = false;
  for (const root of roots) walk(root, (candidate) => {
    if (candidate.type === "Identifier" && forbiddenIdentifiers.has(String(candidate.name))) rejected = true;
    if (candidate.type === "ThisExpression" || candidate.type === "TaggedTemplateExpression"
        || ["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(candidate.type)) {
      rejected = true;
    }
    if (candidate.type === "Literal" && typeof candidate.value === "string"
        && forbiddenModuleLiterals.test(candidate.value)) rejected = true;
    if (candidate.type === "MemberExpression") {
      const property = memberProperty(candidate);
      if (property !== null && forbiddenMemberNames.has(property)) rejected = true;
    }
    if (candidate.type === "ImportExpression") {
      const source = staticString(candidate.source);
      if (source === null || !exactBrowserClientPath(source)) rejected = true;
      else bootstrapImportCount += 1;
    }
    if (candidate.type === "VariableDeclarator") {
      const name = identifier(candidate.id);
      const init = unwrap(candidate.init);
      if (name !== null && init?.type === "MemberExpression") callableMemberAliases.add(name);
      if (node(candidate.id)?.type === "ObjectPattern" && init?.type === "MemberExpression") {
        const properties = (candidate.id as { properties?: unknown[] }).properties ?? [];
        for (const propertyValue of properties) {
          const property = node(propertyValue);
          const local = identifier(property?.value);
          if (local !== null) callableMemberAliases.add(local);
        }
      }
    }
    if (candidate.type !== "CallExpression") return;
    const callee = node(candidate.callee);
    if (callee === null || !["Identifier", "MemberExpression"].includes(callee.type)) {
      rejected = true;
      return;
    }
    if (callee.type === "Identifier" && callableMemberAliases.has(String(callee.name))) rejected = true;
    if (callee.type !== "MemberExpression") return;
    if (callee.computed === true) {
      rejected = true;
      return;
    }
    const method = memberProperty(callee);
    const rootName = memberRoot(callee);
    const args = Array.isArray(candidate.arguments) ? candidate.arguments : [];
    if (rootName === "browserAgent"
        && !(method === "getForUrl" && memberProperty(callee.object) === "browsers")) rejected = true;
    if (rootName === "browser") {
      const allowedBrowserCall = (method === "new" && memberProperty(callee.object) === "tabs")
        || (method === "documentation" && args.length === 0);
      if (!allowedBrowserCall) rejected = true;
      if (method === "documentation" && args.length === 0) browserDocumentationCount += 1;
    }
    if (rootName === "tab") {
      const allowedTabCall = method === "goto" || method === "url" || method === "screenshot"
        || (method === "get" && memberProperty(callee.object) === "capabilities"
          && staticString(args[0]) === "webmcp")
        || (method === "waitForLoadState" && memberProperty(callee.object) === "playwright");
      if (!allowedTabCall) rejected = true;
    }
    if (rootName === "webmcp" && method !== "fetchTools") rejected = true;
    if (rootName === "tools") {
      const allowedToolsCall = (method === "call" && staticString(args[0]) !== null)
        || (method === "description" && args.length === 0);
      if (!allowedToolsCall) rejected = true;
    }
    if (rootName === "nodeRepl" && method !== "write" && method !== "emitImage") rejected = true;
    if (method === "new" && memberProperty(callee.object) === "tabs") {
      if (args.length !== 0) rejected = true;
      else freshTabCount += 1;
    }
    if (method === "goto") {
      const target = staticString(args[0]);
      if (target === null || !allowedUrls.has(target)) rejected = true;
      else navigationCount += 1;
    }
    if (method === "getForUrl") {
      const target = staticString(args[0]);
      if (target === null || !allowedUrls.has(target)) rejected = true;
    }
    if (["user", "history", "openTabs", "claimTab"].includes(method ?? "")) rejected = true;
  });
  if (rejected || bootstrapImportCount !== 1 || browserDocumentationCount !== 1
      || freshTabCount !== 1 || navigationCount < 1) return false;
  const analyses = input.codeBlocks.map((code) => analyzeQualificationV2NodeReplProgram(code));
  const toolNames = analyses.flatMap((analysis) => analysis.toolCalls.map((toolCall) => toolCall.toolName));
  return input.role === "author"
    ? toolNames.includes("join_room")
    : toolNames.length === 0;
}

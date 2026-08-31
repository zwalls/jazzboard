import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalJson, hashCanonicalJson, SHA256_DIGEST_PATTERN } from "./provenance-crypto";

const digestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const timestampSchema = z.string().datetime({ offset: true });
const callIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const moneySchema = z.number().finite().nonnegative();

export const exp0001aSpendPhaseSchema = z.enum(["author", "primary", "adjudication", "pairwise"]);
export type Exp0001aSpendPhase = z.infer<typeof exp0001aSpendPhaseSchema>;

const spendEventMetadata = {
  schemaVersion: z.literal(1),
  protocolId: z.literal("EXP-0001A"),
  sequence: z.number().int().nonnegative(),
  previousEventDigest: digestSchema.nullable(),
};

const spendReservationEventContentSchema = z.object({
  ...spendEventMetadata,
  kind: z.literal("reservation"),
  at: timestampSchema,
  callId: callIdSchema,
  phase: exp0001aSpendPhaseSchema,
  maximumCostUsd: moneySchema.positive(),
  budgetDigest: digestSchema,
  pricingDigest: digestSchema,
  authorizationReceiptDigest: digestSchema,
}).strict();

const spendSettlementEventContentSchema = z.object({
  ...spendEventMetadata,
  kind: z.literal("settlement"),
  at: timestampSchema,
  callId: callIdSchema,
  phase: exp0001aSpendPhaseSchema,
  reservationEventDigest: digestSchema,
  observability: z.enum(["observed", "attested_no_provider_call"]),
  actualCostUsd: moneySchema,
  usageDigest: digestSchema.nullable(),
  providerReceiptDigest: digestSchema.nullable(),
}).strict().superRefine((event, context) => {
  if (event.observability === "observed" && (event.usageDigest === null || event.providerReceiptDigest === null)) {
    context.addIssue({ code: "custom", message: "Observed settlement requires exact usage and provider-receipt commitments." });
  }
  if (event.observability === "attested_no_provider_call"
      && (event.actualCostUsd !== 0 || event.usageDigest !== null || event.providerReceiptDigest !== null)) {
    context.addIssue({ code: "custom", message: "A no-provider-call settlement must be zero and cannot claim provider evidence." });
  }
});

const spendReservationInputSchema = z.object({
  at: timestampSchema,
  callId: callIdSchema,
  phase: exp0001aSpendPhaseSchema,
  maximumCostUsd: moneySchema.positive(),
  budgetDigest: digestSchema,
  pricingDigest: digestSchema,
}).strict();

const spendSettlementInputSchema = z.object({
  at: timestampSchema,
  callId: callIdSchema,
  phase: exp0001aSpendPhaseSchema,
  observability: z.enum(["observed", "attested_no_provider_call"]),
  actualCostUsd: moneySchema,
  usageDigest: digestSchema.nullable(),
  providerReceiptDigest: digestSchema.nullable(),
}).strict().superRefine((event, context) => {
  if (event.observability === "observed" && (event.usageDigest === null || event.providerReceiptDigest === null)) {
    context.addIssue({ code: "custom", message: "Observed settlement requires exact usage and provider-receipt commitments." });
  }
  if (event.observability === "attested_no_provider_call"
      && (event.actualCostUsd !== 0 || event.usageDigest !== null || event.providerReceiptDigest !== null)) {
    context.addIssue({ code: "custom", message: "A no-provider-call settlement must be zero and cannot claim provider evidence." });
  }
});

const spendEventContentSchema = z.discriminatedUnion("kind", [
  spendReservationEventContentSchema,
  spendSettlementEventContentSchema,
]);

type SpendEventContent = z.infer<typeof spendEventContentSchema>;
type AppendSpendContent =
  | Omit<z.infer<typeof spendReservationEventContentSchema>, "schemaVersion" | "protocolId" | "sequence" | "previousEventDigest">
  | Omit<z.infer<typeof spendSettlementEventContentSchema>, "schemaVersion" | "protocolId" | "sequence" | "previousEventDigest">;
type WithEventDigest<T> = T extends unknown ? T & { eventDigest: string } : never;
export type Exp0001aSpendEvent = WithEventDigest<SpendEventContent>;

export const exp0001aSpendEventSchema: z.ZodType<Exp0001aSpendEvent> = z.intersection(
  spendEventContentSchema,
  z.object({ eventDigest: digestSchema }).strict(),
) as z.ZodType<Exp0001aSpendEvent>;

const spendAnchorContentSchema = z.object({
  schemaVersion: z.literal("exp-0001a-spend-ledger-anchor/v1"),
  protocolId: z.literal("EXP-0001A"),
  sequence: z.number().int().nonnegative(),
  previousAnchorDigest: digestSchema.nullable(),
  authorizationReceiptDigest: digestSchema,
  ledgerRoot: digestSchema,
  event: exp0001aSpendEventSchema,
}).strict();

export const exp0001aSpendAnchorSchema = spendAnchorContentSchema.extend({
  anchorDigest: digestSchema,
}).strict();
export type Exp0001aSpendAnchor = z.infer<typeof exp0001aSpendAnchorSchema>;

export type Exp0001aSpendLedgerReadOptions = Readonly<{
  anchorDirectory?: string;
  expectedExternalAnchorRoot?: string;
}>;

export type Exp0001aSpendReservation = Extract<Exp0001aSpendEvent, { kind: "reservation" }>;
export type Exp0001aSpendSettlement = Extract<Exp0001aSpendEvent, { kind: "settlement" }>;

export type Exp0001aSpendSummary = {
  authorizedMaximumUsd: number;
  observedSettledUsd: number;
  unobservableReservedExposureUsd: number;
  totalChargedExposureUsd: number;
  remainingAuthorizedExposureUsd: number;
  reservationCount: number;
  settlementCount: number;
  pendingCallIds: string[];
  ledgerRoot: string;
  externalAnchorRoot: string;
  externalAnchorCount: number;
};

export type Exp0001aSpendLedger = {
  reserve(input: {
    at: string;
    callId: string;
    phase: Exp0001aSpendPhase;
    maximumCostUsd: number;
    budgetDigest: string;
    pricingDigest: string;
  }): Promise<Exp0001aSpendReservation>;
  settle(input: {
    at: string;
    callId: string;
    phase: Exp0001aSpendPhase;
    observability: "observed" | "attested_no_provider_call";
    actualCostUsd: number;
    usageDigest: string | null;
    providerReceiptDigest: string | null;
  }): Promise<Exp0001aSpendSettlement>;
  read(): Promise<{ events: Exp0001aSpendEvent[]; summary: Exp0001aSpendSummary }>;
};

function withoutDigest(event: Exp0001aSpendEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventDigest"));
}

export function computeExp0001aSpendEventDigest(event: Exp0001aSpendEvent): string {
  return hashCanonicalJson(withoutDigest(event));
}

export function computeExp0001aSpendLedgerRoot(events: readonly Exp0001aSpendEvent[]): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    protocolId: "EXP-0001A",
    eventDigests: events.map((event) => event.eventDigest),
  });
}

function withoutAnchorDigest(anchor: Exp0001aSpendAnchor): Record<string, unknown> {
  return Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "anchorDigest"));
}

export function computeExp0001aSpendAnchorDigest(anchor: Exp0001aSpendAnchor): string {
  return hashCanonicalJson(withoutAnchorDigest(anchor));
}

export function computeExp0001aSpendExternalAnchorRoot(
  anchors: readonly Exp0001aSpendAnchor[],
  authorizationReceiptDigest: string,
): string {
  digestSchema.parse(authorizationReceiptDigest);
  return hashCanonicalJson({
    schemaVersion: "exp-0001a-spend-ledger-external-anchor-root/v1",
    protocolId: "EXP-0001A",
    authorizationReceiptDigest,
    anchorDigests: anchors.map((anchor) => anchor.anchorDigest),
  });
}

export function defaultExp0001aSpendAnchorDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory
      || directory === path.parse(directory).root) {
    throw new Error("Spend ledger directory must be an absolute normalized non-root path.");
  }
  return path.join(path.dirname(directory), `${path.basename(directory)}.anchors`);
}

function createSpendAnchor(input: {
  event: Exp0001aSpendEvent;
  events: readonly Exp0001aSpendEvent[];
  anchors: readonly Exp0001aSpendAnchor[];
  authorizationReceiptDigest: string;
}): Exp0001aSpendAnchor {
  const content = spendAnchorContentSchema.parse({
    schemaVersion: "exp-0001a-spend-ledger-anchor/v1",
    protocolId: "EXP-0001A",
    sequence: input.anchors.length,
    previousAnchorDigest: input.anchors.at(-1)?.anchorDigest ?? null,
    authorizationReceiptDigest: input.authorizationReceiptDigest,
    ledgerRoot: computeExp0001aSpendLedgerRoot([...input.events, input.event]),
    event: input.event,
  });
  return exp0001aSpendAnchorSchema.parse({
    ...content,
    anchorDigest: hashCanonicalJson(content),
  });
}

function verifySpendAnchorChain(
  events: readonly Exp0001aSpendEvent[],
  anchors: readonly Exp0001aSpendAnchor[],
  authorizationReceiptDigest: string,
): void {
  if (events.length !== anchors.length) {
    throw new Error("Spend ledger and external anchor chain have different lengths.");
  }
  const verified: Exp0001aSpendAnchor[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const retained = exp0001aSpendAnchorSchema.parse(anchors[index]);
    if (retained.authorizationReceiptDigest !== authorizationReceiptDigest) {
      throw new Error("Spend external anchor is bound to another authorization receipt.");
    }
    if (computeExp0001aSpendAnchorDigest(retained) !== retained.anchorDigest) {
      throw new Error("Spend external anchor digest is invalid.");
    }
    const expected = createSpendAnchor({
      event: events[index],
      events: events.slice(0, index),
      anchors: verified,
      authorizationReceiptDigest,
    });
    if (canonicalJson(retained) !== canonicalJson(expected)) {
      throw new Error("Spend external anchor chain does not match the exact retained ledger.");
    }
    verified.push(retained);
  }
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

export function summarizeExp0001aSpendLedger(
  eventsInput: readonly Exp0001aSpendEvent[],
  authorizedMaximumUsd: number,
  authorizationReceiptDigest: string,
  anchorsInput?: readonly Exp0001aSpendAnchor[],
): Exp0001aSpendSummary {
  if (!Number.isFinite(authorizedMaximumUsd) || authorizedMaximumUsd <= 0) {
    throw new Error("Authorized global spend cap must be a finite positive USD value.");
  }
  const events = eventsInput.map((event) => exp0001aSpendEventSchema.parse(event));
  digestSchema.parse(authorizationReceiptDigest);
  const drifted = events.find((event) => (
    event.kind === "reservation" && event.authorizationReceiptDigest !== authorizationReceiptDigest
  ));
  if (drifted) throw new Error(`Spend reservation ${drifted.callId} is bound to another authorization receipt.`);
  let previous: string | null = null;
  const reservations = new Map<string, Exp0001aSpendReservation>();
  const settlements = new Map<string, Exp0001aSpendSettlement>();
  events.forEach((event, sequence) => {
    if (event.sequence !== sequence || event.previousEventDigest !== previous
        || computeExp0001aSpendEventDigest(event) !== event.eventDigest) {
      throw new Error("Spend ledger event order or hash chain is invalid.");
    }
    previous = event.eventDigest;
    if (event.kind === "reservation") {
      if (reservations.has(event.callId) || settlements.has(event.callId)) {
        throw new Error(`Spend call ${event.callId} was reserved more than once.`);
      }
      reservations.set(event.callId, event);
      return;
    }
    const reservation = reservations.get(event.callId);
    if (!reservation || settlements.has(event.callId)
        || reservation.eventDigest !== event.reservationEventDigest
        || reservation.phase !== event.phase) {
      throw new Error(`Spend settlement ${event.callId} lacks its one exact reservation.`);
    }
    if (event.actualCostUsd > reservation.maximumCostUsd + 1e-12) {
      throw new Error(`Observed cost for ${event.callId} exceeds its frozen maximum reservation.`);
    }
    settlements.set(event.callId, event);
  });
  const observedSettledUsd = roundUsd([...settlements.values()].reduce((total, event) => total + event.actualCostUsd, 0));
  const pending = [...reservations.values()].filter((reservation) => !settlements.has(reservation.callId));
  const unobservableReservedExposureUsd = roundUsd(pending.reduce((total, reservation) => total + reservation.maximumCostUsd, 0));
  const totalChargedExposureUsd = roundUsd(observedSettledUsd + unobservableReservedExposureUsd);
  if (totalChargedExposureUsd > authorizedMaximumUsd + 1e-12) {
    throw new Error("Spend ledger exposure exceeds the exact authorized global cap.");
  }
  const anchors = anchorsInput === undefined
    ? events.reduce<Exp0001aSpendAnchor[]>((retained, event, index) => {
      retained.push(createSpendAnchor({
        event,
        events: events.slice(0, index),
        anchors: retained,
        authorizationReceiptDigest,
      }));
      return retained;
    }, [])
    : anchorsInput.map((anchor) => exp0001aSpendAnchorSchema.parse(anchor));
  verifySpendAnchorChain(events, anchors, authorizationReceiptDigest);
  return {
    authorizedMaximumUsd,
    observedSettledUsd,
    unobservableReservedExposureUsd,
    totalChargedExposureUsd,
    remainingAuthorizedExposureUsd: roundUsd(Math.max(0, authorizedMaximumUsd - totalChargedExposureUsd)),
    reservationCount: reservations.size,
    settlementCount: settlements.size,
    pendingCallIds: pending.map((event) => event.callId),
    ledgerRoot: computeExp0001aSpendLedgerRoot(events),
    externalAnchorRoot: computeExp0001aSpendExternalAnchorRoot(anchors, authorizationReceiptDigest),
    externalAnchorCount: anchors.length,
  };
}

async function statNoFollow(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertAbsoluteNormalized(candidate: string, label: string): void {
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate
      || candidate === path.parse(candidate).root) {
    throw new Error(`${label} must be an absolute normalized non-root path.`);
  }
}

function isDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  const current = await statNoFollow(directory);
  if (!current) {
    const parent = path.dirname(directory);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error(`${label} parent must be a plain directory.`);
    }
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await syncDirectory(parent);
  }
  const retained = await lstat(directory);
  if (!retained.isDirectory() || retained.isSymbolicLink() || (retained.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && retained.uid !== process.getuid())) {
    throw new Error(`${label} must be private, plain, and owner-controlled.`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function eventFileName(event: Exp0001aSpendEvent): string {
  return `${event.sequence.toString().padStart(6, "0")}-${event.eventDigest.slice("sha256:".length, "sha256:".length + 16)}.json`;
}

function anchorFileName(anchor: Exp0001aSpendAnchor): string {
  return `${anchor.sequence.toString().padStart(6, "0")}-${anchor.anchorDigest.slice("sha256:".length, "sha256:".length + 16)}.json`;
}

function sameDescriptorStat(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

type DescriptorOpenedObserver = (filePath: string) => Promise<void> | void;
let descriptorOpenedObserver: DescriptorOpenedObserver | null = null;

/** @internal Deterministic race-injection seam; unavailable outside test processes. */
export function setExp0001aSpendDescriptorOpenedObserverForTest(
  observer: DescriptorOpenedObserver | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The spend-ledger descriptor observer is test-only.");
  }
  descriptorOpenedObserver = observer;
}

async function readCanonicalPrivateJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await descriptorOpenedObserver?.(filePath);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error(`${label} must be a mode-0600, singly linked, owner-controlled regular file.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameDescriptorStat(before, after) || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed while its exact descriptor was being read.`);
    }
    const retainedPath = await lstat(filePath);
    if (!retainedPath.isFile() || retainedPath.isSymbolicLink()
        || retainedPath.dev !== after.dev || retainedPath.ino !== after.ino) {
      throw new Error(`${label} pathname was replaced while its exact descriptor was being read.`);
    }
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error(`${label} is not exact UTF-8.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label} is not valid JSON.`);
    }
    const value = schema.parse(parsed);
    if (canonicalJson(value) !== raw) throw new Error(`${label} is not exact canonical JSON.`);
    return value;
  } finally {
    await handle.close();
  }
}

async function retainExclusiveCanonical<T>(
  filePath: string,
  value: T,
  schema: z.ZodType<T>,
  label: string,
): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
  const retained = await readCanonicalPrivateJson(filePath, schema, label);
  if (canonicalJson(retained) !== bytes.toString("utf8")) {
    throw new Error(`${label} exact readback differs from the committed bytes.`);
  }
}

async function retainOrCompareCanonical<T>(
  filePath: string,
  value: T,
  schema: z.ZodType<T>,
  label: string,
): Promise<void> {
  try {
    await retainExclusiveCanonical(filePath, value, schema, label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const retained = await readCanonicalPrivateJson(filePath, schema, label);
    if (canonicalJson(retained) !== canonicalJson(value)) {
      throw new Error(`${label} immutable evidence collision.`);
    }
  }
}

async function loadEvents(directory: string): Promise<Exp0001aSpendEvent[]> {
  const entries = await readdir(directory);
  const unexpected = entries.filter((name) => !/^\d{6}-[a-f0-9]{16}\.json$/.test(name));
  if (unexpected.length > 0) {
    throw new Error(`Spend ledger contains unexpected entries: ${unexpected.sort().join(", ")}`);
  }
  const names = entries.sort();
  const events: Exp0001aSpendEvent[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const event = await readCanonicalPrivateJson(filePath, exp0001aSpendEventSchema, "Spend ledger event");
    if (eventFileName(event) !== name) throw new Error("Spend ledger event filename does not match retained evidence.");
    events.push(event);
  }
  return events;
}

async function loadAnchors(directory: string): Promise<Exp0001aSpendAnchor[]> {
  const entries = await readdir(directory);
  const unexpected = entries.filter((name) => !/^\d{6}-[a-f0-9]{16}\.json$/.test(name));
  if (unexpected.length > 0) {
    throw new Error(`Spend external anchor chain contains unexpected entries: ${unexpected.sort().join(", ")}`);
  }
  const anchors: Exp0001aSpendAnchor[] = [];
  for (const name of entries.sort()) {
    const anchor = await readCanonicalPrivateJson(
      path.join(directory, name),
      exp0001aSpendAnchorSchema,
      "Spend external anchor",
    );
    if (anchorFileName(anchor) !== name) {
      throw new Error("Spend external anchor filename does not match retained evidence.");
    }
    anchors.push(anchor);
  }
  return anchors;
}

type SpendSnapshot = {
  events: Exp0001aSpendEvent[];
  anchors: Exp0001aSpendAnchor[];
  summary: Exp0001aSpendSummary;
};

/**
 * Crash contract for the two-directory append:
 *
 * 1. The external anchor is fsynced first and embeds the exact canonical event.
 * 2. The event is then exclusively retained and fsynced in the ledger.
 * 3. A live ledger may reconstruct exactly one missing tail event from that
 *    anchor. Read-only analysis never repairs, and every other length/prefix
 *    mismatch is terminal. This avoids treating an unanchored event as a
 *    provider-call authorization while keeping the sole crash window
 *    deterministic and byte-identical.
 */
async function loadSpendSnapshot(input: {
  directory: string;
  anchorDirectory: string;
  authorizedMaximumUsd: number;
  authorizationReceiptDigest: string;
  expectedExternalAnchorRoot?: string;
  repairMissingTailEvent: boolean;
}): Promise<SpendSnapshot> {
  await ensurePrivateDirectory(input.directory, "Spend ledger directory");
  await ensurePrivateDirectory(input.anchorDirectory, "Spend external anchor directory");
  const anchors = await loadAnchors(input.anchorDirectory);
  const anchoredEvents = anchors.map((anchor) => anchor.event);
  verifySpendAnchorChain(anchoredEvents, anchors, input.authorizationReceiptDigest);
  const events = await loadEvents(input.directory);
  if (events.length + 1 === anchors.length && input.repairMissingTailEvent) {
    for (let index = 0; index < events.length; index += 1) {
      if (canonicalJson(events[index]) !== canonicalJson(anchoredEvents[index])) {
        throw new Error("Spend ledger prefix differs from its external anchor chain.");
      }
    }
    const tail = anchoredEvents.at(-1)!;
    await retainOrCompareCanonical(
      path.join(input.directory, eventFileName(tail)),
      tail,
      exp0001aSpendEventSchema,
      "Spend ledger recovered tail event",
    );
    events.push(tail);
  }
  verifySpendAnchorChain(events, anchors, input.authorizationReceiptDigest);
  const summary = summarizeExp0001aSpendLedger(
    events,
    input.authorizedMaximumUsd,
    input.authorizationReceiptDigest,
    anchors,
  );
  if (input.expectedExternalAnchorRoot !== undefined) {
    digestSchema.parse(input.expectedExternalAnchorRoot);
    if (summary.externalAnchorRoot !== input.expectedExternalAnchorRoot) {
      throw new Error("Spend external anchor root differs from the externally bound expected root.");
    }
  }
  return { events, anchors, summary };
}

/** Read-only verifier for analysis/report code; validates every retained byte and the full hash chain. */
export async function readExp0001aSpendLedger(
  directory: string,
  authorizedMaximumUsd: number,
  authorizationReceiptDigest: string,
  options: Exp0001aSpendLedgerReadOptions = {},
): Promise<{ events: Exp0001aSpendEvent[]; summary: Exp0001aSpendSummary }> {
  assertAbsoluteNormalized(directory, "Spend ledger directory");
  digestSchema.parse(authorizationReceiptDigest);
  const anchorDirectory = options.anchorDirectory ?? defaultExp0001aSpendAnchorDirectory(directory);
  assertAbsoluteNormalized(anchorDirectory, "Spend external anchor directory");
  if (directory === anchorDirectory || isDescendant(directory, anchorDirectory)
      || isDescendant(anchorDirectory, directory)) {
    throw new Error("Spend external anchor directory must be separate from the ledger directory.");
  }
  return loadSpendSnapshot({
    directory,
    anchorDirectory,
    authorizedMaximumUsd,
    authorizationReceiptDigest,
    expectedExternalAnchorRoot: options.expectedExternalAnchorRoot,
    repairMissingTailEvent: false,
  });
}

export function createExp0001aSpendLedger(input: {
  directory: string;
  anchorDirectory?: string;
  authorizedMaximumUsd: number;
  authorizationReceiptDigest: string;
}): Exp0001aSpendLedger {
  assertAbsoluteNormalized(input.directory, "Spend ledger directory");
  digestSchema.parse(input.authorizationReceiptDigest);
  const anchorDirectory = input.anchorDirectory ?? defaultExp0001aSpendAnchorDirectory(input.directory);
  assertAbsoluteNormalized(anchorDirectory, "Spend external anchor directory");
  if (input.directory === anchorDirectory || isDescendant(input.directory, anchorDirectory)
      || isDescendant(anchorDirectory, input.directory)) {
    throw new Error("Spend external anchor directory must be separate from the ledger directory.");
  }

  const readSnapshot = async () => loadSpendSnapshot({
    directory: input.directory,
    anchorDirectory,
    authorizedMaximumUsd: input.authorizedMaximumUsd,
    authorizationReceiptDigest: input.authorizationReceiptDigest,
    repairMissingTailEvent: true,
  });
  const read = async () => {
    const { events, summary } = await readSnapshot();
    return { events, summary };
  };

  const append = async (contentInput: AppendSpendContent, current: SpendSnapshot) => {
    const content = spendEventContentSchema.parse({
      ...contentInput,
      schemaVersion: 1,
      protocolId: "EXP-0001A",
      sequence: current.events.length,
      previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
    });
    const event = exp0001aSpendEventSchema.parse({ ...content, eventDigest: hashCanonicalJson(content) });
    const anchor = createSpendAnchor({
      event,
      events: current.events,
      anchors: current.anchors,
      authorizationReceiptDigest: input.authorizationReceiptDigest,
    });
    // The independent anchor is committed first and embeds the exact event.
    // A crash before the ledger write can therefore recover one deterministic
    // tail event; the reverse ordering would leave an unanchored provider call.
    await retainExclusiveCanonical(
      path.join(anchorDirectory, anchorFileName(anchor)),
      anchor,
      exp0001aSpendAnchorSchema,
      "Spend external anchor",
    );
    await retainOrCompareCanonical(
      path.join(input.directory, eventFileName(event)),
      event,
      exp0001aSpendEventSchema,
      "Spend ledger event",
    );
    return event;
  };

  let operationTail: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    reserve(reservationInput) {
      return serialize(async () => {
      const parsed = spendReservationInputSchema.parse(reservationInput);
      const current = await readSnapshot();
      const existing = current.events.find((event) => event.kind === "reservation" && event.callId === parsed.callId) as Exp0001aSpendReservation | undefined;
      if (existing) {
        const requestedIdentity = {
          callId: parsed.callId,
          phase: parsed.phase,
          maximumCostUsd: parsed.maximumCostUsd,
          budgetDigest: parsed.budgetDigest,
          pricingDigest: parsed.pricingDigest,
        };
        if (canonicalJson({ ...requestedIdentity, authorizationReceiptDigest: input.authorizationReceiptDigest })
            !== canonicalJson({
              callId: existing.callId,
              phase: existing.phase,
              maximumCostUsd: existing.maximumCostUsd,
              budgetDigest: existing.budgetDigest,
              pricingDigest: existing.pricingDigest,
              authorizationReceiptDigest: existing.authorizationReceiptDigest,
            })) {
          throw new Error(`Spend reservation ${parsed.callId} differs from retained evidence.`);
        }
        if (current.events.some((event) => event.kind === "settlement" && event.callId === parsed.callId)) {
          throw new Error(`Provider call ${parsed.callId} is already settled and cannot be released again.`);
        }
        return existing;
      }
      if (roundUsd(current.summary.totalChargedExposureUsd + parsed.maximumCostUsd) > input.authorizedMaximumUsd + 1e-12) {
        throw new Error(`SPEND_CAP_EXHAUSTED:${parsed.callId}`);
      }
      return await append({
        kind: "reservation",
        ...parsed,
        authorizationReceiptDigest: input.authorizationReceiptDigest,
      }, current) as Exp0001aSpendReservation;
      });
    },
    settle(settlementInput) {
      return serialize(async () => {
      const parsed = spendSettlementInputSchema.parse(settlementInput);
      const current = await readSnapshot();
      const reservation = current.events.find((event) => event.kind === "reservation" && event.callId === parsed.callId) as Exp0001aSpendReservation | undefined;
      if (!reservation) throw new Error(`Spend settlement ${parsed.callId} has no retained reservation.`);
      const existing = current.events.find((event) => event.kind === "settlement" && event.callId === parsed.callId) as Exp0001aSpendSettlement | undefined;
      if (existing) {
        const expected = { ...parsed, reservationEventDigest: reservation.eventDigest };
        const retained = {
          at: existing.at,
          callId: existing.callId,
          phase: existing.phase,
          observability: existing.observability,
          actualCostUsd: existing.actualCostUsd,
          usageDigest: existing.usageDigest,
          providerReceiptDigest: existing.providerReceiptDigest,
          reservationEventDigest: existing.reservationEventDigest,
        };
        if (canonicalJson(expected) !== canonicalJson(retained)) throw new Error(`Spend settlement ${parsed.callId} differs from retained evidence.`);
        return existing;
      }
      if (parsed.phase !== reservation.phase || parsed.actualCostUsd > reservation.maximumCostUsd + 1e-12) {
        throw new Error(`Spend settlement ${parsed.callId} violates its frozen reservation.`);
      }
      return await append(
        { kind: "settlement", ...parsed, reservationEventDigest: reservation.eventDigest },
        current,
      ) as Exp0001aSpendSettlement;
      });
    },
    read: () => serialize(read),
  };
}

import type { RoomState } from "@/lib/domain/types";

export type Exp0035Family = "inventory" | "repair";

export interface Exp0035FixtureOptions {
  family?: Exp0035Family;
  seed?: string | number;
}

export interface Exp0035ProvisioningTransaction extends Record<string, unknown> {
  intent: string;
  summary: string;
  operations: Array<Record<string, unknown>>;
}

export interface Exp0035ExpectedAnswer extends Record<string, unknown> {
  objectCounts?: Record<string, number>;
  diagramCount?: number;
  openQuestionNames?: string[];
  updatedOpenQuestionNames?: string[];
  updatedCount?: number;
}

export interface Exp0035Fixture {
  schemaVersion: "jazzboard-exp0035-context-fixture/v1";
  protocolId: "EXP-0035";
  family: Exp0035Family;
  seed: string;
  public: { brief: string };
  provisioning: {
    mode: "create-only";
    transactions: Exp0035ProvisioningTransaction[];
  };
  controller: {
    expectedAnswer: Exp0035ExpectedAnswer;
    invariants: Record<string, string | number | boolean | string[] | Record<string, number>>;
  };
}

export interface Exp0035GradeInput {
  family?: Exp0035Family;
  beforeRoom?: RoomState;
  afterRoom?: RoomState;
  finalAnswer?: unknown;
  answer?: unknown;
}

export interface Exp0035GradeCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface Exp0035Grade {
  schemaVersion: "jazzboard-exp0035-context-grade/v1";
  family: Exp0035Family;
  passed: boolean;
  score: 0 | 1;
  checks: Exp0035GradeCheck[];
  failedCheckCount: number;
}

export function createExp0035ContextFixture(
  options?: Exp0035FixtureOptions,
): Exp0035Fixture;

export const createExp0035Fixture: typeof createExp0035ContextFixture;

export function gradeExp0035ContextFixture(
  input?: Exp0035GradeInput,
): Exp0035Grade;

export const gradeExp0035Fixture: typeof gradeExp0035ContextFixture;

export const EXP0035_REPAIR_RESOLUTION: "Awaiting dependency review";
export const EXP0035_CONTEXT_FIXTURE_SCHEMA_VERSION: "jazzboard-exp0035-context-fixture/v1";

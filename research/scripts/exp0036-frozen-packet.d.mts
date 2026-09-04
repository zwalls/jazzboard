import type { RoomState } from "@/lib/domain/types";

export type Exp0036Family = "inventory" | "repair";

export interface Exp0036FrozenAssignment {
  ordinal: number;
  attemptId: string;
  pairId: string;
  taskId: string;
  arm: "A0" | "A1";
}

export interface Exp0036TaskPacket extends Record<string, unknown> {
  id: string;
  brief: string;
}

export interface Exp0036Build {
  commit: string;
  archiveSha256: string;
}

export interface Exp0036FrozenPacketBundle {
  authorManifest: { taskPackets: Exp0036TaskPacket[] };
  graderManifest: {
    fixedAttemptOrder: Exp0036FrozenAssignment[];
    builds: {
      A0: Exp0036Build;
      A1: Exp0036Build;
      commonPackageLockSha256: string;
      freezeScope: string;
      researchHarnessHeadPolicy: string;
    };
    [key: string]: unknown;
  };
}

export interface Exp0036ProvisioningTransaction extends Record<string, unknown> {
  operations: Array<Record<string, unknown>>;
}

export interface Exp0036ProvisioningFixture extends Record<string, unknown> {
  family: Exp0036Family;
  provisioning: { transactions: Exp0036ProvisioningTransaction[] };
  controller: {
    expectedAnswer: Record<string, unknown>;
    invariants: Record<string, unknown>;
  };
}

export interface Exp0036Grade extends Record<string, unknown> {
  passed: boolean;
}

export function createExp0036FrozenPacketBundle(): Exp0036FrozenPacketBundle;
export function createExp0036ProvisioningFixture(taskId: string): Exp0036ProvisioningFixture;
export function gradeExp0036ContextFixture(input: {
  family: Exp0036Family;
  beforeRoom: RoomState;
  afterRoom: RoomState;
  finalAnswer?: unknown;
}): Exp0036Grade;
export function sanitizeExp0036FinalState(room: RoomState): Record<string, unknown>;

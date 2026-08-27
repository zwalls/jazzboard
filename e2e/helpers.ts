import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "../src/lib/realtime/protocol";

export type ParticipantState = {
  participantId: string;
  displayName: string;
  role: "participant" | "spectator";
  agentActive: boolean;
};

export type CanvasObjectState = {
  id: string;
  kind: "text" | "shape" | "connector" | "image" | "draw";
  revision: number;
  [key: string]: unknown;
};

export type DiagramState = {
  id: string;
  revision: number;
  [key: string]: unknown;
};

export type RoomState = {
  id: string;
  code: string;
  title: string;
  roomRevision: number;
  participants: Record<string, ParticipantState>;
  objects: Record<string, CanvasObjectState>;
  diagrams: Record<string, DiagramState>;
  leases: Record<
    string,
    {
      leaseId: string;
      objectId: string;
      operation: string;
      actor: {
        participantId: string;
        displayName: string;
        kind: "human" | "agent";
      };
    }
  >;
};

type SuccessfulRoomPayload = {
  ok: true;
  room: RoomState;
};

export type RoomResponse = SuccessfulRoomPayload & {
  participantId: string;
};

export type CommandResponse = SuccessfulRoomPayload & {
  changedObjectIds: string[];
};

export type LeaseResponse = SuccessfulRoomPayload & {
  lease: {
    leaseId: string;
    objectId: string;
    operation: string;
  } | null;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details: unknown;
  };
};

export type CreateObject = Record<string, unknown> & {
  id: string;
  kind: CanvasObjectState["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function jsonBody<T>(response: APIResponse, expectedStatus = 200): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.status(), `${response.url()} returned ${JSON.stringify(body)}`).toBe(
    expectedStatus,
  );
  return body;
}

export async function createRoomFromLanding(page: Page, displayName: string): Promise<RoomResponse> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Make room for every idea/i })).toBeVisible();
  await page.getByLabel("Your display name").fill(displayName);
  await page.getByRole("button", { name: "Create my Jazzboard" }).click();

  await expect(page).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
  const roomId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
  return getRoom(page.request, roomId);
}

export async function joinRoomFromLanding(
  page: Page,
  input: { code: string; displayName: string; role: "participant" | "spectator" },
): Promise<RoomResponse> {
  await page.goto("/");
  await page.getByRole("tab", { name: "Join by code" }).click();
  await page.getByLabel("Room code").fill(input.code);
  await page.getByLabel("Your display name").fill(input.displayName);
  await page.getByRole("radio", { name: new RegExp(`^${input.role}`, "i") }).check();
  await page.getByRole("button", { name: "Join this Jazzboard" }).click();

  await expect(page).toHaveURL(/\/room\/room_[^/?#]+$/, { timeout: 20_000 });
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });
  const roomId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
  return getRoom(page.request, roomId);
}

export async function createRoomViaApi(
  request: APIRequestContext,
  displayName: string,
  title = "Untitled Jazzboard",
): Promise<RoomResponse> {
  const response = await request.post("/api/rooms", {
    data: { action: "create", displayName, title },
  });
  return jsonBody<RoomResponse>(response);
}

export async function joinRoomViaApi(
  request: APIRequestContext,
  input: { code: string; displayName: string; role: "participant" | "spectator" },
): Promise<RoomResponse> {
  const response = await request.post("/api/rooms", {
    data: { action: "join", ...input },
  });
  return jsonBody<RoomResponse>(response);
}

export async function getRoom(request: APIRequestContext, roomId: string): Promise<RoomResponse> {
  const response = await request.get(`/api/rooms/${encodeURIComponent(roomId)}`, {
    headers: { [CLIENT_CAPABILITIES_HEADER]: SPLIT_STATE_CLIENT_CAPABILITY },
  });
  return jsonBody<RoomResponse>(response);
}

export async function expectBuiltInTldrawWatermark(page: Page): Promise<void> {
  const watermark = page.getByTitle("made with tldraw");

  await page.waitForTimeout(5_500);
  await expect(watermark).toBeVisible();
  await expect
    .poll(() =>
      watermark.evaluate((element) =>
        Number.parseInt(getComputedStyle(element.parentElement as HTMLElement).zIndex, 10),
      ),
    )
    .toBeGreaterThanOrEqual(1_000);
  await watermark.locator("..").hover();
  await page.waitForTimeout(450);

  const isTopmostAtCenter = await watermark.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return topmost === element || element.contains(topmost);
  });
  expect(isTopmostAtCenter).toBe(true);
}

export async function createCanvasObject(
  request: APIRequestContext,
  roomId: string,
  object: CreateObject,
  actor: "human" | "agent" = "agent",
): Promise<CommandResponse> {
  const endpoint = actor === "agent" ? "agent/commands" : "commands";
  const response = await request.post(`/api/rooms/${encodeURIComponent(roomId)}/${endpoint}`, {
    data: { command: { type: "create", object } },
  });
  return jsonBody<CommandResponse>(response);
}

export function textObject(id: string, content: string, x: number, y: number): CreateObject {
  return {
    id,
    kind: "text",
    x,
    y,
    width: 260,
    height: 72,
    rotation: 0,
    zIndex: 3,
    groupId: null,
    content,
    color: "black",
    size: "m",
    align: "start",
  };
}

export function shapeObject(id: string, label: string, x: number, y: number, color = "blue"): CreateObject {
  return {
    id,
    kind: "shape",
    x,
    y,
    width: 220,
    height: 120,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    shape: "rectangle",
    label,
    fill: color,
    stroke: color,
  };
}

export function connectorObject(
  id: string,
  label: string,
  startObjectId: string,
  endObjectId: string,
): CreateObject {
  return {
    id,
    kind: "connector",
    x: 0,
    y: 0,
    width: 240,
    height: 80,
    rotation: 0,
    zIndex: 2,
    groupId: null,
    start: { x: 220, y: 180, objectId: startObjectId },
    end: { x: 520, y: 180, objectId: endObjectId },
    direction: "end",
    label,
    color: "black",
  };
}

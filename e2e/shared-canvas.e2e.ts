import { expect, test } from "@playwright/test";

import {
  connectorObject,
  createCanvasObject,
  createRoomViaApi,
  getRoom,
  joinRoomViaApi,
  jsonBody,
  shapeObject,
  selectBoardMenuItem,
  textObject,
  type ApiFailure,
  type CommandResponse,
  type LeaseResponse,
} from "./helpers";

test("shares semantic agent edits, renders them for both people, and reports active-object conflicts", async ({
  browser,
  page,
}) => {
  const host = await createRoomViaApi(page.request, "Avery Architect", "Checkout architecture");
  await page.goto(`/room/${encodeURIComponent(host.room.id)}`);
  await expect(page.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

  const collaboratorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const collaborator = await joinRoomViaApi(collaboratorContext.request, {
      code: host.room.code,
      displayName: "Blair Builder",
      role: "participant",
    });
    const collaboratorPage = await collaboratorContext.newPage();
    await collaboratorPage.goto(`/room/${encodeURIComponent(host.room.id)}`);
    await expect(collaboratorPage.getByTestId("jazzboard-canvas")).toBeVisible({ timeout: 20_000 });

    const webNodeId = "checkout-web";
    const apiNodeId = "checkout-api";
    const connectorId = "checkout-request";
    const decisionId = "checkout-decision";

    const first = await createCanvasObject(
      page.request,
      host.room.id,
      shapeObject(webNodeId, "Checkout web", 120, 120, "blue"),
    );
    expect(first.changedObjectIds).toEqual([webNodeId]);

    const second = await createCanvasObject(
      collaboratorContext.request,
      host.room.id,
      shapeObject(apiNodeId, "Orders API", 520, 120, "green"),
    );
    expect(second.changedObjectIds).toEqual([apiNodeId]);

    await createCanvasObject(
      page.request,
      host.room.id,
      connectorObject(connectorId, "POST /orders", webNodeId, apiNodeId),
    );
    await createCanvasObject(
      collaboratorContext.request,
      host.room.id,
      textObject(decisionId, "Decision: keep payment idempotent", 310, 330),
    );

    const groupResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
      {
        data: {
          command: {
            type: "group",
            groupId: "checkout-flow",
            targets: [
              { objectId: webNodeId, expectedRevision: 1 },
              { objectId: apiNodeId, expectedRevision: 1 },
            ],
          },
        },
      },
    );
    const grouped = await jsonBody<CommandResponse>(groupResponse);
    expect(grouped.room.objects[webNodeId]).toMatchObject({ groupId: "checkout-flow", revision: 2 });
    expect(grouped.room.objects[apiNodeId]).toMatchObject({ groupId: "checkout-flow", revision: 2 });

    const shared = await getRoom(page.request, host.room.id);
    expect(Object.keys(shared.room.objects)).toHaveLength(4);
    expect(shared.room.objects[webNodeId]).toMatchObject({
      kind: "shape",
      label: "Checkout web",
      revision: 2,
      groupId: "checkout-flow",
      createdBy: { participantId: host.participantId, displayName: "Avery Architect", kind: "agent" },
    });
    expect(shared.room.objects[apiNodeId]).toMatchObject({
      kind: "shape",
      label: "Orders API",
      revision: 2,
      groupId: "checkout-flow",
      createdBy: { participantId: collaborator.participantId, displayName: "Blair Builder", kind: "agent" },
    });
    expect(shared.room.objects[connectorId]).toMatchObject({
      kind: "connector",
      label: "POST /orders",
      start: { objectId: webNodeId },
      end: { objectId: apiNodeId },
    });
    expect(shared.room.participants[host.participantId].agentActive).toBe(true);
    expect(shared.room.participants[collaborator.participantId].agentActive).toBe(true);

    const hostLeaseResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
      {
        data: {
          action: "acquire",
          objectId: decisionId,
          expectedRevision: 1,
          operation: "edit",
        },
      },
    );
    const hostLease = await jsonBody<LeaseResponse>(hostLeaseResponse);
    expect(hostLease.lease).toMatchObject({ objectId: decisionId, operation: "edit" });
    if (!hostLease.lease) throw new Error("Host did not receive an object lease.");

    const blockedResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
      {
        data: {
          command: {
            type: "update",
            objectId: decisionId,
            expectedRevision: 1,
            operation: "edit",
            patch: { content: "Decision: process payments asynchronously" },
          },
        },
      },
    );
    const blocked = await jsonBody<ApiFailure>(blockedResponse, 409);
    expect(blocked).toMatchObject({
      ok: false,
      error: {
        code: "OBJECT_BUSY",
        details: {
          objectId: decisionId,
          operation: "edit",
          currentRevision: 1,
          actor: {
            participantId: host.participantId,
            displayName: "Avery Architect",
            kind: "agent",
          },
        },
      },
    });

    const releaseResponse = await page.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
      {
        data: {
          action: "release",
          objectId: decisionId,
          leaseId: hostLease.lease.leaseId,
        },
      },
    );
    await jsonBody<LeaseResponse>(releaseResponse);

    const collaboratorLeaseResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
      {
        data: {
          action: "acquire",
          objectId: decisionId,
          expectedRevision: 1,
          operation: "edit",
        },
      },
    );
    const collaboratorLease = await jsonBody<LeaseResponse>(collaboratorLeaseResponse);
    if (!collaboratorLease.lease) throw new Error("Collaborator did not receive an object lease.");

    const updateResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/commands`,
      {
        data: {
          command: {
            type: "update",
            objectId: decisionId,
            expectedRevision: 1,
            leaseId: collaboratorLease.lease.leaseId,
            operation: "edit",
            patch: { content: "Decision: process payments asynchronously" },
          },
        },
      },
    );
    const updated = await jsonBody<CommandResponse>(updateResponse);
    expect(updated.changedObjectIds).toEqual([decisionId]);
    expect(updated.room.objects[decisionId]).toMatchObject({
      revision: 2,
      content: "Decision: process payments asynchronously",
      lastEditedBy: {
        participantId: collaborator.participantId,
        displayName: "Blair Builder",
        kind: "agent",
      },
    });

    const collaboratorReleaseResponse = await collaboratorContext.request.post(
      `/api/rooms/${encodeURIComponent(host.room.id)}/agent/leases`,
      {
        data: {
          action: "release",
          objectId: decisionId,
          leaseId: collaboratorLease.lease.leaseId,
        },
      },
    );
    await jsonBody<LeaseResponse>(collaboratorReleaseResponse);

    await selectBoardMenuItem(page, "Canvas outline");
    const hostOutline = page.getByRole("complementary", { name: "Canvas outline" });
    await expect(hostOutline.getByText("4 objects")).toBeVisible({ timeout: 10_000 });
    await expect(hostOutline.getByText("Checkout web", { exact: true })).toBeVisible();
    await expect(hostOutline.getByText("Orders API", { exact: true })).toBeVisible();
    await expect(hostOutline.getByText("POST /orders", { exact: true })).toBeVisible();
    await expect(hostOutline.getByText("Decision: process payments asynchronously", { exact: true })).toBeVisible();

    await selectBoardMenuItem(collaboratorPage, "Canvas outline");
    const collaboratorOutline = collaboratorPage.getByRole("complementary", { name: "Canvas outline" });
    await expect(collaboratorOutline.getByText("4 objects")).toBeVisible({ timeout: 10_000 });
    await expect(
      collaboratorOutline.getByText("Decision: process payments asynchronously", { exact: true }),
    ).toBeVisible();

    const finalRoom = await getRoom(collaboratorContext.request, host.room.id);
    expect(finalRoom.room.leases).toEqual({});
    expect(finalRoom.room.objects[decisionId].revision).toBe(2);
  } finally {
    await collaboratorContext.close();
  }
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "@/lib/client/api";
import type { AgentMessage } from "@/lib/agent-messages/types";
import type { ActorRef, CanvasObject } from "@/lib/domain/types";

import { AskAgentPanel } from "./AskAgentPanel";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, apiRequest: vi.fn() };
});

const human: ActorRef = {
  participantId: "person_1",
  displayName: "Ari",
  color: "#5965e8",
  kind: "human",
};

const agent: ActorRef = { ...human, displayName: "Ari's agent", kind: "agent" };

const selectedObject: CanvasObject = {
  id: "node_gateway",
  kind: "shape",
  shape: "rectangle",
  label: "API gateway",
  nodeType: "service",
  nodeMetadata: null,
  fill: "#ffffff",
  stroke: "#111111",
  x: 10,
  y: 20,
  width: 180,
  height: 80,
  rotation: 0,
  zIndex: 1,
  revision: 7,
  groupId: null,
  diagramIds: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  createdBy: human,
  lastEditedBy: human,
};

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "message_1",
    sequence: 1,
    version: 1,
    state: "pending",
    prompt: "Check whether this is the right boundary.",
    createdAt: 1_000,
    author: human,
    context: {
      room: { id: "room/a b", title: "Architecture", roomRevision: 9 },
      selection: {
        objectIds: [selectedObject.id],
        objects: [selectedObject],
        missingObjectIds: [],
        diagrams: [],
        bounds: { x: 10, y: 20, width: 180, height: 80 },
      },
    },
    claimedUntil: null,
    reply: null,
    ...overrides,
  };
}

function renderPanel(selection: CanvasObject[] = [selectedObject], props: Partial<Parameters<typeof AskAgentPanel>[0]> = {}) {
  return render(
    <AskAgentPanel
      roomId="room/a b"
      selection={selection}
      onClose={vi.fn()}
      onFocus={vi.fn()}
      onAnnounce={vi.fn()}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe("AskAgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, messages: [], totalMatched: 0, truncated: false });
  });

  it("keeps history accessible without a selection and explains why composing is disabled", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, messages: [message()], totalMatched: 1, truncated: false });
    renderPanel([]);

    expect(screen.getByRole("complementary", { name: "Ask your agent" })).toHaveAttribute("id", "ask-agent-panel");
    expect(await screen.findByText("Check whether this is the right boundary.")).toBeInTheDocument();
    expect(screen.getByText(/A selection is required/)).toBeInTheDocument();
    expect(screen.getByLabelText("What should your agent do?")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send to agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Ask your agent" })).toHaveFocus();
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/messages?limit=40",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("submits the frozen semantic selection with Cmd/Ctrl+Enter and refreshes immediately", async () => {
    const pending = message({ prompt: "Review this gateway." });
    let posted = false;
    vi.mocked(apiRequest).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        posted = true;
        return { ok: true, message: pending };
      }
      return {
        ok: true,
        messages: posted ? [pending] : [],
        totalMatched: posted ? 1 : 0,
        truncated: false,
      };
    });
    const announce = vi.fn();
    renderPanel([selectedObject], { onAnnounce: announce });
    const composer = screen.getByLabelText("What should your agent do?");

    expect(screen.getByText("API gateway")).toHaveTextContent("r7");
    fireEvent.change(composer, { target: { value: "  Review this gateway.  " } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "/api/rooms/room%2Fa%20b/messages",
      {
        method: "POST",
        body: expect.stringContaining('"selectedObjectIds":["node_gateway"]'),
      },
    ));
    const postCall = vi.mocked(apiRequest).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      prompt: "Review this gateway.",
      selectedObjectIds: ["node_gateway"],
      messageId: expect.stringMatching(/^message_/),
    });
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Message sent. Waiting for your agent to check Jazzboard."));
    expect(screen.getByText("Waiting for your agent to check Jazzboard")).toBeInTheDocument();
    expect(vi.mocked(apiRequest).mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2);
  });

  it("renders agent replies as text, focuses surviving context, and closes with Escape", async () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      messages: [message({
        state: "answered",
        reply: {
          id: "reply_1",
          text: "<img src=x onerror=alert(1)> Done safely.",
          outcome: "completed",
          createdAt: 2_000,
          author: agent,
        },
      })],
      totalMatched: 1,
      truncated: false,
    });
    const { container } = renderPanel([selectedObject], { onFocus, onClose });

    expect(await screen.findByText("<img src=x onerror=alert(1)> Done safely.")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show context" }));
    expect(onFocus).toHaveBeenCalledWith(["node_gateway"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reuses the message ID when a person retries an ambiguous failed send", async () => {
    let postCount = 0;
    vi.mocked(apiRequest).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        postCount += 1;
        if (postCount === 1) throw new Error("Connection lost after sending");
        return { ok: true, message: message({ prompt: "Inspect this." }) };
      }
      return { ok: true, messages: [], totalMatched: 0, truncated: false };
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText("What should your agent do?"), { target: { value: "Inspect this." } });

    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost after sending");
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(postCount).toBe(2));

    const ids = vi.mocked(apiRequest).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).messageId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("generates a new message ID when an ambiguous request is edited before retry", async () => {
    let postCount = 0;
    vi.mocked(apiRequest).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        postCount += 1;
        if (postCount === 1) throw new Error("Connection lost after sending");
        return { ok: true, message: message({ prompt: "Inspect this carefully." }) };
      }
      return { ok: true, messages: [], totalMatched: 0, truncated: false };
    });
    renderPanel();
    const composer = screen.getByLabelText("What should your agent do?");
    fireEvent.change(composer, { target: { value: "Inspect this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(postCount).toBe(1));
    expect(await screen.findByText("Connection lost after sending")).toBeInTheDocument();

    fireEvent.change(composer, { target: { value: "Inspect this carefully." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(postCount).toBe(2));

    const ids = vi.mocked(apiRequest).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).messageId);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("reconciles an ambiguous in-flight send from polling without announcing success twice", async () => {
    let resolvePost!: (value: { ok: true; message: AgentMessage }) => void;
    const postResponse = new Promise<{ ok: true; message: AgentMessage }>((resolve) => {
      resolvePost = resolve;
    });
    let attempted: AgentMessage | null = null;
    vi.mocked(apiRequest).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { messageId: string; prompt: string };
        attempted = message({ id: body.messageId, prompt: body.prompt });
        return postResponse;
      }
      return {
        ok: true,
        messages: attempted ? [attempted] : [],
        totalMatched: attempted ? 1 : 0,
        truncated: false,
      };
    });
    const announce = vi.fn();
    renderPanel([selectedObject], { onAnnounce: announce });
    await screen.findByText("No messages yet. Select something on the board and ask your agent about it.");
    const composer = screen.getByLabelText("What should your agent do?");
    fireEvent.change(composer, { target: { value: "Inspect ambiguous delivery." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(attempted).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    resolvePost({ ok: true, message: attempted! });
    await waitFor(() => expect(composer).not.toBeDisabled());
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("announces claimed and answered transitions discovered by polling", async () => {
    const pending = message();
    let state: "pending" | "claimed" | "answered" = "pending";
    vi.mocked(apiRequest).mockImplementation(async () => ({
      ok: true,
      messages: [message({
        state,
        claimedUntil: state === "claimed" ? Date.now() + 30_000 : null,
        reply: state === "answered" ? {
          id: "reply_transition",
          text: "The boundary is correct.",
          outcome: "completed",
          createdAt: 2_000,
          author: agent,
        } : null,
      })],
      totalMatched: 1,
      truncated: false,
    }));
    renderPanel();
    expect(await screen.findByText(pending.prompt)).toBeInTheDocument();

    state = "claimed";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(`Your agent started working on: ${pending.prompt}`)).toHaveAttribute("aria-live", "polite");

    state = "answered";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Your agent replied: Completed.")).toHaveAttribute("aria-live", "polite");
  });
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { announceMobileSurfaceOpen } from "./mobile-surface-coordinator";
import {
  MobileRoomCollaboration,
  type MobileCollaborationSurface,
} from "./MobileRoomCollaboration";

function Harness({ onShare = vi.fn(), onSpotlight = vi.fn() }: {
  onShare?: () => void;
  onSpotlight?: () => void;
}) {
  const [surface, setSurface] = useState<MobileCollaborationSurface>("closed");
  return (
    <MobileRoomCollaboration
      activeSurface={surface}
      canSpotlight
      connectionLabel="Live"
      connectionState="live"
      followContent={<button>{"Follow Ari's cursor"}</button>}
      followSummary="Choose a person's cursor or agent"
      peopleContent={<button>View Ari</button>}
      peopleLabel="2 people in this room · Your role: participant"
      participantCount={2}
      spotlightLabel="Spotlight"
      onOpen={() => undefined}
      onShare={() => {
        setSurface("closed");
        onShare();
      }}
      onSpotlight={() => {
        setSurface("closed");
        onSpotlight();
      }}
      onSurfaceChange={setSurface}
    />
  );
}

describe("MobileRoomCollaboration", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps every collaboration capability reachable from one compact launcher", () => {
    const onShare = vi.fn();
    const onSpotlight = vi.fn();
    render(<Harness onShare={onShare} onSpotlight={onSpotlight} />);

    const launcher = screen.getByRole("button", { name: "Open collaboration menu" });
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(launcher);

    expect(screen.getByRole("dialog", { name: "Collaborate" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Connection: Live" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /People/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Follow/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Spotlight/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Share/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Spotlight/ }));
    expect(onSpotlight).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open collaboration menu" }));
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(onShare).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses one drill-in surface at a time with an explicit back affordance", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open collaboration menu" }));
    fireEvent.click(screen.getByRole("button", { name: /People/ }));

    expect(screen.getByRole("dialog", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Ari" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow Ari's cursor" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to collaboration menu" }));
    fireEvent.click(screen.getByRole("button", { name: /Follow/ }));
    expect(screen.getByRole("dialog", { name: "Follow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Follow Ari's cursor" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View Ari" })).not.toBeInTheDocument();
  });

  it("closes by backdrop, Escape, or another coordinated mobile surface and restores focus", () => {
    render(<Harness />);
    const launcher = screen.getByRole("button", { name: "Open collaboration menu" });

    fireEvent.click(launcher);
    fireEvent.pointerDown(screen.getByTestId("mobile-collaboration-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();

    fireEvent.click(launcher);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();

    fireEvent.click(launcher);
    act(() => announceMobileSurfaceOpen("canvas-tools"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

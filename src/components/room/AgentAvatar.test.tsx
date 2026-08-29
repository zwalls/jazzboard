import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentAvatar,
  agentAvatarPrimaryColor,
  agentAvatarSeed,
  isAgentActivityWorking,
} from "./AgentAvatar";

afterEach(cleanup);

describe("AgentAvatar", () => {
  it("derives a stable Jazzboard-specific identity from the agent display name", () => {
    expect(agentAvatarSeed("Mira")).toBe("jazzboard-agent:Mira");

    const first = render(<AgentAvatar displayName="Mira" motion="none" />);
    const firstSource = first.container.querySelector("img")?.getAttribute("src");
    first.unmount();

    const repeat = render(<AgentAvatar displayName="Mira" motion="none" />);
    const repeatSource = repeat.container.querySelector("img")?.getAttribute("src");
    repeat.unmount();

    const other = render(<AgentAvatar displayName="Kai" motion="none" />);
    const otherSource = other.container.querySelector("img")?.getAttribute("src");

    expect(firstSource).toMatch(/^data:image\/svg\+xml/);
    expect(repeatSource).toBe(firstSource);
    expect(otherSource).not.toBe(firstSource);
  });

  it("exposes the generated body's primary color for matching UI chrome", () => {
    const primaryColor = agentAvatarPrimaryColor("Mira");
    const { container } = render(<AgentAvatar displayName="Mira" motion="none" />);
    const source = container.querySelector("img")?.getAttribute("src");

    expect(primaryColor).toBe("#a6b142");
    expect(decodeURIComponent(source ?? "")).toContain(`fill='${primaryColor}'`);
  });

  it("is decorative by default and supports an explicit accessible label", () => {
    const { container, rerender } = render(
      <AgentAvatar displayName="Mira" motion="none" participantColor="#1a9c75" size={40} />,
    );
    const avatar = container.firstElementChild as HTMLElement;

    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).not.toHaveAttribute("role");
    expect(avatar.style.getPropertyValue("--agent-avatar-accent")).toBe("#1a9c75");
    expect(avatar.style.getPropertyValue("--agent-avatar-size")).toBe("40px");
    expect(container.querySelector("img")).toHaveAttribute("alt", "");

    rerender(
      <AgentAvatar
        accessibleLabel="Mira’s agent"
        displayName="Mira"
        motion="none"
        participantColor="#1a9c75"
        size={40}
      />,
    );

    expect(screen.getByRole("img", { name: "Mira’s agent" })).toBe(container.firstElementChild);
  });

  it("offers static, hover, and continuously thinking render modes", () => {
    const { container, rerender } = render(
      <AgentAvatar displayName="Mira" motion="none" state="idle" />,
    );
    const avatar = () => container.firstElementChild as HTMLElement;

    expect(avatar()).toHaveAttribute("data-agent-avatar-motion", "none");
    expect(avatar()).toHaveAttribute("data-agent-avatar-state", "idle");
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();

    rerender(<AgentAvatar displayName="Mira" motion="hover" state="idle" />);
    expect(avatar()).toHaveAttribute("data-agent-avatar-motion", "hover");
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("svg > path")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();

    rerender(<AgentAvatar displayName="Mira" state="working" />);
    expect(avatar()).toHaveAttribute("data-agent-avatar-motion", "always");
    expect(avatar()).toHaveAttribute("data-agent-avatar-state", "working");
    const thinkingFigure = container.querySelector("svg");
    expect(thinkingFigure).toBeInTheDocument();
    expect(thinkingFigure?.querySelector(".mo-expr")).toBeInTheDocument();
    expect(Number((thinkingFigure as SVGElement).style.getPropertyValue("--mo-rock"))).toBeGreaterThan(0);
  });

  it("clamps undersized avatars to a usable minimum", () => {
    const { container } = render(<AgentAvatar displayName="Mira" motion="none" size={4} />);
    const avatar = container.firstElementChild as HTMLElement;

    expect(avatar.style.getPropertyValue("--agent-avatar-size")).toBe("16px");
    expect(container.querySelector("img")).toHaveAttribute("width", "16");
    expect(container.querySelector("img")).toHaveAttribute("height", "16");
  });

  it("stops showing the thinking state after the activity and settle window end", () => {
    const activity = {
      id: "activity_1",
      type: "creating" as const,
      label: "Building a flow",
      objectIds: [],
      progress: 0.5,
      startedAt: 10_000,
      durationMs: 2_000,
    };

    expect(isAgentActivityWorking(activity, 9_000)).toBe(true);
    expect(isAgentActivityWorking(activity, 13_599)).toBe(true);
    expect(isAgentActivityWorking(activity, 13_600)).toBe(false);
    expect(isAgentActivityWorking(null, 10_000)).toBe(false);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentAvatar, agentAvatarPrimaryColor, agentAvatarSeed, isAgentActivityWorking } from "./AgentAvatar";

afterEach(cleanup);

describe("AgentAvatar", () => {
  it("derives a stable Ripple identity with name-based shape, color, and proportions", () => {
    expect(agentAvatarSeed("Mira")).toBe("jazzboard-agent:Mira");
    const first = render(<AgentAvatar displayName="Mira" motion="none" />);
    const firstPath = first.container.querySelector("[data-ripple-body]")?.getAttribute("d");
    const firstColor = agentAvatarPrimaryColor("Mira");
    const firstEyes = Array.from(first.container.querySelectorAll("rect")).map((eye) => [eye.getAttribute("x"), eye.getAttribute("height")]);
    first.unmount();

    const repeat = render(<AgentAvatar displayName="Mira" motion="none" />);
    expect(repeat.container.querySelector("[data-ripple-body]")?.getAttribute("d")).toBe(firstPath);
    expect(Array.from(repeat.container.querySelectorAll("rect")).map((eye) => [eye.getAttribute("x"), eye.getAttribute("height")])).toEqual(firstEyes);
    repeat.unmount();

    const other = render(<AgentAvatar displayName="Kai" motion="none" />);
    expect(other.container.querySelector("[data-ripple-body]")?.getAttribute("d")).not.toBe(firstPath);
    expect(agentAvatarPrimaryColor("Kai")).not.toBe(firstColor);
  });

  it("uses unique native SVG gradient ids for co-located instances", () => {
    const { container } = render(<><AgentAvatar displayName="Mira" motion="none" /><AgentAvatar displayName="Kai" motion="none" /></>);
    const ids = Array.from(
      container.querySelectorAll("linearGradient, radialGradient"),
      (gradient) => gradient.id,
    );
    const fills = Array.from(container.querySelectorAll("[data-ripple-body]"), (body) => body.getAttribute("fill"));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fills).toHaveLength(2);
    expect(fills[0]).not.toBe(fills[1]);
    fills.forEach((fill) => expect(ids).toContain(fill?.slice(5, -1)));
  });

  it("exposes the generated body's primary color for matching UI chrome", () => {
    const primaryColor = agentAvatarPrimaryColor("Mira");
    const { container } = render(<AgentAvatar displayName="Mira" motion="none" />);
    const stops = Array.from(container.querySelectorAll("stop"));
    expect(primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(stops.some((stop) => stop.getAttribute("stop-color") === primaryColor)).toBe(true);
  });

  it("is decorative by default and supports an explicit accessible label", () => {
    const { container, rerender } = render(<AgentAvatar displayName="Mira" motion="none" participantColor="#1a9c75" size={40} />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar).toHaveAttribute("data-agent-avatar-family", "mochi");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).not.toHaveAttribute("role");
    expect(avatar.style.getPropertyValue("--agent-avatar-accent")).toBe("#1a9c75");
    expect(avatar.style.getPropertyValue("--agent-avatar-size")).toBe("40px");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    rerender(<AgentAvatar accessibleLabel="Mira’s agent" displayName="Mira" motion="none" participantColor="#1a9c75" size={40} />);
    expect(screen.getByRole("img", { name: "Mira’s agent" })).toBe(container.firstElementChild);
  });

  it("offers static, hover, and continuously working render modes", () => {
    const { container, rerender } = render(<AgentAvatar displayName="Mira" motion="none" state="idle" />);
    const avatar = () => container.firstElementChild as HTMLElement;
    expect(avatar()).toHaveAttribute("data-agent-avatar-motion", "none");
    expect(avatar()).toHaveAttribute("data-agent-avatar-state", "idle");
    expect(container.querySelector("svg")).toBeInTheDocument();
    rerender(<AgentAvatar displayName="Mira" motion="hover" state="idle" />);
    expect(avatar()).toHaveAttribute("data-agent-avatar-motion", "hover");
    rerender(<AgentAvatar displayName="Mira" state="working" />);
    expect(avatar()).toHaveAttribute("data-agent-avatar-motion", "always");
    expect(avatar()).toHaveAttribute("data-agent-avatar-state", "working");
  });

  it("clamps undersized avatars to a usable minimum", () => {
    const { container } = render(<AgentAvatar displayName="Mira" motion="none" size={4} />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar.style.getPropertyValue("--agent-avatar-size")).toBe("16px");
    expect(container.querySelector("svg")).toHaveAttribute("width", "16");
    expect(container.querySelector("svg")).toHaveAttribute("height", "16");
  });

  it("stops showing the thinking state after the activity and settle window end", () => {
    const activity = { id: "activity_1", type: "creating" as const, label: "Building a flow", objectIds: [], progress: 0.5, startedAt: 10_000, durationMs: 2_000 };
    expect(isAgentActivityWorking(activity, 9_000)).toBe(true);
    expect(isAgentActivityWorking(activity, 13_599)).toBe(true);
    expect(isAgentActivityWorking(activity, 13_600)).toBe(false);
    expect(isAgentActivityWorking(null, 10_000)).toBe(false);
  });
});

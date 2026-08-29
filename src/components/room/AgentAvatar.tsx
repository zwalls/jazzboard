"use client";

import { Blobatar } from "@blobatar/react";
import { palette, traits } from "blobatar";
import { thinking } from "blobatar/expression";
import "blobatar/motion.css";
import type { CSSProperties } from "react";

import type { AgentActivity } from "@/lib/domain/types";

import styles from "./agent-avatar.module.css";

export type AgentAvatarState = "idle" | "working";
export type AgentAvatarMotion = "none" | "hover" | "always";

export type AgentAvatarProps = {
  displayName: string;
  participantColor?: string;
  size?: number;
  state?: AgentAvatarState;
  motion?: AgentAvatarMotion;
  className?: string;
  accessibleLabel?: string;
};

export function agentAvatarSeed(displayName: string) {
  return `jazzboard-agent:${displayName}`;
}

export function agentAvatarPrimaryColor(displayName: string) {
  const seedTraits = traits(agentAvatarSeed(displayName));
  return palette(
    seedTraits.num("hue", 0, 360),
    true,
    seedTraits("tone"),
  ).head ?? "#5965e8";
}

export function isAgentActivityWorking(activity: AgentActivity | null, now: number) {
  if (!activity) return false;
  const elapsed = Math.max(now - activity.startedAt, 0);
  return elapsed < Math.max(activity.durationMs ?? 1, 1) + 1_600;
}

export function AgentAvatar({
  displayName,
  participantColor = "#5965e8",
  size = 32,
  state = "idle",
  motion,
  className,
  accessibleLabel,
}: AgentAvatarProps) {
  const resolvedMotion = motion ?? (state === "working" ? "always" : "hover");
  const seed = agentAvatarSeed(displayName);
  const avatarSize = Math.max(16, size);
  const avatarStyle = {
    "--agent-avatar-accent": participantColor,
    "--agent-avatar-size": `${avatarSize}px`,
  } as CSSProperties;
  const wrapperClassName = [styles.avatar, className].filter(Boolean).join(" ");
  const commonOptions = {
    name: seed,
    size: avatarSize,
    background: false,
    expression: state === "working" ? thinking : undefined,
  };

  return (
    <span
      aria-hidden={accessibleLabel ? undefined : true}
      aria-label={accessibleLabel}
      className={wrapperClassName}
      data-agent-avatar-motion={resolvedMotion}
      data-agent-avatar-state={state}
      role={accessibleLabel ? "img" : undefined}
      style={avatarStyle}
    >
      {resolvedMotion === "none" ? (
        <Blobatar {...commonOptions} alt="" draggable={false} />
      ) : (
        <Blobatar
          {...commonOptions}
          animate={resolvedMotion}
          aria-hidden="true"
          focusable="false"
        />
      )}
    </span>
  );
}

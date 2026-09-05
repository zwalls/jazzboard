"use client";

import { useEffect, useId, useState, type CSSProperties } from "react";

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

type Point = { x: number; y: number };

const RIPPLE_COLORS = [
  "#ff9d73", "#8f85ef", "#67c7aa", "#f2bd54",
  "#6ca9ef", "#ef7da4", "#7fc66a", "#bf84df",
] as const;

function hashSeed(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function seededFraction(seed: number, salt: number) {
  let value = seed + Math.imul(salt, 0x9e3779b1);
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4_294_967_296;
}

function mixHex(color: string, target: string, amount: number) {
  const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return `#${[1, 3, 5].map((offset) =>
    Math.round(channel(color, offset) + (channel(target, offset) - channel(color, offset)) * amount)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
}

function closedCurve(points: Point[]) {
  const coordinate = (value: number) => Number(value.toFixed(2));
  const parts = [`M ${coordinate(points[0].x)} ${coordinate(points[0].y)}`];
  points.forEach((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const afterNext = points[(index + 2) % points.length];
    const control = 1 / 6;
    parts.push(
      `C ${coordinate(point.x + (next.x - previous.x) * control)} ${coordinate(point.y + (next.y - previous.y) * control)}`,
      `${coordinate(next.x - (afterNext.x - point.x) * control)} ${coordinate(next.y - (afterNext.y - point.y) * control)}`,
      `${coordinate(next.x)} ${coordinate(next.y)}`,
    );
  });
  return `${parts.join(" ")} Z`;
}

function ripplePath(seed: number) {
  const pointCount = 80;
  const phase = -Math.PI / 2 + (seededFraction(seed, 1) - 0.5) * 0.13;
  const amplitude = 0.16 + seededFraction(seed, 2) * 0.035;
  const width = 21.6 * (0.95 + seededFraction(seed, 3) * 0.1);
  const height = 21.2 * (0.95 + seededFraction(seed, 4) * 0.1);
  const organicPhase = seededFraction(seed, 5) * Math.PI * 2;
  const points = Array.from({ length: pointCount }, (_, index) => {
    const angle = -Math.PI / 2 + (index / pointCount) * Math.PI * 2;
    const ripple = 1 + amplitude * Math.cos(5 * (angle - phase));
    const organic = 1 + 0.018 * Math.cos(2 * angle + organicPhase);
    return {
      x: 32 + Math.cos(angle) * width * ripple * organic,
      y: 32.5 + Math.sin(angle) * height * ripple,
    };
  });
  return closedCurve(points);
}

export function agentAvatarSeed(displayName: string) {
  return `jazzboard-agent:${displayName}`;
}

export function agentAvatarPrimaryColor(displayName: string) {
  const seed = hashSeed(agentAvatarSeed(displayName));
  return RIPPLE_COLORS[seed % RIPPLE_COLORS.length];
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
  const seedName = agentAvatarSeed(displayName);
  const seed = hashSeed(seedName);
  const avatarSize = Math.max(16, size);
  const primaryColor = agentAvatarPrimaryColor(displayName);
  const highlightColor = mixHex(primaryColor, "#ffffff", 0.36);
  const shadeColor = mixHex(primaryColor, "#362747", 0.24);
  const eyeSpacing = 6.2 + seededFraction(seed, 6) * 2.6;
  const eyeHeight = 8 + seededFraction(seed, 7) * 1.4;
  const eyeY = 32 + seededFraction(seed, 8) * 2;
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const bodyGradientId = `ripple-body-${instanceId}`;
  const surfaceGradientId = `ripple-surface-${instanceId}`;
  const undersideGradientId = `ripple-underside-${instanceId}`;
  const eyeGradientId = `ripple-eyes-${instanceId}`;
  const shadowGradientId = `ripple-shadow-${instanceId}`;
  const bodyPath = ripplePath(seed);
  const [documentHidden, setDocumentHidden] = useState(false);

  useEffect(() => {
    const syncVisibility = () => setDocumentHidden(document.visibilityState === "hidden");
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  const avatarStyle = {
    "--agent-avatar-accent": participantColor,
    "--agent-avatar-size": `${avatarSize}px`,
  } as CSSProperties;
  const wrapperClassName = [styles.avatar, className].filter(Boolean).join(" ");

  return (
    <span
      aria-hidden={accessibleLabel ? undefined : true}
      aria-label={accessibleLabel}
      className={wrapperClassName}
      data-agent-avatar-motion={resolvedMotion}
      data-agent-avatar-paused={documentHidden ? "true" : undefined}
      data-agent-avatar-state={state}
      role={accessibleLabel ? "img" : undefined}
      style={avatarStyle}
    >
      <svg
        aria-hidden="true"
        className={styles.rippleFigure}
        data-ripple-seed={seedName}
        focusable="false"
        height={avatarSize}
        viewBox="0 0 64 64"
        width={avatarSize}
      >
        <defs>
          <linearGradient id={bodyGradientId} x1="12%" x2="90%" y1="8%" y2="92%">
            <stop offset="0%" stopColor={highlightColor} />
            <stop offset="48%" stopColor={primaryColor} />
            <stop offset="100%" stopColor={shadeColor} />
          </linearGradient>
          <radialGradient
            cx="23"
            cy="18"
            gradientUnits="userSpaceOnUse"
            id={surfaceGradientId}
            r="38"
          >
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.38" />
            <stop offset="54%" stopColor="#ffffff" stopOpacity="0.09" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={undersideGradientId}
            x1="32"
            x2="32"
            y1="28"
            y2="57"
          >
            <stop offset="45%" stopColor={shadeColor} stopOpacity="0" />
            <stop offset="100%" stopColor={shadeColor} stopOpacity="0.34" />
          </linearGradient>
          <linearGradient id={eyeGradientId} x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#44334b" />
            <stop offset="48%" stopColor="#271a2e" />
            <stop offset="100%" stopColor="#170e1c" />
          </linearGradient>
          <radialGradient id={shadowGradientId}>
            <stop offset="0%" stopColor={shadeColor} stopOpacity="0.34" />
            <stop offset="100%" stopColor={shadeColor} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="32" cy="55.2" fill={`url(#${shadowGradientId})`} rx="20" ry="2.6" />
        <g className={styles.rippleCharacter}>
          <path
            className={styles.rippleBody}
            d={bodyPath}
            data-ripple-body="true"
            fill={`url(#${bodyGradientId})`}
          />
          <path d={bodyPath} fill={`url(#${surfaceGradientId})`} pointerEvents="none" />
          <path d={bodyPath} fill={`url(#${undersideGradientId})`} pointerEvents="none" />
          <path
            d={bodyPath}
            fill="none"
            opacity="0.18"
            pointerEvents="none"
            stroke={shadeColor}
            strokeWidth="0.65"
          />
          <g className={styles.rippleEyes} fill={`url(#${eyeGradientId})`}>
            <rect height={eyeHeight} rx="1.7" width="3.4" x={32 - eyeSpacing / 2 - 1.7} y={eyeY - eyeHeight / 2} />
            <rect height={eyeHeight} rx="1.7" width="3.4" x={32 + eyeSpacing / 2 - 1.7} y={eyeY - eyeHeight / 2} />
          </g>
        </g>
      </svg>
    </span>
  );
}

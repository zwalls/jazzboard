"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

import type { AgentActivity } from "@/lib/domain/types";
import { registerRippleGaze } from "@/lib/client/ripple-gaze";

import styles from "./agent-avatar.module.css";
import { requestRippleBody, rippleRasterSize } from "./ripple-body-cache";
import { ripplePrimaryColor, rippleTraitsFor } from "./ripple-traits";

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

function ripplePath(displayName: string) {
  const traits = rippleTraitsFor(displayName);
  const pointCount = 80;
  const points = Array.from({ length: pointCount }, (_, index) => {
    const angle = -Math.PI / 2 + (index / pointCount) * Math.PI * 2;
    const modulation = 1 + traits.lobeVariation * Math.cos(angle + traits.lobeVariationPhase);
    const lobes = traits.lobeAmplitude * modulation * Math.cos(5 * (angle - traits.lobePhase));
    const asymmetry = traits.asymmetry * Math.cos(2 * angle + traits.asymmetryPhase);
    const boundary = 1 + lobes + asymmetry;
    return {
      x: 32 + Math.cos(angle) * traits.width * boundary * 32,
      y: 32 + Math.sin(angle) * traits.height * boundary * 32,
    };
  });
  return closedCurve(points);
}

export function agentAvatarSeed(displayName: string) {
  return `jazzboard-agent:${displayName}`;
}

export function agentAvatarPrimaryColor(displayName: string) {
  return ripplePrimaryColor(displayName);
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
  const model = useMemo(() => {
    const traits = rippleTraitsFor(displayName);
    const primaryColor = ripplePrimaryColor(displayName);
    return {
      traits,
      primaryColor,
      highlightColor: mixHex(primaryColor, "#ffffff", 0.36),
      shadeColor: mixHex(primaryColor, "#362747", 0.24),
      bodyPath: ripplePath(displayName),
    };
  }, [displayName]);
  const eyeCenters = model.traits.eyeSpacing / 2;
  const eyeHalfWidth = 0.047 * 32;
  const eyeHalfHeight = (model.traits.eyeHeight / 2) * 32;
  const eyeY = (model.traits.eyeY + 1) * 32;
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const bodyGradientId = `ripple-body-${instanceId}`;
  const surfaceGradientId = `ripple-surface-${instanceId}`;
  const undersideGradientId = `ripple-underside-${instanceId}`;
  const fallbackEyeGradientId = `ripple-fallback-eyes-${instanceId}`;
  const rasterEyeGradientId = `ripple-raster-eyes-${instanceId}`;
  const shadowGradientId = `ripple-shadow-${instanceId}`;
  const [documentHidden, setDocumentHidden] = useState(false);
  const [readyRasterKey, setReadyRasterKey] = useState<string | null>(null);
  const avatarRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rasterSize = rippleRasterSize(
    avatarSize,
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  );

  useEffect(() => {
    const syncVisibility = () => setDocumentHidden(document.visibilityState === "hidden");
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    const element = avatarRef.current;
    if (!element) return;
    return registerRippleGaze(element, resolvedMotion !== "none");
  }, [resolvedMotion]);

  useEffect(() => {
    let active = true;
    void requestRippleBody(displayName, rasterSize).then((body) => {
      if (!active || !body || !canvasRef.current) return;
      try {
        const context = canvasRef.current.getContext("2d");
        if (!context) return;
        canvasRef.current.width = body.width;
        canvasRef.current.height = body.height;
        context.putImageData(new ImageData(body.data, body.width, body.height), 0, 0);
        setReadyRasterKey(`${displayName}\u0000${rasterSize}`);
      } catch {
        // Canvas support is an enhancement; the SVG remains visible on failure.
      }
    });
    return () => {
      active = false;
    };
  }, [displayName, rasterSize]);

  const rasterReady = readyRasterKey === `${displayName}\u0000${rasterSize}`;

  const avatarStyle = {
    "--agent-avatar-accent": participantColor,
    "--agent-avatar-size": `${avatarSize}px`,
    "--ripple-idle-delay": `${-(seed % 7_000)}ms`,
    "--ripple-idle-duration": `${9 + (seed % 3_500) / 1_000}s`,
    "--ripple-look-x": `${(seededFraction(seed, 20) - 0.5) * avatarSize * 0.045}px`,
    "--ripple-look-y": `${(seededFraction(seed, 21) - 0.5) * avatarSize * 0.018}px`,
    "--ripple-look-back-x": `${(0.5 - seededFraction(seed, 20)) * avatarSize * 0.029}px`,
    "--ripple-look-back-y": `${(seededFraction(seed, 21) - 0.5) * avatarSize * 0.006}px`,
  } as CSSProperties;
  const wrapperClassName = [styles.avatar, className].filter(Boolean).join(" ");

  return (
    <span
      aria-hidden={accessibleLabel ? undefined : true}
      aria-label={accessibleLabel}
      className={wrapperClassName}
      data-agent-avatar-motion={resolvedMotion}
      data-agent-avatar-paused={documentHidden ? "true" : undefined}
      data-agent-avatar-raster={rasterReady ? "ready" : "fallback"}
      data-agent-avatar-state={state}
      ref={avatarRef}
      role={accessibleLabel ? "img" : undefined}
      style={avatarStyle}
    >
      <svg
        aria-hidden="true"
        className={styles.fallbackFigure}
        data-ripple-seed={seedName}
        focusable="false"
        height={avatarSize}
        viewBox="0 0 64 64"
        width={avatarSize}
      >
        <defs>
          <linearGradient id={bodyGradientId} x1="12%" x2="90%" y1="8%" y2="92%">
            <stop offset="0%" stopColor={model.highlightColor} />
            <stop offset="48%" stopColor={model.primaryColor} />
            <stop offset="100%" stopColor={model.shadeColor} />
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
            <stop offset="45%" stopColor={model.shadeColor} stopOpacity="0" />
            <stop offset="100%" stopColor={model.shadeColor} stopOpacity="0.34" />
          </linearGradient>
          <linearGradient id={fallbackEyeGradientId} x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#44334b" />
            <stop offset="48%" stopColor="#271a2e" />
            <stop offset="100%" stopColor="#170e1c" />
          </linearGradient>
          <radialGradient id={shadowGradientId}>
            <stop offset="0%" stopColor={model.shadeColor} stopOpacity="0.34" />
            <stop offset="100%" stopColor={model.shadeColor} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="32" cy="55.2" fill={`url(#${shadowGradientId})`} rx="20" ry="2.6" />
        <g className={styles.rippleCharacter}>
          <path
            className={styles.rippleBody}
            d={model.bodyPath}
            data-ripple-body="true"
            fill={`url(#${bodyGradientId})`}
          />
          <path d={model.bodyPath} fill={`url(#${surfaceGradientId})`} pointerEvents="none" />
          <path d={model.bodyPath} fill={`url(#${undersideGradientId})`} pointerEvents="none" />
          <path
            d={model.bodyPath}
            fill="none"
            opacity="0.18"
            pointerEvents="none"
            stroke={model.shadeColor}
            strokeWidth="0.65"
          />
          <g className={styles.rippleGaze}>
            <g className={styles.rippleLook}>
              <g className={styles.rippleEyes} fill={`url(#${fallbackEyeGradientId})`}>
                <rect
                  height={eyeHalfHeight * 2}
                  rx="1.38"
                  width={eyeHalfWidth * 2}
                  x={(1 - eyeCenters) * 32 - eyeHalfWidth}
                  y={eyeY - eyeHalfHeight}
                />
                <rect
                  height={eyeHalfHeight * 2}
                  rx="1.38"
                  width={eyeHalfWidth * 2}
                  x={(1 + eyeCenters) * 32 - eyeHalfWidth}
                  y={eyeY - eyeHalfHeight}
                />
              </g>
            </g>
          </g>
        </g>
      </svg>
      <span className={styles.rasterCharacter} aria-hidden="true">
        <canvas className={styles.rasterBody} ref={canvasRef} />
        <svg className={styles.rasterFace} focusable="false" viewBox="0 0 64 64">
          <defs>
            <linearGradient id={rasterEyeGradientId} x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stopColor="#44334b" />
              <stop offset="48%" stopColor="#271a2e" />
              <stop offset="100%" stopColor="#170e1c" />
            </linearGradient>
          </defs>
          <g className={styles.rippleGaze}>
            <g className={styles.rippleLook}>
              <g className={styles.rippleEyes} fill={`url(#${rasterEyeGradientId})`}>
                <rect
                  height={eyeHalfHeight * 2}
                  rx="1.38"
                  width={eyeHalfWidth * 2}
                  x={(1 - eyeCenters) * 32 - eyeHalfWidth}
                  y={eyeY - eyeHalfHeight}
                />
                <rect
                  height={eyeHalfHeight * 2}
                  rx="1.38"
                  width={eyeHalfWidth * 2}
                  x={(1 + eyeCenters) * 32 - eyeHalfWidth}
                  y={eyeY - eyeHalfHeight}
                />
              </g>
            </g>
          </g>
        </svg>
      </span>
    </span>
  );
}

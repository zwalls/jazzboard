/// <reference types="webmcp-types" />

import type { RecentRoom } from "@/lib/domain/types";

import { JazzboardLandingWebMcpRegistrar } from "./landing-registration";
import type {
  JazzboardLandingWebMcpContext,
  JazzboardLandingWebMcpRegistrationStatus,
} from "./landing-types";

export const JAZZBOARD_RECENT_ROOMS_EVENT = "jazzboard:recent-rooms-changed";

type LandingBootstrapState = {
  context: JazzboardLandingWebMcpContext | null;
  registrar: JazzboardLandingWebMcpRegistrar;
  registration: Promise<JazzboardLandingWebMcpRegistrationStatus> | null;
};

declare global {
  var __jazzboardLandingWebMcpBootstrap: LandingBootstrapState | undefined;

  interface WindowEventMap {
    [JAZZBOARD_RECENT_ROOMS_EVENT]: CustomEvent<RecentRoom[]>;
  }
}

function bootstrapState(): LandingBootstrapState {
  globalThis.__jazzboardLandingWebMcpBootstrap ??= {
    context: null,
    registrar: new JazzboardLandingWebMcpRegistrar(),
    registration: null,
  };
  return globalThis.__jazzboardLandingWebMcpBootstrap;
}

function fallbackAcceptRecentRooms(rooms: RecentRoom[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RecentRoom[]>(JAZZBOARD_RECENT_ROOMS_EVENT, { detail: rooms }),
  );
}

function fallbackNavigateToRoom(roomId: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(new URL(`/room/${encodeURIComponent(roomId)}`, window.location.href).href);
}

/**
 * Register the landing lifecycle surface once for the current document.
 *
 * This module is imported by `instrumentation-client.ts`, which Next runs
 * before React hydration. The stable bridge lets those tools execute even
 * before the landing component attaches its UI callbacks.
 */
export function ensureLandingWebMcpBootstrap(): Promise<JazzboardLandingWebMcpRegistrationStatus> {
  const state = bootstrapState();
  if (state.registration) return state.registration;

  state.registration = state.registrar
    .update({
      context: {
        acceptRecentRooms(rooms) {
          (state.context?.acceptRecentRooms ?? fallbackAcceptRecentRooms)(rooms);
        },
        navigateToRoom(roomId) {
          (state.context?.navigateToRoom ?? fallbackNavigateToRoom)(roomId);
        },
      },
    })
    .catch((error) => {
      state.registration = null;
      throw error;
    });

  return state.registration;
}

/** Attach hydrated UI callbacks without replacing or re-registering tools. */
export function attachLandingWebMcpContext(
  context: JazzboardLandingWebMcpContext,
): Promise<JazzboardLandingWebMcpRegistrationStatus> {
  const state = bootstrapState();
  state.context = context;
  return ensureLandingWebMcpBootstrap();
}

/**
 * Detach hydrated callbacks while retaining the pre-hydration registration.
 *
 * React development mode intentionally mounts, cleans up, and remounts effects.
 * Disposing the registrar from that cleanup would therefore unregister and
 * register every landing tool a second time after hydration. Route transitions
 * are the lifecycle boundary that should dispose the surface instead.
 */
export function detachLandingWebMcpContext(
  context: JazzboardLandingWebMcpContext,
): void {
  const state = globalThis.__jazzboardLandingWebMcpBootstrap;
  if (state?.context === context) state.context = null;
}

/** Remove the landing surface before a room registers its role-scoped tools. */
export function disposeLandingWebMcpBootstrap(
  context?: JazzboardLandingWebMcpContext,
): void {
  const state = globalThis.__jazzboardLandingWebMcpBootstrap;
  if (!state || (context && state.context !== context)) return;
  state.context = null;
  state.registrar.dispose();
  state.registration = null;
}

import {
  createGuestBootstrapToken,
  GUEST_BOOTSTRAP_HEADER,
} from "@/lib/guest-bootstrap";
import {
  CLIENT_CAPABILITIES_HEADER,
  SPLIT_STATE_CLIENT_CAPABILITY,
} from "@/lib/realtime/protocol";

export type ApiFailure = {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  recovery?: {
    retry: "after_correction" | "after_refresh" | "after_wait" | "verify_before_retry" | "do_not_retry";
    instructions: string;
    suggestedTools?: string[];
  };
};

export class JazzboardApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly failure: ApiFailure,
  ) {
    super(failure.message);
    this.name = "JazzboardApiError";
  }
}

function isSameOriginRoomBootstrapRequest(url: string, method: string): boolean {
  if (method !== "POST") return false;
  try {
    const base = typeof window === "undefined" ? "https://jazzboard.local" : window.location.origin;
    const resolved = new URL(url, base);
    return resolved.origin === base && resolved.pathname === "/api/rooms";
  } catch {
    return false;
  }
}

function guestSessionLocks(): LockManager | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.locks;
  } catch {
    // Some browser policies deny access to the getter. Entry must remain
    // available even where optional cross-tab coordination is unavailable.
    return undefined;
  }
}

export async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has(CLIENT_CAPABILITIES_HEADER)) {
    headers.set(CLIENT_CAPABILITIES_HEADER, SPLIT_STATE_CLIENT_CAPABILITY);
  }
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", crypto.randomUUID());
  }
  if (
    isSameOriginRoomBootstrapRequest(url, method) &&
    !headers.has(GUEST_BOOTSTRAP_HEADER)
  ) {
    headers.set(GUEST_BOOTSTRAP_HEADER, createGuestBootstrapToken());
  }
  const request = () => fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "same-origin",
    });
  const canRetryAmbiguousMutation =
    method !== "GET" &&
    method !== "HEAD" &&
    !(init.body instanceof FormData);

  const requestWithRetry = async (): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await request();
        const data = (await response.json()) as T & { ok?: boolean; error?: ApiFailure };
        if (!response.ok || data.ok === false) {
          throw new JazzboardApiError(
            response.status,
            data.error ?? { code: "REQUEST_FAILED", message: "Jazzboard could not complete that request." },
          );
        }
        return data;
      } catch (error) {
        const ambiguousTransportFailure = error instanceof TypeError || error instanceof SyntaxError;
        if (
          attempt > 0 ||
          !ambiguousTransportFailure ||
          !canRetryAmbiguousMutation ||
          init.signal?.aborted
        ) {
          throw error;
        }
      }
    }

    throw new Error("Jazzboard exhausted its bounded request retry.");
  };

  const locks = isSameOriginRoomBootstrapRequest(url, method) ? guestSessionLocks() : undefined;
  if (typeof locks?.request === "function") {
    // Fresh tabs otherwise create different signed identities concurrently,
    // then overwrite the one shared guest cookie and lose room membership.
    // Hold through the bounded retry so the next entry sends the settled cookie.
    return locks.request("jazzboard-guest-session-bootstrap", {
      mode: "exclusive",
      ...(init.signal ? { signal: init.signal } : {}),
    }, requestWithRetry);
  }
  return requestWithRetry();
}

export type ApiFailure = {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
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

export async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = (await response.json()) as T & { ok?: boolean; error?: ApiFailure };
  if (!response.ok || data.ok === false) {
    throw new JazzboardApiError(
      response.status,
      data.error ?? { code: "REQUEST_FAILED", message: "Jazzboard could not complete that request." },
    );
  }
  return data;
}

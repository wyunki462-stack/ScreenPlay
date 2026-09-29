import { translateNow } from "../i18n";

const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Small typed fetch wrapper targeting the `/api` base path.
 * In development the request is proxied to the backend via Vite.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData must NOT get an explicit Content-Type: the browser has to add the
  // multipart boundary itself. Only plain bodies are sent as JSON.
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body != null && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    // A 401 anywhere means the session went away (expired, or the container was
    // recreated with a fresh cookie secret). Broadcast it so the app can drop
    // back to the login screen instead of leaving every panel showing errors.
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("screenplay:unauthorized"));
    }
    let message = translateNow("state.requestFailed", { status: response.status });
    try {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
      ) {
        message = (body as { message: string }).message;
      }
    } catch {
      // keep the default message when the body isn't JSON
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export { API_BASE };
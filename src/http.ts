import { PAIR_HINT } from "./rpc.js";

export interface HttpClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

export function makeHttpClient(origin: string, token: string, fetchImpl: typeof fetch = fetch): HttpClient {
  return {
    get: async <T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> => {
      const url = new URL(path, origin);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out after 30s" : summarizeError(error);
        throw new Error(`T3 GET ${url.pathname} ${reason}`);
      }
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new Error(`T3 rejected the stored token (${response.status}). ${PAIR_HINT}`);
      }
      if (!response.ok) {
        throw new Error(`T3 GET ${url.pathname} failed (${response.status}): ${summarizeError(text)}`);
      }
      return JSON.parse(text) as T;
    },
  };
}

/** Pull the human-readable part out of an Effect tagged error (object or JSON text). */
export function summarizeError(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value.slice(0, 300) || "(empty response)";
    }
  }
  if (parsed instanceof Error) return parsed.message;
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const tag = typeof record._tag === "string" ? record._tag : undefined;
    const message = ["message", "reason", "detail"]
      .map((key) => record[key])
      .find((candidate): candidate is string => typeof candidate === "string");
    if (tag && message) return `${tag}: ${message}`;
    if (tag) return `${tag}: ${JSON.stringify(record).slice(0, 300)}`;
    if (message) return message;
    return JSON.stringify(record).slice(0, 300);
  }
  return String(parsed);
}

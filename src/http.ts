export class T3HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function makeHttpClient(origin: string, token: string, fetchImpl: typeof fetch = fetch): HttpClient {
  const request = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(new URL(path, origin), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new T3HttpError(
        response.status,
        text,
        `T3 ${method} ${path} failed (${response.status}): ${summarizeError(text)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return {
    get: (path, query) => {
      const url = new URL(path, origin);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      return request("GET", url.pathname + url.search);
    },
    post: (path, body) => request("POST", path, body),
  };
}

/** Pull the human-readable part out of an Effect tagged error body. */
export function summarizeError(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value.slice(0, 300) || "(empty response)";
    }
  }
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

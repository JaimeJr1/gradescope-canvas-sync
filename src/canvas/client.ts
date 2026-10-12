import { SessionExpired } from "../errors";

export const CANVAS_BASE = "https://gatech.instructure.com";

export type FetchFn = typeof fetch;
export type CookieReader = (url: string, name: string) => Promise<string | null>;

export class CanvasHttpError extends Error {
  constructor(public readonly status: number, detail: string) {
    super(detail);
    this.name = "CanvasHttpError";
  }
}

export function parseCanvasJson<T>(text: string): T {
  return JSON.parse(text.replace(/^while\(1\);/, "")) as T;
}

async function browserCookie(url: string, name: string): Promise<string | null> {
  const c = await browser.cookies.get({ url, name });
  return c?.value ?? null;
}

export class CanvasClient {
  constructor(
    private readonly fetchFn: FetchFn = (...args: Parameters<typeof fetch>) => fetch(...args),
    private readonly readCookie: CookieReader = browserCookie,
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      const token = await this.readCookie(CANVAS_BASE, "_csrf_token");
      if (!token) throw new SessionExpired("canvas");
      headers["X-CSRF-Token"] = decodeURIComponent(token);
      headers["Content-Type"] = "application/json";
    }
    const res = await this.fetchFn(CANVAS_BASE + path, {
      method,
      headers,
      credentials: "include",
      redirect: "follow",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.url.includes("/login")) throw new SessionExpired("canvas");
    if (!res.ok) throw new CanvasHttpError(res.status, `Canvas ${method} ${path} -> ${res.status}`);
    const text = await res.text();
    return text ? parseCanvasJson<T>(text) : (undefined as T);
  }
}

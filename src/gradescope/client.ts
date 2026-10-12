import { SessionExpired } from "../errors";
import type { FetchFn } from "../canvas/client";
import { GS_BASE } from "./parse";

export class GradescopeClient {
  constructor(private readonly fetchFn: FetchFn = (...args: Parameters<typeof fetch>) => fetch(...args)) {}

  fetchAccount(): Promise<string> {
    return this.page("/account");
  }
  fetchCourse(id: string): Promise<string> {
    return this.page(`/courses/${id}`);
  }

  private async page(path: string): Promise<string> {
    const url = GS_BASE + path;
    const res = await this.fetchFn(url, { credentials: "include", redirect: "follow" });
    if (res.status === 401) throw new SessionExpired("gradescope");
    const finalPath = new URL(res.url || url).pathname.replace(/\/$/, "");
    if (finalPath !== path) throw new SessionExpired("gradescope"); // any redirect means logged out
    if (!res.ok) throw new Error(`Gradescope GET ${path} -> ${res.status}`);
    return res.text();
  }
}

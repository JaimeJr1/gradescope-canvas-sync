import { describe, it, expect } from "vitest";
import { CanvasClient, parseCanvasJson, CANVAS_BASE } from "../../src/canvas/client";
import { SessionExpired } from "../../src/errors";

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: string, finalUrl = `${CANVAS_BASE}/api/v1/x`) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return { ok: status < 400, status, url: finalUrl, text: async () => body } as Response;
  }) as typeof fetch;
  return { fn, calls };
}
const cookie = (value: string | null) => async () => value;

describe("parseCanvasJson", () => {
  it("strips the while(1); prefix", () => {
    expect(parseCanvasJson('while(1);{"a":1}')).toEqual({ a: 1 });
    expect(parseCanvasJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("CanvasClient", () => {
  it("GET sends cookies and Accept header, no CSRF", async () => {
    const f = fakeFetch(200, 'while(1);[{"id":1}]');
    const c = new CanvasClient(f.fn, cookie("tok"));
    expect(await c.get("/api/v1/courses")).toEqual([{ id: 1 }]);
    expect(f.calls[0].url).toBe(`${CANVAS_BASE}/api/v1/courses`);
    expect(f.calls[0].init.credentials).toBe("include");
    expect((f.calls[0].init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });
  it("POST sends decoded CSRF token and JSON body", async () => {
    const f = fakeFetch(200, '{"id":9}');
    const c = new CanvasClient(f.fn, cookie("abc%2Fdef%3D"));
    await c.post("/api/v1/planner_notes", { title: "t" });
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h["X-CSRF-Token"]).toBe("abc/def=");
    expect(h["Content-Type"]).toBe("application/json");
    expect(f.calls[0].init.body).toBe('{"title":"t"}');
    expect(f.calls[0].init.method).toBe("POST");
  });
  it("throws SessionExpired on 401", async () => {
    const c = new CanvasClient(fakeFetch(401, '{"status":"unauthenticated"}').fn, cookie("tok"));
    await expect(c.get("/api/v1/courses")).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws SessionExpired when redirected to login", async () => {
    const c = new CanvasClient(fakeFetch(200, "<html>", `${CANVAS_BASE}/login/saml`).fn, cookie("tok"));
    await expect(c.get("/api/v1/courses")).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws SessionExpired when the CSRF cookie is missing", async () => {
    const c = new CanvasClient(fakeFetch(200, "{}").fn, cookie(null));
    await expect(c.post("/api/v1/planner_notes", {})).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws a plain Error on other failures", async () => {
    const c = new CanvasClient(fakeFetch(500, "boom").fn, cookie("tok"));
    await expect(c.get("/x")).rejects.toThrow(/500/);
  });
});

import { describe, it, expect } from "vitest";
import { CanvasApi } from "../../src/canvas/api";
import { CanvasHttpError } from "../../src/canvas/client";

function fakeClient(responses: unknown[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const next = () => {
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    calls,
    client: {
      get: async (path: string) => { calls.push({ method: "GET", path }); return next() as any; },
      post: async (path: string, body: unknown) => { calls.push({ method: "POST", path, body }); return next() as any; },
      put: async (path: string, body: unknown) => { calls.push({ method: "PUT", path, body }); return next() as any; },
    },
  };
}

describe("CanvasApi", () => {
  it("lists active courses and drops ones without a course_code", async () => {
    const f = fakeClient([[{ id: 1, name: "A", course_code: "CS-3210-A" }, { id: 2, name: "B" }]]);
    const api = new CanvasApi(f.client);
    expect(await api.listActiveCourses()).toEqual([{ id: 1, name: "A", course_code: "CS-3210-A" }]);
    expect(f.calls[0].path).toBe("/api/v1/courses?enrollment_state=active&per_page=100");
  });
  it("creates a note and returns its id", async () => {
    const f = fakeClient([{ id: 42 }]);
    const api = new CanvasApi(f.client);
    const id = await api.createNote({ title: "[Gradescope] HW1", details: "d", todo_date: "2026-10-21T03:59:00.000Z", course_id: 10 });
    expect(id).toBe(42);
    expect(f.calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/planner_notes",
      body: { title: "[Gradescope] HW1", details: "d", todo_date: "2026-10-21T03:59:00.000Z", course_id: 10 },
    });
  });
  it("updates a note", async () => {
    const f = fakeClient([{}]);
    await new CanvasApi(f.client).updateNote(42, { todo_date: "x", course_id: null });
    expect(f.calls[0]).toEqual({ method: "PUT", path: "/api/v1/planner_notes/42", body: { todo_date: "x", course_id: null } });
  });
  it("creates an override the first time and updates it afterwards", async () => {
    const f = fakeClient([{ id: 77 }, {}]);
    const api = new CanvasApi(f.client);
    expect(await api.setComplete(42, true)).toBe(77);
    expect(f.calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/planner/overrides",
      body: { plannable_type: "planner_note", plannable_id: 42, marked_complete: true },
    });
    expect(await api.setComplete(42, false, 77)).toBe(77);
    expect(f.calls[1]).toEqual({ method: "PUT", path: "/api/v1/planner/overrides/77", body: { marked_complete: false } });
  });
  it("adopts the existing override when creating one returns 400", async () => {
    const f = fakeClient([
      new CanvasHttpError(400, "already exists"),
      [
        { id: 5, plannable_type: "assignment", plannable_id: 42 },
        { id: 77, plannable_type: "planner_note", plannable_id: 42 },
      ],
      {},
    ]);
    expect(await new CanvasApi(f.client).setComplete(42, true)).toBe(77);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/planner/overrides",
      "GET /api/v1/planner/overrides?per_page=100&page=1",
      "PUT /api/v1/planner/overrides/77",
    ]);
    expect(f.calls[2].body).toEqual({ marked_complete: true });
  });
  it("lists planner notes across pages", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i, title: "t", details: "d", todo_date: "x", course_id: null }));
    const f = fakeClient([page(100, 0), page(3, 100)]);
    const notes = await new CanvasApi(f.client).listNotes();
    expect(notes).toHaveLength(103);
    expect(notes[102]).toEqual({ id: 102, title: "t", details: "d", todo_date: "x", course_id: null });
    expect(f.calls.map((c) => c.path)).toEqual([
      "/api/v1/planner_notes?per_page=100&page=1",
      "/api/v1/planner_notes?per_page=100&page=2",
    ]);
  });
});

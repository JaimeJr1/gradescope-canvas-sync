import { describe, it, expect } from "vitest";
import { CanvasApi } from "../../src/canvas/api";

function fakeClient(responses: unknown[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const next = () => responses.shift();
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
});

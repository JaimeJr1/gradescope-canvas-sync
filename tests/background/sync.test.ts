import { describe, it, expect } from "vitest";
import { runSync, type SyncDeps } from "../../src/background/sync";
import { SessionExpired } from "../../src/errors";
import { CanvasHttpError } from "../../src/canvas/client";
import type { State } from "../../src/types";

const courseBox = (id: string, code: string) =>
  `<a class="courseBox" href="/courses/${id}"><h3 class="courseBox--shortname">${code}</h3><div class="courseBox--name">N</div></a>`;
const accountWith = (boxes: string) => `<div id="account-show"><div class="courseList">
  <div class="courseList--term">Fall 2026</div>
  <div class="courseList--coursesForTerm">${boxes}</div></div></div>`;
const account = accountWith(courseBox("111", "CS 3210"));

const row = (id: string, name: string, status: string, due: string, cid = "111") => `<tr role="row">
  <th><a href="/courses/${cid}/assignments/${id}">${name}</a></th>
  <td>${status}</td>
  <td><time class="submissionTimeChart--dueDate" datetime="${due}">x</time></td></tr>`;
const course = (rows: string) => `<table>${rows}</table>`;

function makeDeps(courseHtml: string, initial?: Partial<State>, canvasOverrides: Partial<SyncDeps["canvas"]> = {}) {
  let state: State = { mappings: {}, notes: {}, ignored: [], ...initial };
  const calls: string[] = [];
  let nextId = 100;
  const deps: SyncDeps = {
    gs: { fetchAccount: async () => account, fetchCourse: async () => courseHtml },
    canvas: {
      listActiveCourses: async () => [{ id: 10, name: "OS", course_code: "CS-3210-A" }],
      listNotes: async () => [],
      createNote: async (n) => { calls.push(`create ${n.title} ${n.course_id} ${n.todo_date}`); return nextId++; },
      updateNote: async (id, p) => { calls.push(`update ${id} ${JSON.stringify(p)}`); },
      setComplete: async (id, c, o) => { calls.push(`complete ${id} ${c} ${o}`); return o ?? 900; },
      ...canvasOverrides,
    },
    loadState: async () => structuredClone(state),
    saveState: async (s) => { state = structuredClone(s); },
    now: () => new Date("2026-10-12T12:00:00Z"),
  };
  return { deps, calls, getState: () => state };
}

const twoOpen = course(
  row("1", "HW1", "No Submission", "2026-10-20 23:59:00 -0400") +
  row("2", "HW2", "No Submission", "2026-10-27 23:59:00 -0400") +
  row("3", "Old", "9 / 10", "2026-09-01 23:59:00 -0400"),
);

describe("runSync", () => {
  it("first run creates open assignments, ignores submitted ones, caches courses", async () => {
    const t = makeDeps(twoOpen);
    const r = await runSync(t.deps);
    expect(r).toMatchObject({ created: 2, ignored: 1, updated: 0, completed: 0, failed: 0 });
    expect(t.calls).toEqual([
      "create [Gradescope] HW1 10 2026-10-21T03:59:00.000Z",
      "create [Gradescope] HW2 10 2026-10-28T03:59:00.000Z",
    ]);
    const s = t.getState();
    expect(s.notes["1"]).toEqual({ noteId: 100, dueAt: "2026-10-21T03:59:00.000Z", submitted: false, courseId: 10 });
    expect(s.ignored).toEqual(["3"]);
    expect(s.cache?.mapping).toEqual({ "111": 10 });
    expect(s.lastSync?.at).toBe("2026-10-12T12:00:00.000Z");
  });

  it("second run with no changes makes no Canvas writes", async () => {
    const t = makeDeps(twoOpen);
    await runSync(t.deps);
    t.calls.length = 0;
    await runSync(t.deps);
    expect(t.calls).toEqual([]);
  });

  it("marks complete when an assignment becomes submitted", async () => {
    const t = makeDeps(twoOpen);
    await runSync(t.deps);
    t.calls.length = 0;
    t.deps.gs.fetchCourse = async () => course(row("1", "HW1", "10 / 10", "2026-10-20 23:59:00 -0400"));
    const r = await runSync(t.deps);
    expect(r.completed).toBe(1);
    expect(t.calls).toEqual(["complete 100 true undefined"]);
    expect(t.getState().notes["1"]).toMatchObject({ submitted: true, overrideId: 900 });
  });

  it("session expired mid-run keeps partial state", async () => {
    let n = 0;
    const t = makeDeps(twoOpen, undefined, {
      createNote: async () => { if (n++ === 1) throw new SessionExpired("canvas"); return 100; },
    });
    await expect(runSync(t.deps)).rejects.toBeInstanceOf(SessionExpired);
    expect(Object.keys(t.getState().notes)).toEqual(["1"]);
  });

  it("a non-auth failure on one op is counted, tagged 'other', and the rest proceed", async () => {
    let n = 0;
    const t = makeDeps(twoOpen, undefined, {
      createNote: async () => { if (n++ === 0) throw new Error("500"); return 200; },
    });
    const r = await runSync(t.deps);
    expect(r).toMatchObject({ created: 1, failed: 1 });
    expect(t.getState().lastError).toMatchObject({ site: "other", message: expect.stringContaining("500") });
  });

  it("a clean run clears a previous lastError", async () => {
    const t = makeDeps(twoOpen, { lastError: { at: "2026-10-12T11:00:00.000Z", site: "canvas", message: "old" } });
    await runSync(t.deps);
    expect(t.getState().lastError).toBeUndefined();
  });

  it("propagates a Gradescope session expiry without touching Canvas", async () => {
    const t = makeDeps(twoOpen);
    t.deps.gs.fetchAccount = async () => { throw new SessionExpired("gradescope"); };
    await expect(runSync(t.deps)).rejects.toBeInstanceOf(SessionExpired);
    expect(t.calls).toEqual([]);
  });

  it("adopts existing Canvas notes by Gradescope URL instead of creating duplicates", async () => {
    const t = makeDeps(twoOpen, undefined, {
      listNotes: async () => [
        {
          id: 555,
          title: "[Gradescope] HW1",
          details: "Submit on Gradescope: https://www.gradescope.com/courses/111/assignments/1",
          todo_date: "2026-10-21T03:59:00Z",
          course_id: 10,
        },
        { id: 556, title: "unrelated", details: "buy milk", todo_date: "2026-10-21T03:59:00Z", course_id: null },
      ],
    });
    const r = await runSync(t.deps);
    expect(r.created).toBe(1);
    expect(t.calls).toEqual(["create [Gradescope] HW2 10 2026-10-28T03:59:00.000Z"]);
    expect(t.getState().notes["1"]).toEqual({ noteId: 555, dueAt: "2026-10-21T03:59:00.000Z", submitted: false, courseId: 10 });
  });

  it("a note deleted in Canvas (404) is dropped and ignored, not retried", async () => {
    const t = makeDeps(twoOpen, {
      notes: { "1": { noteId: 100, dueAt: "2026-10-01T03:59:00.000Z", submitted: false, courseId: 10 } },
      ignored: ["2"],
    }, {
      updateNote: async () => { throw new CanvasHttpError(404, "gone"); },
    });
    const r = await runSync(t.deps);
    expect(r.failed).toBe(0);
    expect(t.getState().notes["1"]).toBeUndefined();
    expect(t.getState().ignored).toContain("1");
  });

  it("one unrecognised course page does not block the others", async () => {
    const t = makeDeps(twoOpen);
    t.deps.gs.fetchAccount = async () => accountWith(courseBox("111", "CS 3210") + courseBox("222", "CS 2200"));
    t.deps.gs.fetchCourse = async (id) => (id === "222" ? "<html><body>maintenance</body></html>" : twoOpen);
    const r = await runSync(t.deps);
    expect(r.created).toBe(2);
    expect(t.getState().cache?.warnings.some((w) => w.includes("CS 2200"))).toBe(true);
  });

  it("throws LayoutChanged when every course page is unrecognised", async () => {
    const t = makeDeps("<html><body>maintenance</body></html>");
    await expect(runSync(t.deps)).rejects.toThrow(/layout changed/);
    expect(t.calls).toEqual([]);
  });
});

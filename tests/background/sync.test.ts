import { describe, it, expect } from "vitest";
import { runSync, type SyncDeps } from "../../src/background/sync";
import { SessionExpired } from "../../src/errors";
import type { State } from "../../src/types";

const account = `<div id="account-show"><div class="courseList">
  <div class="courseList--term">Fall 2026</div>
  <div class="courseList--coursesForTerm">
    <a class="courseBox" href="/courses/111"><h3 class="courseBox--shortname">CS 3210</h3><div class="courseBox--name">OS</div></a>
  </div></div></div>`;

const row = (id: string, name: string, status: string, due: string) => `<tr role="row">
  <th><a href="/courses/111/assignments/${id}">${name}</a></th>
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

  it("a non-auth failure on one op is counted and the rest proceed", async () => {
    let n = 0;
    const t = makeDeps(twoOpen, undefined, {
      createNote: async () => { if (n++ === 0) throw new Error("500"); return 200; },
    });
    const r = await runSync(t.deps);
    expect(r).toMatchObject({ created: 1, failed: 1 });
    expect(t.getState().lastError?.message).toContain("500");
  });

  it("propagates a Gradescope session expiry without touching Canvas", async () => {
    const t = makeDeps(twoOpen);
    t.deps.gs.fetchAccount = async () => { throw new SessionExpired("gradescope"); };
    await expect(runSync(t.deps)).rejects.toBeInstanceOf(SessionExpired);
    expect(t.calls).toEqual([]);
  });
});

import type { CanvasApi } from "../canvas/api";
import type { GradescopeClient } from "../gradescope/client";
import { parseAccount, parseCourse } from "../gradescope/parse";
import { matchCourses } from "../match/courses";
import { planOps } from "../sync/plan";
import { SessionExpired } from "../errors";
import type { GsAssignment, State, SyncCounts, SyncOp } from "../types";

export type SyncDeps = {
  gs: Pick<GradescopeClient, "fetchAccount" | "fetchCourse">;
  canvas: Pick<CanvasApi, "listActiveCourses" | "createNote" | "updateNote" | "setComplete">;
  loadState: () => Promise<State>;
  saveState: (s: State) => Promise<void>;
  now: () => Date;
};

export async function runSync(d: SyncDeps): Promise<SyncCounts> {
  const state = await d.loadState();

  const gsCourses = parseAccount(await d.gs.fetchAccount());
  const assignments: GsAssignment[] = [];
  for (const c of gsCourses) {
    assignments.push(...parseCourse(await d.gs.fetchCourse(c.id), c.id));
  }

  const canvasCourses = await d.canvas.listActiveCourses();
  const { mapping, warnings } = matchCourses(gsCourses, canvasCourses, state.mappings);
  state.cache = { gsCourses, canvasCourses, mapping, warnings };
  await d.saveState(state);

  const counts: SyncCounts = { created: 0, updated: 0, completed: 0, reopened: 0, ignored: 0, failed: 0 };
  for (const op of planOps(assignments, mapping, state)) {
    try {
      await applyOp(d.canvas, state, op, counts);
    } catch (e) {
      if (e instanceof SessionExpired) throw e;
      counts.failed++;
      state.lastError = { at: d.now().toISOString(), site: "canvas", message: String((e as Error)?.message ?? e) };
    }
    await d.saveState(state);
  }

  state.lastSync = { at: d.now().toISOString(), ...counts };
  await d.saveState(state);
  return counts;
}

async function applyOp(canvas: SyncDeps["canvas"], state: State, op: SyncOp, counts: SyncCounts): Promise<void> {
  const a = op.assignment;
  switch (op.kind) {
    case "ignore":
      state.ignored.push(a.id);
      counts.ignored++;
      return;
    case "create": {
      const noteId = await canvas.createNote({
        title: `[Gradescope] ${a.name}`,
        details: `Submit on Gradescope: ${a.url}`,
        todo_date: a.dueAt,
        ...(op.courseId === null ? {} : { course_id: op.courseId }),
      });
      state.notes[a.id] = { noteId, dueAt: a.dueAt, submitted: false, courseId: op.courseId };
      counts.created++;
      return;
    }
    case "update": {
      await canvas.updateNote(op.noteId, { todo_date: a.dueAt, course_id: op.courseId });
      const rec = state.notes[a.id];
      rec.dueAt = a.dueAt;
      rec.courseId = op.courseId;
      counts.updated++;
      return;
    }
    case "complete": {
      const overrideId = await canvas.setComplete(op.noteId, true, op.overrideId);
      const rec = state.notes[a.id];
      rec.overrideId = overrideId;
      rec.submitted = true;
      counts.completed++;
      return;
    }
    case "reopen": {
      await canvas.setComplete(op.noteId, false, op.overrideId);
      state.notes[a.id].submitted = false;
      counts.reopened++;
      return;
    }
  }
}

import type { CanvasApi, CanvasNote } from "../canvas/api";
import { CanvasHttpError } from "../canvas/client";
import type { GradescopeClient } from "../gradescope/client";
import { parseAccount, parseCourse } from "../gradescope/parse";
import { matchCourses } from "../match/courses";
import { planOps } from "../sync/plan";
import { LayoutChanged, SessionExpired } from "../errors";
import type { GsAssignment, State, SyncCounts, SyncOp } from "../types";

export type SyncDeps = {
  gs: Pick<GradescopeClient, "fetchAccount" | "fetchCourse">;
  canvas: Pick<CanvasApi, "listActiveCourses" | "listNotes" | "createNote" | "updateNote" | "setComplete">;
  loadState: () => Promise<State>;
  saveState: (s: State) => Promise<void>;
  now: () => Date;
};

const GS_ASSIGNMENT_URL = /gradescope\.com\/courses\/(\d+)\/assignments\/(\d+)/;

/** Adopt Canvas notes this extension created earlier (identified by the Gradescope URL in `details`)
 *  so a lost or reset extension storage never produces duplicate notes. */
export function adoptNotes(state: State, notes: CanvasNote[]): void {
  for (const n of notes) {
    const m = n.details.match(GS_ASSIGNMENT_URL);
    if (!m) continue;
    const assignmentId = m[2];
    if (state.notes[assignmentId]) continue;
    const d = new Date(n.todo_date);
    state.notes[assignmentId] = {
      noteId: n.id,
      dueAt: Number.isNaN(d.getTime()) ? n.todo_date : d.toISOString(),
      submitted: false,
      courseId: n.course_id ?? null,
    };
  }
}

export async function runSync(d: SyncDeps): Promise<SyncCounts> {
  const state = await d.loadState();
  state.lastError = undefined;

  const gsCourses = parseAccount(await d.gs.fetchAccount());
  const assignments: GsAssignment[] = [];
  const warnings: string[] = [];
  let parsedCourses = 0;
  for (const c of gsCourses) {
    try {
      assignments.push(...parseCourse(await d.gs.fetchCourse(c.id), c.id));
      parsedCourses++;
    } catch (e) {
      if (!(e instanceof LayoutChanged)) throw e;
      warnings.push(`${c.shortName}: Gradescope page not recognised, skipped this run`);
    }
  }
  if (gsCourses.length > 0 && parsedCourses === 0) throw new LayoutChanged("no Gradescope course page could be parsed");

  const canvasCourses = await d.canvas.listActiveCourses();
  const match = matchCourses(gsCourses, canvasCourses, state.mappings);
  warnings.push(...match.warnings);
  state.cache = { gsCourses, canvasCourses, mapping: match.mapping, warnings };
  adoptNotes(state, await d.canvas.listNotes());
  await d.saveState(state);

  const counts: SyncCounts = { created: 0, updated: 0, completed: 0, reopened: 0, ignored: 0, failed: 0 };
  for (const op of planOps(assignments, match.mapping, state)) {
    try {
      await applyOp(d.canvas, state, op, counts);
    } catch (e) {
      if (e instanceof SessionExpired) throw e;
      if (e instanceof CanvasHttpError && e.status === 404 && op.kind !== "create" && op.kind !== "ignore") {
        // The user deleted the note in Canvas: stop tracking it and never recreate it.
        delete state.notes[op.assignment.id];
        if (!state.ignored.includes(op.assignment.id)) state.ignored.push(op.assignment.id);
        counts.ignored++;
      } else {
        counts.failed++;
        state.lastError = { at: d.now().toISOString(), site: "other", message: String((e as Error)?.message ?? e) };
      }
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

import type { GsAssignment, State, SyncOp } from "../types";

export function planOps(
  assignments: GsAssignment[],
  mapping: Record<string, number | null>,
  state: Pick<State, "notes" | "ignored">,
): SyncOp[] {
  const ops: SyncOp[] = [];
  const ignored = new Set(state.ignored);
  for (const a of assignments) {
    const courseId = mapping[a.courseId] ?? null;
    const rec = state.notes[a.id];
    if (!rec) {
      if (ignored.has(a.id)) continue;
      ops.push(a.submitted ? { kind: "ignore", assignment: a } : { kind: "create", assignment: a, courseId });
      continue;
    }
    if (rec.dueAt !== a.dueAt || rec.courseId !== courseId) {
      ops.push({ kind: "update", assignment: a, noteId: rec.noteId, courseId });
    }
    if (!rec.submitted && a.submitted) {
      ops.push({ kind: "complete", assignment: a, noteId: rec.noteId, overrideId: rec.overrideId });
    } else if (rec.submitted && !a.submitted && rec.overrideId !== undefined) {
      ops.push({ kind: "reopen", assignment: a, noteId: rec.noteId, overrideId: rec.overrideId });
    }
  }
  return ops;
}

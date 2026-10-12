import { describe, it, expect } from "vitest";
import { planOps } from "../../src/sync/plan";
import type { GsAssignment, NoteRecord } from "../../src/types";

const asg = (over: Partial<GsAssignment> = {}): GsAssignment => ({
  id: "a1",
  courseId: "g1",
  name: "HW1",
  dueAt: "2026-10-21T03:59:00.000Z",
  submitted: false,
  url: "https://www.gradescope.com/courses/g1/assignments/a1",
  ...over,
});
const rec = (over: Partial<NoteRecord> = {}): NoteRecord => ({
  noteId: 500,
  dueAt: "2026-10-21T03:59:00.000Z",
  submitted: false,
  courseId: 10,
  ...over,
});
const mapping = { g1: 10 };

describe("planOps", () => {
  it("creates a note for a new unsubmitted assignment", () => {
    expect(planOps([asg()], mapping, { notes: {}, ignored: [] })).toEqual([
      { kind: "create", assignment: asg(), courseId: 10 },
    ]);
  });
  it("creates with courseId null when the course is unmapped", () => {
    expect(planOps([asg()], {}, { notes: {}, ignored: [] })[0]).toMatchObject({ kind: "create", courseId: null });
  });
  it("ignores a new assignment that is already submitted", () => {
    expect(planOps([asg({ submitted: true })], mapping, { notes: {}, ignored: [] })).toEqual([
      { kind: "ignore", assignment: asg({ submitted: true }) },
    ]);
  });
  it("does nothing for an ignored assignment even if it later looks unsubmitted", () => {
    expect(planOps([asg()], mapping, { notes: {}, ignored: ["a1"] })).toEqual([]);
  });
  it("does nothing when nothing changed", () => {
    expect(planOps([asg()], mapping, { notes: { a1: rec() }, ignored: [] })).toEqual([]);
  });
  it("updates when the due date changed", () => {
    const a = asg({ dueAt: "2026-10-23T03:59:00.000Z" });
    expect(planOps([a], mapping, { notes: { a1: rec() }, ignored: [] })).toEqual([
      { kind: "update", assignment: a, noteId: 500, courseId: 10 },
    ]);
  });
  it("updates when the mapping changed", () => {
    expect(planOps([asg()], { g1: 11 }, { notes: { a1: rec() }, ignored: [] })).toEqual([
      { kind: "update", assignment: asg(), noteId: 500, courseId: 11 },
    ]);
  });
  it("completes when submitted flips to true", () => {
    const a = asg({ submitted: true });
    expect(planOps([a], mapping, { notes: { a1: rec() }, ignored: [] })).toEqual([
      { kind: "complete", assignment: a, noteId: 500, overrideId: undefined },
    ]);
  });
  it("reopens when submitted flips back to false and an override exists", () => {
    expect(planOps([asg()], mapping, { notes: { a1: rec({ submitted: true, overrideId: 77 }) }, ignored: [] })).toEqual([
      { kind: "reopen", assignment: asg(), noteId: 500, overrideId: 77 },
    ]);
  });
  it("emits both update and complete when both changed", () => {
    const a = asg({ submitted: true, dueAt: "2026-10-23T03:59:00.000Z" });
    const ops = planOps([a], mapping, { notes: { a1: rec() }, ignored: [] });
    expect(ops.map((o) => o.kind)).toEqual(["update", "complete"]);
  });
});

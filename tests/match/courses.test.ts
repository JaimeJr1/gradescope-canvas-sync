import { describe, it, expect } from "vitest";
import { normalizeCode, matchCourses } from "../../src/match/courses";
import type { CanvasCourse, GsCourse } from "../../src/types";

describe("normalizeCode", () => {
  it.each([
    ["CS 3210", "CS3210"],
    ["cs3210", "CS3210"],
    ["CS-3210-A", "CS3210"],
    ["202608-CS-3210-A", "CS3210"],
    ["MATH 2550 Fall 2026", "MATH2550"],
    ["Fall 2026 CS 3210", "CS3210"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCode(input)).toBe(expected);
  });
  it("returns null when no dept+number is present", () => {
    expect(normalizeCode("Design of Operating Systems")).toBeNull();
  });
  it("does not treat a term like 'Fall 2026' as a course code", () => {
    expect(normalizeCode("Fall 2026 Orientation")).toBeNull();
    expect(normalizeCode("Seminar Fall 2026")).toBeNull();
    expect(normalizeCode("Spring 2026")).toBeNull();
  });
});

const gs: GsCourse[] = [
  { id: "g1", shortName: "CS 3210", fullName: "Design of Operating Systems", term: "Fall 2026" },
  { id: "g2", shortName: "CS 2200", fullName: "Systems and Networks", term: "Fall 2026" },
  { id: "g3", shortName: "Seminar", fullName: "Seminar", term: "Fall 2026" },
];
const canvas: CanvasCourse[] = [
  { id: 10, name: "Design of Operating Systems", course_code: "CS-3210-A" },
  { id: 20, name: "Systems and Networks", course_code: "202608-CS-2200-A" },
  { id: 21, name: "Systems and Networks", course_code: "202608-CS-2200-B" },
];

describe("matchCourses", () => {
  it("matches unique codes", () => {
    expect(matchCourses(gs, canvas, {}).mapping.g1).toBe(10);
  });
  it("yields null plus a warning when two Canvas courses share a code", () => {
    const r = matchCourses(gs, canvas, {});
    expect(r.mapping.g2).toBeNull();
    expect(r.warnings.some((w) => w.includes("CS 2200"))).toBe(true);
  });
  it("yields null with no warning when nothing matches", () => {
    const r = matchCourses(gs, canvas, {});
    expect(r.mapping.g3).toBeNull();
    expect(r.warnings.some((w) => w.includes("Seminar"))).toBe(false);
  });
  it("override wins, including an explicit null", () => {
    const r = matchCourses(gs, canvas, { g1: null, g2: 21 });
    expect(r.mapping.g1).toBeNull();
    expect(r.mapping.g2).toBe(21);
    expect(r.warnings).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccount, parseCourse, parseGsDatetime } from "../../src/gradescope/parse";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", name), "utf8");

describe("parseGsDatetime", () => {
  it("parses space-separated offset form", () => {
    expect(parseGsDatetime("2026-09-10 23:59:00 -0400")).toBe("2026-09-11T03:59:00.000Z");
  });
  it("parses ISO form", () => {
    expect(parseGsDatetime("2026-10-25T23:59:00-04:00")).toBe("2026-10-26T03:59:00.000Z");
  });
  it("returns null for garbage", () => {
    expect(parseGsDatetime("")).toBeNull();
    expect(parseGsDatetime("Oct 25")).toBeNull();
  });
});

describe("parseAccount", () => {
  it("returns only the first term's courses", () => {
    const courses = parseAccount(fx("account.html"));
    expect(courses).toEqual([
      { id: "111111", shortName: "CS 3210", fullName: "Design of Operating Systems", term: "Fall 2026" },
      { id: "222222", shortName: "CS 2200", fullName: "Systems and Networks", term: "Fall 2026" },
    ]);
  });
  it("throws LayoutChanged when #account-show is missing", () => {
    expect(() => parseAccount("<html><body><p>hi</p></body></html>")).toThrow(/layout changed/);
  });
});

describe("parseCourse", () => {
  const rows = parseCourse(fx("course.html"), "111111");

  it("skips header, footer and rows without a due date", () => {
    expect(rows.map((r) => r.id)).toEqual(["900001", "900002", "900003"]);
  });
  it("treats a score as submitted and 'No Submission' as not", () => {
    expect(rows[0].submitted).toBe(true);
    expect(rows[1].submitted).toBe(false);
    expect(rows[2].submitted).toBe(true);
  });
  it("uses the first due date, ignoring the late deadline", () => {
    expect(rows[1].dueAt).toBe("2026-10-21T03:59:00.000Z");
  });
  it("reads ids from links and from submit buttons", () => {
    expect(rows[2]).toEqual({
      id: "900003",
      courseId: "111111",
      name: "Quiz 1",
      dueAt: "2026-10-26T03:59:00.000Z",
      submitted: true,
      url: "https://www.gradescope.com/courses/111111/assignments/900003",
    });
  });
  it("throws LayoutChanged when there are no rows", () => {
    expect(() => parseCourse("<html><body></body></html>", "1")).toThrow(/layout changed/);
  });
});

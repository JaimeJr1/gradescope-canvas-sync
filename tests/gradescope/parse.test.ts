import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  it("throws LayoutChanged when #account-show has no course boxes", () => {
    expect(() => parseAccount('<div id="account-show"><p>x</p></div>')).toThrow(/layout changed/);
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

const realAccount = join(__dirname, "..", "fixtures", "real-account.html");
const realCourse = join(__dirname, "..", "fixtures", "real-course.html");

describe.skipIf(!existsSync(realAccount))("parseAccount on a real page", () => {
  it("finds at least one numeric course id with a short name", () => {
    const courses = parseAccount(fx("real-account.html"));
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses) {
      expect(c.id).toMatch(/^\d+$/);
      expect(c.shortName).not.toBe("");
    }
  });
});

describe.skipIf(!existsSync(realCourse))("parseCourse on a real page", () => {
  it("returns assignments with ISO due dates", () => {
    const rows = parseCourse(fx("real-course.html"), "0");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

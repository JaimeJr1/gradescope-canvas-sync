# gradescope-canvas-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Firefox extension that mirrors every Gradescope assignment into Georgia Tech Canvas as a Planner To-Do note, hourly, and checks the note off when the assignment is submitted.

**Architecture:** An MV3 event-page background script runs on a 60-minute alarm (or a popup button). It fetches Gradescope pages with the browser's cookies, parses them with `DOMParser`, matches courses to Canvas by course code, diffs against extension storage, and writes planner notes / overrides to Canvas through the cookie session with a CSRF header. Parsing, matching and diffing are pure functions; only two small client classes and `runSync` touch the network and storage.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom, web-ext, `@types/firefox-webext-browser`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-gradescope-canvas-sync-design.md`

## Global Constraints

- Firefox only, Manifest V3, background as event page (`"background": {"scripts": [...]}`), `strict_min_version` `115.0`.
- Canvas base URL constant: `https://gatech.instructure.com`. Gradescope base: `https://www.gradescope.com`.
- Permissions exactly: `alarms`, `storage`, `cookies`; host permissions `https://www.gradescope.com/*`, `https://gatech.instructure.com/*`.
- No credentials stored anywhere. Both sites are reached with `credentials: "include"`.
- Note title format: `[Gradescope] <assignment name>`. Details: `Submit on Gradescope: <url>`.
- Sync period: 60 minutes. Manual trigger from the popup.
- Submitted ⇒ mark complete via planner override. Never delete notes.
- Only the most recent Gradescope term is scraped. Rows without a due date are dropped. First-seen-and-already-submitted assignments are ignored forever.
- Commits are authored as JaimeJr1 with no AI attribution lines.

## Review Focus

1. Gradescope `datetime` attributes come in two shapes, `2026-10-15 23:59:00 -0400` and `2026-10-15T23:59:00-04:00`; both must parse, and garbage must drop the row, not crash. (Task 2 tests `parseGsDatetime`.)
2. Status cells show a score like `9.0 / 10.0` or the word `Submitted` for submitted work and `No Submission` otherwise; a score must count as submitted. (Task 2 `parseCourse` tests.)
3. Canvas `course_code` at GT may carry a term prefix or a section suffix (`202608-CS-3210-A`), and two sections of the same course may both be active; the first must still match, the second must yield no mapping plus a warning rather than a wrong course. (Task 3 tests.)
4. The user fixes a course mapping after notes already exist; the next sync must move those notes to the new course instead of leaving them under the wrong one. (Task 4 `planOps` test "mapping changed".)
5. A session expires halfway through writing ops; notes already created must be recorded so the next run does not create duplicates. (Task 8 test "session expired mid-run keeps partial state".)

---

### Task 1: Project scaffold, shared types, errors

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/types.ts`, `src/errors.ts`
- Test: `tests/errors.test.ts`

**Interfaces:**
- Produces: every type below, and `SessionExpired`, `LayoutChanged` error classes used by Tasks 2, 5, 7, 8, 9.

- [ ] **Step 1: Write tooling files**

`package.json`:
```json
{
  "name": "gradescope-canvas-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p .",
    "build": "node scripts/build.mjs",
    "start": "web-ext run -s dist",
    "lint": "web-ext lint -s dist"
  },
  "devDependencies": {
    "@types/firefox-webext-browser": "^120.0.0",
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "web-ext": "^8.3.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["firefox-webext-browser"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "jsdom" } });
```

`.gitignore`:
```
node_modules/
dist/
web-ext-artifacts/
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Write types and errors**

`src/types.ts`:
```ts
export type GsCourse = { id: string; shortName: string; fullName: string; term: string };

export type GsAssignment = {
  id: string;
  courseId: string;
  name: string;
  dueAt: string; // ISO 8601 UTC
  submitted: boolean;
  url: string;
};

export type CanvasCourse = { id: number; name: string; course_code: string };

export type NoteRecord = {
  noteId: number;
  overrideId?: number;
  dueAt: string;
  submitted: boolean;
  courseId: number | null;
};

export type SyncCounts = {
  created: number;
  updated: number;
  completed: number;
  reopened: number;
  ignored: number;
  failed: number;
};

export type State = {
  mappings: Record<string, number | null>; // user overrides only: gsCourseId -> canvas id or null for "(none)"
  notes: Record<string, NoteRecord>; // gsAssignmentId -> note
  ignored: string[]; // gsAssignmentIds seen first as already submitted
  cache?: {
    gsCourses: GsCourse[];
    canvasCourses: CanvasCourse[];
    mapping: Record<string, number | null>;
    warnings: string[];
  };
  lastSync?: { at: string } & SyncCounts;
  lastError?: { at: string; site: "gradescope" | "canvas" | "other"; message: string };
};

export type SyncOp =
  | { kind: "create"; assignment: GsAssignment; courseId: number | null }
  | { kind: "update"; assignment: GsAssignment; noteId: number; courseId: number | null }
  | { kind: "complete"; assignment: GsAssignment; noteId: number; overrideId?: number }
  | { kind: "reopen"; assignment: GsAssignment; noteId: number; overrideId: number }
  | { kind: "ignore"; assignment: GsAssignment };
```

`src/errors.ts`:
```ts
export class SessionExpired extends Error {
  constructor(public readonly site: "gradescope" | "canvas") {
    super(`${site} session expired`);
    this.name = "SessionExpired";
  }
}

export class LayoutChanged extends Error {
  constructor(detail: string) {
    super(`page layout changed: ${detail}`);
    this.name = "LayoutChanged";
  }
}
```

- [ ] **Step 4: Write the test**

`tests/errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SessionExpired, LayoutChanged } from "../src/errors";

describe("errors", () => {
  it("SessionExpired carries the site", () => {
    const e = new SessionExpired("canvas");
    expect(e.site).toBe("canvas");
    expect(e.name).toBe("SessionExpired");
    expect(e).toBeInstanceOf(Error);
  });
  it("LayoutChanged includes detail", () => {
    expect(new LayoutChanged("x").message).toContain("x");
  });
});
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 2 passed, tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold project with types and errors"
```

---

### Task 2: Gradescope HTML parser

**Files:**
- Create: `src/gradescope/parse.ts`
- Create: `tests/fixtures/account.html`, `tests/fixtures/course.html`
- Test: `tests/gradescope/parse.test.ts`

**Interfaces:**
- Consumes: `GsCourse`, `GsAssignment`, `LayoutChanged` from Task 1.
- Produces: `parseGsDatetime(s: string): string | null`, `parseAccount(html: string): GsCourse[]`, `parseCourse(html: string, courseId: string): GsAssignment[]`.

- [ ] **Step 1: Write fixtures**

`tests/fixtures/account.html`:
```html
<!doctype html>
<html><body>
<div id="account-show">
  <div class="courseList">
    <div class="courseList--term pageSubheading">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/111111">
        <h3 class="courseBox--shortname">CS 3210</h3>
        <div class="courseBox--name">Design of Operating Systems</div>
        <div class="courseBox--assignments">6 assignments</div>
      </a>
      <a class="courseBox" href="/courses/222222">
        <h3 class="courseBox--shortname">CS 2200</h3>
        <div class="courseBox--name">Systems and Networks</div>
      </a>
    </div>
    <div class="courseList--term pageSubheading">Spring 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/333333">
        <h3 class="courseBox--shortname">CS 1332</h3>
        <div class="courseBox--name">Data Structures</div>
      </a>
    </div>
  </div>
</div>
</body></html>
```

`tests/fixtures/course.html`:
```html
<!doctype html>
<html><body>
<table id="assignments-student-table">
<thead><tr role="row"><th>Name</th><th>Status</th><th>Released / Due</th></tr></thead>
<tbody>
<tr role="row">
  <th class="table--primaryLink"><a href="/courses/111111/assignments/900001/submissions/5">HW1</a></th>
  <td class="submissionStatus"><div class="submissionStatus--score">9.0 / 10.0</div></td>
  <td><div class="submissionTimeChart">
    <time class="submissionTimeChart--releaseDate" datetime="2026-09-01 00:00:00 -0400">Sep 01</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-09-10 23:59:00 -0400">Sep 10</time>
  </div></td>
</tr>
<tr role="row">
  <th class="table--primaryLink"><a href="/courses/111111/assignments/900002">HW2</a></th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td><div class="submissionTimeChart">
    <time class="submissionTimeChart--releaseDate" datetime="2026-10-10 00:00:00 -0400">Oct 10</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-20 23:59:00 -0400">Oct 20</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-22 23:59:00 -0400">Oct 22</time>
  </div></td>
</tr>
<tr role="row">
  <th><button class="js-submitAssignment" data-assignment-id="900003" data-assignment-title="Quiz 1">Quiz 1</button></th>
  <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td>
  <td><div class="submissionTimeChart">
    <time class="submissionTimeChart--dueDate" datetime="2026-10-25T23:59:00-04:00">Oct 25</time>
  </div></td>
</tr>
<tr role="row">
  <th class="table--primaryLink"><a href="/courses/111111/assignments/900004">Optional survey</a></th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td></td>
</tr>
</tbody>
<tfoot><tr role="row"><td colspan="3">Showing 4 assignments</td></tr></tfoot>
</table>
</body></html>
```

- [ ] **Step 2: Write the failing tests**

`tests/gradescope/parse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseAccount, parseCourse, parseGsDatetime } from "../../src/gradescope/parse";

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/gradescope/parse.test.ts`
Expected: FAIL, "Cannot find module '../../src/gradescope/parse'".

- [ ] **Step 4: Implement**

`src/gradescope/parse.ts`:
```ts
import type { GsAssignment, GsCourse } from "../types";
import { LayoutChanged } from "../errors";

export const GS_BASE = "https://www.gradescope.com";

const DT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/;

export function parseGsDatetime(s: string): string | null {
  const m = s.trim().match(DT);
  if (!m) return null;
  const [, date, time, hh, mm] = m;
  const t = time.length === 5 ? `${time}:00` : time;
  const d = new Date(`${date}T${t}${hh}:${mm}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

export function parseAccount(html: string): GsCourse[] {
  const root = doc(html).querySelector("#account-show");
  if (!root) throw new LayoutChanged("account page: #account-show missing");
  const termEl = root.querySelector(".courseList--term");
  if (!termEl) return [];
  const term = termEl.textContent?.trim() ?? "";
  const block = termEl.nextElementSibling;
  if (!block) return [];
  const out: GsCourse[] = [];
  for (const a of Array.from(block.querySelectorAll<HTMLAnchorElement>("a.courseBox"))) {
    const href = a.getAttribute("href") ?? "";
    const id = href.split("/").filter(Boolean).pop() ?? "";
    if (!/^\d+$/.test(id)) continue; // skips "/courses/new" style boxes
    out.push({
      id,
      shortName: a.querySelector(".courseBox--shortname")?.textContent?.trim() ?? "",
      fullName: a.querySelector(".courseBox--name")?.textContent?.trim() ?? "",
      term,
    });
  }
  return out;
}

const NOT_SUBMITTED = /^(no submission|not submitted)/i;

export function parseCourse(html: string, courseId: string): GsAssignment[] {
  const rows = Array.from(doc(html).querySelectorAll("tr[role=row]"));
  if (rows.length === 0) throw new LayoutChanged(`course ${courseId}: no tr[role=row]`);
  const out: GsAssignment[] = [];
  for (const row of rows) {
    const cells = Array.from(row.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
    if (cells.length < 3) continue;
    const [nameCell, statusCell, dateCell] = cells;
    const link = nameCell.querySelector("a[href]");
    const button = nameCell.querySelector("button[data-assignment-id]");
    let id: string | null = null;
    if (link) {
      // /courses/<cid>/assignments/<aid>[/submissions/<sid>]
      id = (link.getAttribute("href") ?? "").split("/")[4] ?? null;
    } else if (button) {
      id = button.getAttribute("data-assignment-id");
    }
    if (!id) continue;
    const due = dateCell.querySelector("time.submissionTimeChart--dueDate");
    const dueAt = due ? parseGsDatetime(due.getAttribute("datetime") ?? "") : null;
    if (!dueAt) continue;
    const statusText = statusCell.textContent?.trim() ?? "";
    out.push({
      id,
      courseId,
      name: nameCell.textContent?.trim() ?? "",
      dueAt,
      submitted: statusText !== "" && !NOT_SUBMITTED.test(statusText),
      url: `${GS_BASE}/courses/${courseId}/assignments/${id}`,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/gradescope/parse.test.ts`
Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add src/gradescope/parse.ts tests/fixtures tests/gradescope/parse.test.ts
git commit -m "feat: parse Gradescope account and course pages"
```

---

### Task 3: Course matcher

**Files:**
- Create: `src/match/courses.ts`
- Test: `tests/match/courses.test.ts`

**Interfaces:**
- Consumes: `GsCourse`, `CanvasCourse`.
- Produces: `normalizeCode(s: string): string | null`, `matchCourses(gs: GsCourse[], canvas: CanvasCourse[], overrides: Record<string, number | null>): { mapping: Record<string, number | null>; warnings: string[] }`.

- [ ] **Step 1: Write the failing tests**

`tests/match/courses.test.ts`:
```ts
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
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCode(input)).toBe(expected);
  });
  it("returns null when no dept+number is present", () => {
    expect(normalizeCode("Design of Operating Systems")).toBeNull();
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/match/courses.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/match/courses.ts`:
```ts
import type { CanvasCourse, GsCourse } from "../types";

const CODE = /([A-Z]{2,4})[ \-_]?(\d{4})/;

export function normalizeCode(s: string): string | null {
  const m = s.toUpperCase().match(CODE);
  return m ? `${m[1]}${m[2]}` : null;
}

export function matchCourses(
  gs: GsCourse[],
  canvas: CanvasCourse[],
  overrides: Record<string, number | null>,
): { mapping: Record<string, number | null>; warnings: string[] } {
  const index = new Map<string, number[]>();
  for (const c of canvas) {
    const key = normalizeCode(c.course_code ?? "") ?? normalizeCode(c.name ?? "");
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), c.id]);
  }
  const mapping: Record<string, number | null> = {};
  const warnings: string[] = [];
  for (const g of gs) {
    if (g.id in overrides) {
      mapping[g.id] = overrides[g.id];
      continue;
    }
    const key = normalizeCode(g.shortName) ?? normalizeCode(g.fullName);
    const ids = key ? index.get(key) ?? [] : [];
    if (ids.length === 1) {
      mapping[g.id] = ids[0];
    } else {
      mapping[g.id] = null;
      if (ids.length > 1) warnings.push(`${g.shortName}: ${ids.length} Canvas courses match; pick one in options`);
    }
  }
  return { mapping, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/match/courses.test.ts`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add src/match/courses.ts tests/match/courses.test.ts
git commit -m "feat: match Gradescope courses to Canvas courses by code"
```

---

### Task 4: Sync planner (pure diff)

**Files:**
- Create: `src/sync/plan.ts`
- Test: `tests/sync/plan.test.ts`

**Interfaces:**
- Consumes: `GsAssignment`, `State`, `SyncOp`.
- Produces: `planOps(assignments: GsAssignment[], mapping: Record<string, number | null>, state: Pick<State, "notes" | "ignored">): SyncOp[]`.

- [ ] **Step 1: Write the failing tests**

`tests/sync/plan.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/plan.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/sync/plan.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/plan.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sync/plan.ts tests/sync/plan.test.ts
git commit -m "feat: plan sync operations from scraped state"
```

---

### Task 5: Storage and Canvas HTTP client

**Files:**
- Create: `src/storage.ts`, `src/canvas/client.ts`
- Test: `tests/storage.test.ts`, `tests/canvas/client.test.ts`

**Interfaces:**
- Consumes: `State`, `SessionExpired`.
- Produces:
  - `loadState(): Promise<State>`, `saveState(s: State): Promise<void>`
  - `CANVAS_BASE` constant
  - `type FetchFn = typeof fetch`, `type CookieReader = (url: string, name: string) => Promise<string | null>`
  - `class CanvasClient { constructor(fetchFn?: FetchFn, readCookie?: CookieReader); get<T>(path): Promise<T>; post<T>(path, body): Promise<T>; put<T>(path, body): Promise<T> }`
  - `parseCanvasJson<T>(text: string): T`

- [ ] **Step 1: Write the failing tests**

`tests/storage.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadState, saveState } from "../src/storage";

let store: Record<string, unknown> = {};
beforeEach(() => {
  store = {};
  (globalThis as any).browser = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
      },
    },
  };
});

describe("storage", () => {
  it("returns defaults when empty", async () => {
    expect(await loadState()).toEqual({ mappings: {}, notes: {}, ignored: [] });
  });
  it("round-trips", async () => {
    const s = await loadState();
    s.ignored.push("x");
    await saveState(s);
    expect((await loadState()).ignored).toEqual(["x"]);
  });
});
```

`tests/canvas/client.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CanvasClient, parseCanvasJson, CANVAS_BASE } from "../../src/canvas/client";
import { SessionExpired } from "../../src/errors";

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: string, finalUrl = `${CANVAS_BASE}/api/v1/x`) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return { ok: status < 400, status, url: finalUrl, text: async () => body } as Response;
  }) as typeof fetch;
  return { fn, calls };
}
const cookie = (value: string | null) => async () => value;

describe("parseCanvasJson", () => {
  it("strips the while(1); prefix", () => {
    expect(parseCanvasJson('while(1);{"a":1}')).toEqual({ a: 1 });
    expect(parseCanvasJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("CanvasClient", () => {
  it("GET sends cookies and Accept header, no CSRF", async () => {
    const f = fakeFetch(200, 'while(1);[{"id":1}]');
    const c = new CanvasClient(f.fn, cookie("tok"));
    expect(await c.get("/api/v1/courses")).toEqual([{ id: 1 }]);
    expect(f.calls[0].url).toBe(`${CANVAS_BASE}/api/v1/courses`);
    expect(f.calls[0].init.credentials).toBe("include");
    expect((f.calls[0].init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });
  it("POST sends decoded CSRF token and JSON body", async () => {
    const f = fakeFetch(200, '{"id":9}');
    const c = new CanvasClient(f.fn, cookie("abc%2Fdef%3D"));
    await c.post("/api/v1/planner_notes", { title: "t" });
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h["X-CSRF-Token"]).toBe("abc/def=");
    expect(h["Content-Type"]).toBe("application/json");
    expect(f.calls[0].init.body).toBe('{"title":"t"}');
    expect(f.calls[0].init.method).toBe("POST");
  });
  it("throws SessionExpired on 401", async () => {
    const c = new CanvasClient(fakeFetch(401, '{"status":"unauthenticated"}').fn, cookie("tok"));
    await expect(c.get("/api/v1/courses")).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws SessionExpired when redirected to login", async () => {
    const c = new CanvasClient(fakeFetch(200, "<html>", `${CANVAS_BASE}/login/saml`).fn, cookie("tok"));
    await expect(c.get("/api/v1/courses")).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws SessionExpired when the CSRF cookie is missing", async () => {
    const c = new CanvasClient(fakeFetch(200, "{}").fn, cookie(null));
    await expect(c.post("/api/v1/planner_notes", {})).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws a plain Error on other failures", async () => {
    const c = new CanvasClient(fakeFetch(500, "boom").fn, cookie("tok"));
    await expect(c.get("/x")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/storage.test.ts tests/canvas/client.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/storage.ts`:
```ts
import type { State } from "./types";

const KEY = "state";
const DEFAULT: State = { mappings: {}, notes: {}, ignored: [] };

export async function loadState(): Promise<State> {
  const r = await browser.storage.local.get(KEY);
  const stored = (r[KEY] as Partial<State> | undefined) ?? {};
  return { ...structuredClone(DEFAULT), ...stored };
}

export async function saveState(s: State): Promise<void> {
  await browser.storage.local.set({ [KEY]: s });
}
```

`src/canvas/client.ts`:
```ts
import { SessionExpired } from "../errors";

export const CANVAS_BASE = "https://gatech.instructure.com";

export type FetchFn = typeof fetch;
export type CookieReader = (url: string, name: string) => Promise<string | null>;

export function parseCanvasJson<T>(text: string): T {
  return JSON.parse(text.replace(/^while\(1\);/, "")) as T;
}

async function browserCookie(url: string, name: string): Promise<string | null> {
  const c = await browser.cookies.get({ url, name });
  return c?.value ?? null;
}

export class CanvasClient {
  constructor(
    private readonly fetchFn: FetchFn = (...args: Parameters<typeof fetch>) => fetch(...args),
    private readonly readCookie: CookieReader = browserCookie,
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      const token = await this.readCookie(CANVAS_BASE, "_csrf_token");
      if (!token) throw new SessionExpired("canvas");
      headers["X-CSRF-Token"] = decodeURIComponent(token);
      headers["Content-Type"] = "application/json";
    }
    const res = await this.fetchFn(CANVAS_BASE + path, {
      method,
      headers,
      credentials: "include",
      redirect: "follow",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.url.includes("/login")) throw new SessionExpired("canvas");
    if (!res.ok) throw new Error(`Canvas ${method} ${path} -> ${res.status}`);
    const text = await res.text();
    return (text ? parseCanvasJson<T>(text) : (undefined as T));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/storage.test.ts tests/canvas/client.test.ts && npm run typecheck`
Expected: 9 passed, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts src/canvas/client.ts tests/storage.test.ts tests/canvas/client.test.ts
git commit -m "feat: extension storage and cookie-session Canvas client"
```

---

### Task 6: Canvas API wrapper

**Files:**
- Create: `src/canvas/api.ts`
- Test: `tests/canvas/api.test.ts`

**Interfaces:**
- Consumes: `CanvasClient` (`get`/`post`/`put`), `CanvasCourse`.
- Produces:
  ```ts
  type NoteInput = { title: string; details: string; todo_date: string; course_id?: number };
  type NotePatch = { title?: string; todo_date?: string; course_id?: number | null };
  class CanvasApi {
    constructor(client: Pick<CanvasClient, "get" | "post" | "put">);
    listActiveCourses(): Promise<CanvasCourse[]>;
    createNote(n: NoteInput): Promise<number>;        // returns note id
    updateNote(id: number, patch: NotePatch): Promise<void>;
    setComplete(noteId: number, complete: boolean, overrideId?: number): Promise<number>; // returns override id
  }
  ```

- [ ] **Step 1: Write the failing tests**

`tests/canvas/api.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/canvas/api.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/canvas/api.ts`:
```ts
import type { CanvasCourse } from "../types";
import type { CanvasClient } from "./client";

export type NoteInput = { title: string; details: string; todo_date: string; course_id?: number };
export type NotePatch = { title?: string; todo_date?: string; course_id?: number | null };

type Client = Pick<CanvasClient, "get" | "post" | "put">;

export class CanvasApi {
  constructor(private readonly client: Client) {}

  async listActiveCourses(): Promise<CanvasCourse[]> {
    const rows = await this.client.get<Partial<CanvasCourse>[]>("/api/v1/courses?enrollment_state=active&per_page=100");
    return rows
      .filter((r): r is CanvasCourse => typeof r.id === "number" && typeof r.course_code === "string")
      .map((r) => ({ id: r.id, name: r.name ?? "", course_code: r.course_code }));
  }

  async createNote(n: NoteInput): Promise<number> {
    const r = await this.client.post<{ id: number }>("/api/v1/planner_notes", n);
    return r.id;
  }

  async updateNote(id: number, patch: NotePatch): Promise<void> {
    await this.client.put(`/api/v1/planner_notes/${id}`, patch);
  }

  async setComplete(noteId: number, complete: boolean, overrideId?: number): Promise<number> {
    if (overrideId === undefined) {
      const r = await this.client.post<{ id: number }>("/api/v1/planner/overrides", {
        plannable_type: "planner_note",
        plannable_id: noteId,
        marked_complete: complete,
      });
      return r.id;
    }
    await this.client.put(`/api/v1/planner/overrides/${overrideId}`, { marked_complete: complete });
    return overrideId;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/canvas/api.test.ts && npm run typecheck`
Expected: 4 passed, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/api.ts tests/canvas/api.test.ts
git commit -m "feat: Canvas planner notes and overrides API wrapper"
```

---

### Task 7: Gradescope HTTP client

**Files:**
- Create: `src/gradescope/client.ts`
- Test: `tests/gradescope/client.test.ts`

**Interfaces:**
- Consumes: `FetchFn` (Task 5), `SessionExpired`, `GS_BASE` (Task 2).
- Produces: `class GradescopeClient { constructor(fetchFn?: FetchFn); fetchAccount(): Promise<string>; fetchCourse(id: string): Promise<string> }`.

- [ ] **Step 1: Write the failing tests**

`tests/gradescope/client.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GradescopeClient } from "../../src/gradescope/client";
import { SessionExpired } from "../../src/errors";

function fakeFetch(status: number, body: string, finalUrl: string) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.credentials).toBe("include");
    return { ok: status < 400, status, url: finalUrl, text: async () => body } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

describe("GradescopeClient", () => {
  it("returns the account page html", async () => {
    const f = fakeFetch(200, "<html>acct</html>", "https://www.gradescope.com/account");
    expect(await new GradescopeClient(f.fn).fetchAccount()).toBe("<html>acct</html>");
    expect(f.calls[0]).toBe("https://www.gradescope.com/account");
  });
  it("returns a course page html", async () => {
    const f = fakeFetch(200, "<html>c</html>", "https://www.gradescope.com/courses/111");
    expect(await new GradescopeClient(f.fn).fetchCourse("111")).toBe("<html>c</html>");
    expect(f.calls[0]).toBe("https://www.gradescope.com/courses/111");
  });
  it("throws SessionExpired when redirected away from the requested path", async () => {
    const f = fakeFetch(200, "<html>login</html>", "https://www.gradescope.com/login");
    await expect(new GradescopeClient(f.fn).fetchAccount()).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws SessionExpired on 401", async () => {
    const f = fakeFetch(401, "", "https://www.gradescope.com/account");
    await expect(new GradescopeClient(f.fn).fetchAccount()).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws a plain Error on 500", async () => {
    const f = fakeFetch(500, "", "https://www.gradescope.com/account");
    await expect(new GradescopeClient(f.fn).fetchAccount()).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/gradescope/client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/gradescope/client.ts`:
```ts
import { SessionExpired } from "../errors";
import type { FetchFn } from "../canvas/client";
import { GS_BASE } from "./parse";

export class GradescopeClient {
  constructor(private readonly fetchFn: FetchFn = (...args: Parameters<typeof fetch>) => fetch(...args)) {}

  fetchAccount(): Promise<string> {
    return this.page("/account");
  }
  fetchCourse(id: string): Promise<string> {
    return this.page(`/courses/${id}`);
  }

  private async page(path: string): Promise<string> {
    const url = GS_BASE + path;
    const res = await this.fetchFn(url, { credentials: "include", redirect: "follow" });
    if (res.status === 401) throw new SessionExpired("gradescope");
    const finalPath = new URL(res.url || url).pathname.replace(/\/$/, "");
    if (finalPath !== path) throw new SessionExpired("gradescope"); // any redirect means logged out
    if (!res.ok) throw new Error(`Gradescope GET ${path} -> ${res.status}`);
    return res.text();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/gradescope/client.test.ts && npm run typecheck`
Expected: 5 passed, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/gradescope/client.ts tests/gradescope/client.test.ts
git commit -m "feat: Gradescope page client with logout detection"
```

---

### Task 8: runSync orchestration

**Files:**
- Create: `src/background/sync.ts`
- Test: `tests/background/sync.test.ts`

**Interfaces:**
- Consumes: `parseAccount`, `parseCourse`, `matchCourses`, `planOps`, `CanvasApi` methods, `GradescopeClient` methods, `State`, `SyncCounts`, `SessionExpired`.
- Produces:
  ```ts
  type SyncDeps = {
    gs: Pick<GradescopeClient, "fetchAccount" | "fetchCourse">;
    canvas: Pick<CanvasApi, "listActiveCourses" | "createNote" | "updateNote" | "setComplete">;
    loadState: () => Promise<State>;
    saveState: (s: State) => Promise<void>;
    now: () => Date;
  };
  function runSync(deps: SyncDeps): Promise<SyncCounts>;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/background/sync.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/background/sync.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/background/sync.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/background/sync.test.ts && npm run typecheck`
Expected: 6 passed, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/background/sync.ts tests/background/sync.test.ts
git commit -m "feat: runSync orchestrates scrape, match, plan and Canvas writes"
```

---

### Task 9: Background entry, manifest, build

**Files:**
- Create: `src/background/index.ts`, `static/manifest.json`, `scripts/build.mjs`
- Create: `static/popup.html`, `static/options.html` (shells; scripts land in Tasks 10 and 11)
- Create: `src/popup/popup.ts`, `src/options/options.ts` (one-line stubs so the build has all entries; replaced in Tasks 10 and 11)

**Interfaces:**
- Consumes: `runSync`, clients, storage, `SessionExpired`.
- Produces: runtime message protocol `{ type: "sync" }` → responds with `SyncCounts | { error: State["lastError"] } | { skipped: true }`. Popup (Task 10) relies on this.

- [ ] **Step 1: Write manifest and html shells**

`static/manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "Gradescope to Canvas Sync",
  "version": "0.1.0",
  "description": "Mirrors Gradescope assignments into Canvas Planner To-Do notes.",
  "browser_specific_settings": {
    "gecko": { "id": "gradescope-canvas-sync@jaimejr1", "strict_min_version": "115.0" }
  },
  "permissions": ["alarms", "storage", "cookies"],
  "host_permissions": ["https://www.gradescope.com/*", "https://gatech.instructure.com/*"],
  "background": { "scripts": ["background.js"] },
  "action": { "default_title": "Gradescope to Canvas Sync", "default_popup": "popup.html" },
  "options_ui": { "page": "options.html", "open_in_tab": true }
}
```

`static/popup.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { font: 13px system-ui, sans-serif; width: 260px; padding: 10px; margin: 0; }
  button { width: 100%; padding: 6px; margin-top: 8px; }
  .err { color: #b00020; }
  .muted { color: #666; }
  a { display: block; margin-top: 8px; }
</style></head>
<body>
  <div id="status" class="muted">Loading…</div>
  <div id="counts"></div>
  <div id="error" class="err"></div>
  <button id="sync">Sync now</button>
  <a id="options" href="#">Course mapping…</a>
  <script src="popup.js"></script>
</body></html>
```

`static/options.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  body { font: 14px system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
  .warn { color: #8a5a00; }
  .muted { color: #666; }
</style></head>
<body>
  <h1>Gradescope to Canvas: course mapping</h1>
  <p class="muted">Run a sync once so the course lists are filled. "Auto" uses the course-code match; pick a course to override, or "(none)" to create notes with no course.</p>
  <div id="warnings" class="warn"></div>
  <table>
    <thead><tr><th>Gradescope course</th><th>Canvas course</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <p><button id="save">Save</button> <span id="saved" class="muted"></span></p>
  <script src="options.js"></script>
</body></html>
```

- [ ] **Step 2: Write the build script and stub entries**

`scripts/build.mjs`:
```js
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: {
    background: "src/background/index.ts",
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts",
  },
  bundle: true,
  format: "iife",
  target: "firefox115",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
});
cpSync("static", "dist", { recursive: true });
```

`src/popup/popup.ts` (stub, replaced in Task 10):
```ts
export {};
```

`src/options/options.ts` (stub, replaced in Task 11):
```ts
export {};
```

- [ ] **Step 3: Write the background entry**

`src/background/index.ts`:
```ts
import { runSync } from "./sync";
import { GradescopeClient } from "../gradescope/client";
import { CanvasClient } from "../canvas/client";
import { CanvasApi } from "../canvas/api";
import { loadState, saveState } from "../storage";
import { SessionExpired } from "../errors";
import type { State, SyncCounts } from "../types";

const ALARM = "sync";
const PERIOD_MINUTES = 60;

export type SyncResponse = SyncCounts | { error: NonNullable<State["lastError"]> } | { skipped: true };

let running = false;

async function setBadge(text: "" | "!" | "?"): Promise<void> {
  await browser.action.setBadgeText({ text });
  if (text) await browser.action.setBadgeBackgroundColor({ color: text === "!" ? "#d32f2f" : "#757575" });
}

export async function syncWithBadge(): Promise<SyncResponse> {
  if (running) return { skipped: true };
  running = true;
  try {
    const counts = await runSync({
      gs: new GradescopeClient(),
      canvas: new CanvasApi(new CanvasClient()),
      loadState,
      saveState,
      now: () => new Date(),
    });
    await setBadge(counts.failed > 0 ? "?" : "");
    return counts;
  } catch (e) {
    const site = e instanceof SessionExpired ? e.site : "other";
    const s = await loadState();
    s.lastError = { at: new Date().toISOString(), site, message: String((e as Error)?.message ?? e) };
    await saveState(s);
    await setBadge(site === "other" ? "?" : "!");
    return { error: s.lastError };
  } finally {
    running = false;
  }
}

function ensureAlarm(): void {
  browser.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
}

browser.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void syncWithBadge();
});
browser.runtime.onStartup.addListener(ensureAlarm);
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void syncWithBadge();
});
browser.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "sync") {
    return syncWithBadge();
  }
  return undefined;
});
```

- [ ] **Step 4: Build and lint**

Run: `npm run build && npm run lint`
Expected: `dist/background.js`, `dist/popup.js`, `dist/options.js`, `dist/manifest.json`, two html files; web-ext lint reports 0 errors (warnings about `innerHTML` are acceptable only if none appear; there is no innerHTML in this plan).

- [ ] **Step 5: Smoke run**

Run: `npm start` (opens a temporary Firefox profile with the extension loaded). In that Firefox: sign in to `https://www.gradescope.com` and `https://gatech.instructure.com`, then click the toolbar icon. Popup is still a stub, so instead open `about:debugging#/runtime/this-firefox`, click Inspect on the extension, and in the console run:
```js
browser.runtime.sendMessage({ type: "sync" }).then(console.log)
```
Expected: an object with `created` ≥ 0 and `failed: 0`, or `{ error: { site: "gradescope" | "canvas" } }` if not signed in. Check Canvas → Dashboard → List View for `[Gradescope] …` items.

- [ ] **Step 6: Commit**

```bash
git add static scripts src/background/index.ts src/popup/popup.ts src/options/options.ts
git commit -m "feat: background event page with hourly alarm, manifest and build"
```

---

### Task 10: Popup

**Files:**
- Modify: `src/popup/popup.ts` (replace stub)

**Interfaces:**
- Consumes: `loadState`, message `{ type: "sync" }` → `SyncResponse` (Task 9), `State`.

- [ ] **Step 1: Implement**

`src/popup/popup.ts`:
```ts
import { loadState } from "../storage";
import type { State, SyncCounts } from "../types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function render(state: State): void {
  const ls = state.lastSync;
  $("status").textContent = ls ? `Last sync: ${fmt(ls.at)}` : "Never synced";
  $("counts").textContent = ls
    ? `created ${ls.created} · updated ${ls.updated} · completed ${ls.completed} · failed ${ls.failed}`
    : "";
  const le = state.lastError;
  const stale = le && (!ls || le.at > ls.at);
  $("error").textContent = stale
    ? le.site === "other"
      ? `Error: ${le.message}`
      : `Signed out of ${le.site === "gradescope" ? "Gradescope" : "Canvas"}. Sign in and press Sync now.`
    : "";
}

async function refresh(): Promise<void> {
  render(await loadState());
}

$("sync").addEventListener("click", async () => {
  const btn = $("sync") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = (await browser.runtime.sendMessage({ type: "sync" })) as SyncCounts | { error: unknown } | { skipped: true };
    if ("skipped" in r) $("status").textContent = "A sync is already running";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync now";
    await refresh();
  }
});

$("options").addEventListener("click", (e) => {
  e.preventDefault();
  void browser.runtime.openOptionsPage();
});

void refresh();
```

- [ ] **Step 2: Build, typecheck, manual check**

Run: `npm run typecheck && npm run build && npm start`
Expected: toolbar popup shows "Never synced" or the last sync line; "Sync now" disables the button, then shows counts; after signing out of Gradescope and syncing, the red line "Signed out of Gradescope…" appears and the toolbar badge shows "!".

- [ ] **Step 3: Commit**

```bash
git add src/popup/popup.ts
git commit -m "feat: popup with sync button and status"
```

---

### Task 11: Options page (course mapping)

**Files:**
- Modify: `src/options/options.ts` (replace stub)

**Interfaces:**
- Consumes: `loadState`, `saveState`, `State.cache`, `State.mappings`.
- Semantics: select value `"auto"` deletes the override; `"none"` stores `null`; a numeric string stores that Canvas id.

- [ ] **Step 1: Implement**

`src/options/options.ts`:
```ts
import { loadState, saveState } from "../storage";
import type { State } from "../types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}

function render(state: State): void {
  const rows = $("rows");
  rows.textContent = "";
  const cache = state.cache;
  $("warnings").textContent = cache?.warnings.join(" · ") ?? "";
  if (!cache || cache.gsCourses.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.className = "muted";
    td.textContent = "No courses yet. Open the popup and press Sync now.";
    tr.append(td);
    rows.append(tr);
    return;
  }
  const byId = new Map(cache.canvasCourses.map((c) => [c.id, c]));
  for (const g of cache.gsCourses) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = `${g.shortName} — ${g.fullName}`;
    const cell = document.createElement("td");
    const sel = document.createElement("select");
    sel.dataset.gs = g.id;
    const override = g.id in state.mappings ? state.mappings[g.id] : undefined;
    const auto = cache.mapping[g.id];
    const autoLabel = auto !== null && auto !== undefined ? `Auto: ${byId.get(auto)?.course_code ?? auto}` : "Auto: no match";
    sel.append(option("auto", autoLabel, override === undefined));
    sel.append(option("none", "(none)", override === null));
    for (const c of cache.canvasCourses) {
      sel.append(option(String(c.id), `${c.course_code} — ${c.name}`, override === c.id));
    }
    cell.append(sel);
    tr.append(name, cell);
    rows.append(tr);
  }
}

async function save(): Promise<void> {
  const state = await loadState();
  const mappings: State["mappings"] = {};
  for (const sel of Array.from(document.querySelectorAll<HTMLSelectElement>("select[data-gs]"))) {
    const gsId = sel.dataset.gs!;
    if (sel.value === "auto") continue;
    mappings[gsId] = sel.value === "none" ? null : Number(sel.value);
  }
  state.mappings = mappings;
  await saveState(state);
  $("saved").textContent = "Saved. Takes effect on the next sync.";
}

$("save").addEventListener("click", () => void save());
void loadState().then(render);
```

- [ ] **Step 2: Build, typecheck, manual check**

Run: `npm run typecheck && npm run build && npm start`
Expected: after one sync, the options page lists each current-term Gradescope course with a dropdown defaulting to "Auto: CS-3210-A" style labels. Change one to "(none)", Save, reload the page: the choice persists. Run Sync now: the next sync moves that course's notes to no course (visible in Planner as items without a course colour).

- [ ] **Step 3: Commit**

```bash
git add src/options/options.ts
git commit -m "feat: options page for course mapping overrides"
```

---

### Task 12: Real fixtures and end-to-end check (user-run)

**Files:**
- Create: `tests/fixtures/real-account.html`, `tests/fixtures/real-course.html` (saved by the user, scrubbed)
- Modify: `tests/gradescope/parse.test.ts` (append the block below)
- Create: `README.md`

This task needs a signed-in Gradescope session, so the user runs the capture; an agent can do the rest.

- [ ] **Step 1: Capture real pages (user)**

In Firefox, signed in to Gradescope: open `https://www.gradescope.com/account`, press Ctrl/Cmd+U (view source), save as `tests/fixtures/real-account.html`. Open one course page and save it as `tests/fixtures/real-course.html`. Remove your name/email from both files with find-and-replace.

- [ ] **Step 2: Append smoke tests that skip when the files are absent**

Add `import { existsSync } from "node:fs";` to the top of `tests/gradescope/parse.test.ts`, then append:
```ts

const realAccount = new URL("../fixtures/real-account.html", import.meta.url);
const realCourse = new URL("../fixtures/real-course.html", import.meta.url);

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
```

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green; the two real-page suites run (not skipped) when the files exist.

- [ ] **Step 4: Write README**

`README.md`:
```markdown
# gradescope-canvas-sync

Firefox extension. Every hour it reads your Gradescope dashboard and creates a
Canvas Planner To-Do note per open assignment at gatech.instructure.com, then
checks the note off when you submit. Notes show in the Canvas To-Do sidebar,
Planner, Calendar and the BetterCanvas due card.

## Run from source

    npm install
    npm run build
    npm start          # temporary Firefox profile with the extension loaded

Sign in to Gradescope and Canvas in that window, click the toolbar icon,
press "Sync now". Fix course matches under "Course mapping…".

## Install permanently

    npx web-ext build -s dist

Load the resulting zip via `about:addons` → gear → Install Add-on From File
(requires `xpinstall.signatures.required=false` in `about:config` on
Developer Edition or Nightly), or submit it to AMO for signing.

## Badge

- `!` red: signed out of Gradescope or Canvas. Sign in, then Sync now.
- `?` grey: some other error; open the popup for the message.

## Tests

    npm test
```

- [ ] **Step 5: Full end-to-end (user)**

With the extension running: submit something on Gradescope, press Sync now, confirm the matching note is checked off in Canvas Planner within a few seconds. Change a mapping in options, Sync now, confirm the note moved course.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/real-*.html tests/gradescope/parse.test.ts README.md
git commit -m "test: real-page fixtures and README"
```

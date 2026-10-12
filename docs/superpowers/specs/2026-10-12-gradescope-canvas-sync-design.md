# gradescope-canvas-sync — design

Date: 2026-10-12
Status: approved in chat, awaiting spec review

## Goal

A Firefox extension that makes every Gradescope assignment appear in
Georgia Tech Canvas (gatech.instructure.com) as a Planner To-Do note, so
Gradescope deadlines show in the Canvas To-Do sidebar, Planner, Calendar,
and the BetterCanvas "assignments due" card without any changes to
BetterCanvas.

Success: open Canvas and see "[Gradescope] HW3" under CS 3210 with the
right due date, within an hour of it appearing on Gradescope. Submit on
Gradescope and the note is checked off within an hour.

## Constraints (from the user)

- Canvas: gatech.instructure.com. Gradescope: www.gradescope.com via GT SSO.
- Students cannot create Canvas assignments. Planner notes are the target.
- Sync runs in the background every hour, plus a manual "Sync now" button.
- Courses auto-match by course code, with manual override in an options page.
- Submitted on Gradescope ⇒ note marked complete. Past due and unsubmitted
  ⇒ note stays open.
- No credentials are stored. The extension reuses the browser's logged-in
  cookies for both sites. When a session has expired it must say so, not
  write stale data.
- Firefox only (Manifest V3, event-page background script).

## Architecture

```
alarm (60 min) / toolbar click
        │
        ▼
 background/sync.ts ──► gradescope/client.ts ──► gradescope/parse.ts
        │                 (fetch pages)            (HTML → Course[], Assignment[])
        │
        ├──► canvas/client.ts ──► canvas/api.ts
        │     (fetch + CSRF)       (courses, planner notes, overrides)
        │
        ├──► match/courses.ts   (Gradescope course → Canvas course id)
        ├──► sync/plan.ts       (desired state vs stored state → list of ops)
        └──► storage.ts         (browser.storage.local)
options page ──► storage.ts (mappings, last sync, status)
popup        ──► "Sync now", last sync time, error line
```

Pure modules (`parse`, `match`, `plan`) take plain data and return plain
data. Only `client` modules and `sync.ts` touch `fetch`, cookies, and
storage.

## Components

### gradescope/client.ts
- `fetchAccount()` → GET `https://www.gradescope.com/account`,
  `credentials: "include"`, `redirect: "follow"`.
- `fetchCourse(courseId)` → GET `https://www.gradescope.com/courses/<id>`.
- Logged-out detection: final URL contains `/login`, or the response lacks
  `div#account-show` (account) / `table` with `tr[role=row]` (course).
  Throws `SessionExpired("gradescope")`.

### gradescope/parse.ts (verified against nyuoss/gradescope-api selectors)
- `parseAccount(html)` → `GsCourse[]`
  - container `div#account-show`
  - each term block `div.courseList`; term text from its heading, e.g.
    "Fall 2026"
  - each course `a.courseBox`: id = last path segment of `href`,
    shortName = `h3.courseBox--shortname`, fullName = `div.courseBox--name`
  - Only the first (most recent) term block is returned.
- `parseCourse(html, courseId)` → `GsAssignment[]`
  - rows: `tr[role=row]`, skip header and footer
  - name: first cell text; id: from the cell's `a[href]` fourth path
    segment or `button[data-assignment-id]`; rows with neither id are skipped
  - status: second cell text; `submitted = text !== "No Submission"`
    (a score like "9 / 10" also counts as submitted)
  - dueAt: first `time.submissionTimeChart--dueDate` `datetime` attribute,
    parsed as ISO with offset. Late due dates are ignored.
  - Rows with no due date are dropped.

Types:
```ts
type GsCourse = { id: string; shortName: string; fullName: string; term: string };
type GsAssignment = { id: string; courseId: string; name: string;
                      dueAt: string /* ISO */; submitted: boolean; url: string };
```

### canvas/client.ts
- Base `https://gatech.instructure.com`.
- `get(path)` / `post(path, body)` / `put(path, body)` with
  `credentials: "include"`, `Accept: application/json`.
- JSON bodies from a cookie session are prefixed with `while(1);` — strip
  it before `JSON.parse`.
- Mutations send `X-CSRF-Token` = `decodeURIComponent` of the `_csrf_token`
  cookie, read with `browser.cookies.get`.
- 401, or a redirect to `/login`, throws `SessionExpired("canvas")`.

### canvas/api.ts
- `listActiveCourses()` → GET `/api/v1/courses?enrollment_state=active&per_page=100`
  → `{ id, name, course_code }[]`.
- `createNote({ title, details, todo_date, course_id })` → POST `/api/v1/planner_notes`.
- `updateNote(id, { todo_date, title })` → PUT `/api/v1/planner_notes/:id`.
- `markComplete(noteId, complete)` → POST `/api/v1/planner/overrides`
  `{ plannable_type: "planner_note", plannable_id, marked_complete }` the
  first time; PUT `/api/v1/planner/overrides/:id` afterwards. Returns the
  override id.

### match/courses.ts
- `normalize("CS 3210")` and `normalize("CS-3210-A")` both → `CS3210`:
  uppercase, strip non-alphanumerics, then keep the leading
  letters+digits group.
- `matchCourses(gs: GsCourse[], canvas: CanvasCourse[], overrides)` →
  `Record<gsCourseId, canvasCourseId | null>`. Override wins; otherwise
  exact normalized match; otherwise `null` (note is created with no course).
- Ambiguous matches (two Canvas courses normalize the same) → `null` and a
  warning shown in the options page.

### sync/plan.ts
Input: scraped assignments, course mapping, stored `notes` map, `now`.
Output: ordered list of ops: `create`, `update`, `complete`, `reopen`.

Rules:
- First time an assignment is seen and it is already `submitted`: skip,
  record as `ignored` so it is never created later.
- Not seen before, not submitted, has due date: `create`.
- Seen before, `dueAt` changed: `update`.
- Seen before, `submitted` flipped false→true: `complete`.
- Seen before, `submitted` flipped true→false (resubmission window): `reopen`.
- Assignments that vanish from Gradescope are left alone in Canvas.

### storage.ts (browser.storage.local)
```ts
type State = {
  mappings: Record<string, number | null>;          // user overrides only
  notes: Record<string, { noteId: number; overrideId?: number;
                          dueAt: string; submitted: boolean; courseId: number | null }>;
  ignored: string[];                                 // gs assignment ids
  lastSync?: { at: string; created: number; updated: number; completed: number };
  lastError?: { at: string; site: "gradescope" | "canvas" | "other"; message: string };
};
```

### background/sync.ts
1. `browser.alarms.create("sync", { periodInMinutes: 60 })` on install;
   also run on toolbar click.
2. Guard against overlapping runs with an in-memory flag.
3. Fetch account → parse courses → fetch each course → parse assignments.
4. Fetch Canvas courses → match.
5. `plan()` → execute ops sequentially → update `notes`/`ignored` after
   each successful op (partial progress survives a crash).
6. Badge: clear on success, red "!" on `SessionExpired`, grey "?" on any
   other error. `lastError` stored for the popup.

### UI
- Popup: last sync time, counts, error line, "Sync now" button, link to
  options.
- Options: table of Gradescope courses (current term) with a dropdown of
  Canvas courses plus "(none)". Saving writes `mappings`.

## Note content

- title: `[Gradescope] <assignment name>`
- todo_date: `dueAt`
- course_id: mapped Canvas course or omitted
- details: `Submit on Gradescope: https://www.gradescope.com/courses/<cid>/assignments/<aid>`

## Permissions (manifest)

- `alarms`, `storage`, `cookies`
- host_permissions: `https://www.gradescope.com/*`,
  `https://gatech.instructure.com/*`

## Error handling

- Session expired on either site: stop, badge "!", record `lastError`;
  nothing written. Next hourly run retries.
- A single Canvas op fails (non-auth): log, record `lastError`, continue
  with the remaining ops.
- Parse returns zero courses on a page that is not a login page: treat as
  "Gradescope layout changed", badge "?", do not touch `ignored`.

## Testing

- Unit (vitest + jsdom): `parse.ts` against HTML fixtures saved from the
  user's real `/account` and one course page (scrubbed of personal data);
  `match/courses.ts` table-driven; `sync/plan.ts` state-transition cases
  (first-seen submitted, due change, complete, reopen).
- `canvas/client.ts`: fake `fetch` asserting CSRF header and `while(1);`
  stripping.
- Manual E2E: `web-ext run`, sign in to both sites, click "Sync now",
  verify notes in Canvas Planner and in the BetterCanvas due card.

## Out of scope

- Chrome build, background sync on a schedule shorter than an hour,
  grades, syncing Canvas back to Gradescope, deleting notes, non-GT Canvas
  hosts (the base URL is a constant; making it configurable is a later
  change).

## Tooling

TypeScript, esbuild bundling, `web-ext` for run/lint/build, vitest.

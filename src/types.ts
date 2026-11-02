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

import type { CanvasCourse, GsCourse } from "../types";

// dept (2-4 letters) + 4-digit number, on word boundaries so "202608-CS-3210-A"
// and "CS 3210" both give CS3210 while "Fall 2026" is rejected as a term label.
const CODE = /\b([A-Z]{2,4})[ \-_]?(\d{4})\b/g;
const TERM_WORDS = new Set(["FALL"]);

export function normalizeCode(s: string): string | null {
  for (const m of s.toUpperCase().matchAll(CODE)) {
    if (TERM_WORDS.has(m[1])) continue;
    return `${m[1]}${m[2]}`;
  }
  return null;
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

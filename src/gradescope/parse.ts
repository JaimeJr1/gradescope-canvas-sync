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
  const block = termEl?.nextElementSibling;
  if (!termEl || !block) throw new LayoutChanged("account page: no .courseList--term block");
  const term = termEl.textContent?.trim() ?? "";
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
  if (out.length === 0) throw new LayoutChanged("account page: no a.courseBox under the first term");
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

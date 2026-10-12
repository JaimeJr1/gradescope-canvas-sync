import type { CanvasCourse } from "../types";
import { CanvasHttpError, type CanvasClient } from "./client";

export type NoteInput = { title: string; details: string; todo_date: string; course_id?: number };
export type NotePatch = { title?: string; todo_date?: string; course_id?: number | null };
export type CanvasNote = { id: number; title: string; details: string; todo_date: string; course_id: number | null };
type Override = { id: number; plannable_type: string; plannable_id: number };

type Client = Pick<CanvasClient, "get" | "post" | "put">;

const PAGE = 100;

export class CanvasApi {
  constructor(private readonly client: Client) {}

  private async paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.client.get<T[]>(`${path}?per_page=${PAGE}&page=${page}`);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  async listActiveCourses(): Promise<CanvasCourse[]> {
    const rows = await this.client.get<Partial<CanvasCourse>[]>("/api/v1/courses?enrollment_state=active&per_page=100");
    return rows
      .filter((r): r is CanvasCourse => typeof r.id === "number" && typeof r.course_code === "string")
      .map((r) => ({ id: r.id, name: r.name ?? "", course_code: r.course_code }));
  }

  /** Every planner note the user owns; used to adopt notes this extension created before its storage was lost. */
  async listNotes(): Promise<CanvasNote[]> {
    const rows = await this.paged<Partial<CanvasNote>>("/api/v1/planner_notes");
    return rows
      .filter((r): r is Partial<CanvasNote> & { id: number } => typeof r.id === "number")
      .map((r) => ({
        id: r.id,
        title: r.title ?? "",
        details: r.details ?? "",
        todo_date: r.todo_date ?? "",
        course_id: r.course_id ?? null,
      }));
  }

  async createNote(n: NoteInput): Promise<number> {
    const r = await this.client.post<{ id: number }>("/api/v1/planner_notes", n);
    return r.id;
  }

  async updateNote(id: number, patch: NotePatch): Promise<void> {
    await this.client.put(`/api/v1/planner_notes/${id}`, patch);
  }

  private async findOverride(noteId: number): Promise<number | undefined> {
    const rows = await this.paged<Override>("/api/v1/planner/overrides");
    return rows.find((o) => o.plannable_type === "planner_note" && o.plannable_id === noteId)?.id;
  }

  async setComplete(noteId: number, complete: boolean, overrideId?: number): Promise<number> {
    if (overrideId === undefined) {
      try {
        const r = await this.client.post<{ id: number }>("/api/v1/planner/overrides", {
          plannable_type: "planner_note",
          plannable_id: noteId,
          marked_complete: complete,
        });
        return r.id;
      } catch (e) {
        // 400 = an override already exists (the user checked the box in Canvas); adopt it.
        if (!(e instanceof CanvasHttpError && e.status === 400)) throw e;
        const existing = await this.findOverride(noteId);
        if (existing === undefined) throw e;
        overrideId = existing;
      }
    }
    await this.client.put(`/api/v1/planner/overrides/${overrideId}`, { marked_complete: complete });
    return overrideId;
  }
}

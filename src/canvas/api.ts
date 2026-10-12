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

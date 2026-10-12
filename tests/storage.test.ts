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

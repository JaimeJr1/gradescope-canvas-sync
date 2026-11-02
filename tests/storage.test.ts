import { describe, it, expect, beforeEach } from "vitest";
import { loadState, saveState, saveMappings } from "../src/storage";

let store: Record<string, unknown> = {};
beforeEach(() => {
  store = {};
  (globalThis as any).browser = {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, store[k]])),
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
  it("keeps mappings in their own key so a stale saveState cannot overwrite them", async () => {
    await saveMappings({ g1: 10 });
    const stale = await loadState(); // a running sync holds this copy
    await saveMappings({ g1: 11 }); // options page saves meanwhile
    await saveState(stale); // sync writes its copy back
    expect((await loadState()).mappings).toEqual({ g1: 11 });
  });
});

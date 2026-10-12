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

import type { State } from "./types";

// `mappings` lives under its own key so the options page can save it while a
// sync is running without the sync's periodic saveState() overwriting it.
const STATE_KEY = "state";
const MAPPINGS_KEY = "mappings";
const DEFAULT: Omit<State, "mappings"> = { notes: {}, ignored: [] };

export async function loadState(): Promise<State> {
  const r = await browser.storage.local.get([STATE_KEY, MAPPINGS_KEY]);
  const stored = (r[STATE_KEY] as Partial<Omit<State, "mappings">> | undefined) ?? {};
  const mappings = (r[MAPPINGS_KEY] as State["mappings"] | undefined) ?? {};
  return { ...structuredClone(DEFAULT), ...stored, mappings };
}

export async function saveState(s: State): Promise<void> {
  const { mappings: _ignored, ...rest } = s;
  await browser.storage.local.set({ [STATE_KEY]: rest });
}

export async function saveMappings(m: State["mappings"]): Promise<void> {
  await browser.storage.local.set({ [MAPPINGS_KEY]: m });
}

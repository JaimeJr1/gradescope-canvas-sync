import { runSync } from "./sync";
import { GradescopeClient } from "../gradescope/client";
import { CanvasClient } from "../canvas/client";
import { CanvasApi } from "../canvas/api";
import { loadState, saveState } from "../storage";
import { SessionExpired } from "../errors";
import { HOST_ACCESS_MESSAGE, hasHostAccess } from "../permissions";
import type { State, SyncCounts } from "../types";

const ALARM = "sync";
const PERIOD_MINUTES = 60;

export type SyncResponse = SyncCounts | { error: NonNullable<State["lastError"]> } | { skipped: true };

let running = false;

async function setBadge(text: "" | "!" | "?"): Promise<void> {
  await browser.action.setBadgeText({ text });
  if (text) await browser.action.setBadgeBackgroundColor({ color: text === "!" ? "#d32f2f" : "#757575" });
}

export async function syncWithBadge(): Promise<SyncResponse> {
  if (running) return { skipped: true };
  running = true;
  try {
    if (!(await hasHostAccess())) throw new Error(HOST_ACCESS_MESSAGE);
    const counts = await runSync({
      gs: new GradescopeClient(),
      canvas: new CanvasApi(new CanvasClient()),
      loadState,
      saveState,
      now: () => new Date(),
    });
    await setBadge(counts.failed > 0 ? "?" : "");
    return counts;
  } catch (e) {
    const site = e instanceof SessionExpired ? e.site : "other";
    const s = await loadState();
    s.lastError = { at: new Date().toISOString(), site, message: String((e as Error)?.message ?? e) };
    await saveState(s);
    await setBadge(site === "other" ? "?" : "!");
    return { error: s.lastError };
  } finally {
    running = false;
  }
}

function ensureAlarm(): void {
  browser.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
}

browser.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void syncWithBadge();
});
browser.runtime.onStartup.addListener(ensureAlarm);
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void syncWithBadge();
});
browser.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "sync") {
    return syncWithBadge();
  }
  return undefined;
});

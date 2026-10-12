import { loadState } from "../storage";
import type { State, SyncCounts } from "../types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function render(state: State): void {
  const ls = state.lastSync;
  $("status").textContent = ls ? `Last sync: ${fmt(ls.at)}` : "Never synced";
  $("counts").textContent = ls
    ? `created ${ls.created} · updated ${ls.updated} · completed ${ls.completed} · failed ${ls.failed}`
    : "";
  const le = state.lastError;
  const stale = le && (!ls || le.at > ls.at);
  $("error").textContent = stale
    ? le.site === "other"
      ? `Error: ${le.message}`
      : `Signed out of ${le.site === "gradescope" ? "Gradescope" : "Canvas"}. Sign in and press Sync now.`
    : "";
}

async function refresh(): Promise<void> {
  render(await loadState());
}

$("sync").addEventListener("click", async () => {
  const btn = $("sync") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = (await browser.runtime.sendMessage({ type: "sync" })) as SyncCounts | { error: unknown } | { skipped: true };
    if ("skipped" in r) $("status").textContent = "A sync is already running";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync now";
    await refresh();
  }
});

$("options").addEventListener("click", (e) => {
  e.preventDefault();
  void browser.runtime.openOptionsPage();
});

void refresh();

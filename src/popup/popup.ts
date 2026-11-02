import { loadState } from "../storage";
import { requestHostAccess } from "../permissions";
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
  const le = state.lastError; // cleared at the start of every run, so present means "from the last run"
  $("error").textContent = le
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
  // Called synchronously inside the click handler so Firefox treats it as a user gesture.
  const access = requestHostAccess().catch(() => false);
  try {
    await access;
    const r = (await browser.runtime.sendMessage({ type: "sync" })) as SyncCounts | { error: unknown } | { skipped: true };
    if ("skipped" in r) $("status").textContent = "A sync is already running";
  } catch (e) {
    $("error").textContent = `Error: ${String((e as Error)?.message ?? e)}`;
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

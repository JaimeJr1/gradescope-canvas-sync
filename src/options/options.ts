import { loadState, saveMappings } from "../storage";
import type { State } from "../types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}

function render(state: State): void {
  const rows = $("rows");
  rows.textContent = "";
  const cache = state.cache;
  $("warnings").textContent = cache?.warnings.join(" · ") ?? "";
  if (!cache || cache.gsCourses.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.className = "muted";
    td.textContent = "No courses yet. Open the popup and press Sync now.";
    tr.append(td);
    rows.append(tr);
    return;
  }
  const byId = new Map(cache.canvasCourses.map((c) => [c.id, c]));
  for (const g of cache.gsCourses) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = `${g.shortName} — ${g.fullName}`;
    const cell = document.createElement("td");
    const sel = document.createElement("select");
    sel.dataset.gs = g.id;
    const override = g.id in state.mappings ? state.mappings[g.id] : undefined;
    const auto = cache.mapping[g.id];
    const autoLabel = auto !== null && auto !== undefined ? `Auto: ${byId.get(auto)?.course_code ?? auto}` : "Auto: no match";
    sel.append(option("auto", autoLabel, override === undefined));
    sel.append(option("none", "(none)", override === null));
    for (const c of cache.canvasCourses) {
      sel.append(option(String(c.id), `${c.course_code} — ${c.name}`, override === c.id));
    }
    cell.append(sel);
    tr.append(name, cell);
    rows.append(tr);
  }
}

async function save(): Promise<void> {
  const mappings: State["mappings"] = {};
  for (const sel of Array.from(document.querySelectorAll<HTMLSelectElement>("select[data-gs]"))) {
    const gsId = sel.dataset.gs!;
    if (sel.value === "auto") continue;
    mappings[gsId] = sel.value === "none" ? null : Number(sel.value);
  }
  await saveMappings(mappings); // own storage key: a sync running right now cannot overwrite it
  $("saved").textContent = "Saved. Takes effect on the next sync.";
}

$("save").addEventListener("click", () => void save());
void loadState().then(render);

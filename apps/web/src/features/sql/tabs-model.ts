import { z } from "zod";

export const MAX_TABS = 10;

export interface Tab {
  id: string;
  title: string;
  sql: string;
  database: string | null;
}

export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const tabSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  sql: z.string(),
  database: z.string().min(1).nullable(),
});

const storageKey = (target: string) => `dpilot.tabs.${target}`;

function nextTitle(existing: readonly Tab[]): string {
  const used = new Set(existing.map((tab) => tab.title));
  let n = 1;
  while (used.has(`Query ${n}`)) n += 1;
  return `Query ${n}`;
}

export function createTab(database: string | null, existing: readonly Tab[], sql = ""): Tab {
  return { id: crypto.randomUUID(), title: nextTitle(existing), sql, database };
}

/** Null at the limit, so the caller can say why nothing opened. */
export function addTab(tabs: readonly Tab[], tab: Tab): Tab[] | null {
  return tabs.length >= MAX_TABS ? null : [...tabs, tab];
}

/** The editor always has a tab: closing the last one leaves a blank one. */
export function closeTab(tabs: readonly Tab[], id: string): Tab[] {
  const rest = tabs.filter((tab) => tab.id !== id);
  return rest.length > 0 ? rest : [createTab(null, [])];
}

export function renameTab(tabs: readonly Tab[], id: string, title: string): Tab[] {
  const trimmed = title.trim();
  if (trimmed === "") return [...tabs];
  return tabs.map((tab) => (tab.id === id ? { ...tab, title: trimmed } : tab));
}

export function updateTab(
  tabs: readonly Tab[],
  id: string,
  patch: Partial<Pick<Tab, "sql" | "database">>,
): Tab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
}

function parseTabs(raw: string | null): Tab[] {
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = z.array(tabSchema).safeParse(json);
  return parsed.success ? parsed.data.slice(0, MAX_TABS) : [];
}

export function loadTabs(
  storage: TabStorage,
  target: string,
  fallbackDatabase: string | null,
): Tab[] {
  const stored = parseTabs(storage.getItem(storageKey(target)));
  return stored.length > 0 ? stored : [createTab(fallbackDatabase, [])];
}

/** False when the browser refused the write (private mode, full quota). */
export function saveTabs(storage: TabStorage, target: string, tabs: readonly Tab[]): boolean {
  try {
    storage.setItem(storageKey(target), JSON.stringify(tabs));
    return true;
  } catch {
    return false;
  }
}

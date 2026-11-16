import { describe, expect, test } from "bun:test";
import {
  addTab,
  closeTab,
  createTab,
  loadTabs,
  MAX_TABS,
  renameTab,
  saveTabs,
  type Tab,
  type TabStorage,
  updateTab,
} from "./tabs-model.ts";

function memoryStorage(initial: Record<string, string> = {}): TabStorage & {
  items: Map<string, string>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function tabs(count: number): Tab[] {
  const list: Tab[] = [];
  for (let i = 0; i < count; i += 1) list.push(createTab("shop", list));
  return list;
}

describe("tabs", () => {
  test("createTab picks the next unused title", () => {
    const [first, second] = tabs(2);
    expect(first?.title).toBe("Query 1");
    expect(second?.title).toBe("Query 2");
    const three = tabs(3);
    const gap = closeTab(three, three[0]?.id ?? "");
    expect(createTab(null, gap).title).toBe("Query 1");
  });

  test("addTab refuses an 11th tab", () => {
    const full = tabs(MAX_TABS);
    expect(addTab(full, createTab(null, full))).toBeNull();
    const nine = tabs(MAX_TABS - 1);
    expect(addTab(nine, createTab(null, nine))).toHaveLength(MAX_TABS);
  });

  test("closeTab keeps a blank tab when the last one closes", () => {
    const [only] = tabs(1);
    const rest = closeTab([only as Tab], only?.id ?? "");
    expect(rest).toHaveLength(1);
    expect(rest[0]?.id).not.toBe(only?.id);
    expect(rest[0]?.sql).toBe("");
  });

  test("renameTab trims and ignores a blank title", () => {
    const [tab] = tabs(1);
    const id = tab?.id ?? "";
    expect(renameTab([tab as Tab], id, "  Orders  ")[0]?.title).toBe("Orders");
    expect(renameTab([tab as Tab], id, "   ")[0]?.title).toBe("Query 1");
  });

  test("updateTab changes only the named tab", () => {
    const list = tabs(2);
    const next = updateTab(list, list[1]?.id ?? "", { sql: "SELECT 1", database: "x" });
    expect(next[0]).toEqual(list[0] as Tab);
    expect(next[1]).toMatchObject({ sql: "SELECT 1", database: "x" });
  });
});

describe("tab storage", () => {
  test("round-trips tabs per target", () => {
    const storage = memoryStorage();
    const two = tabs(2);
    const list = updateTab(two, two[0]?.id ?? "", { sql: "SELECT 1" });
    expect(saveTabs(storage, "c.one", list)).toBe(true);
    expect(loadTabs(storage, "c.one", null)).toEqual(list);
    expect(loadTabs(storage, "c.two", "shop")).toHaveLength(1);
  });

  test("falls back to one blank tab for damaged storage", () => {
    const storage = memoryStorage({ "dpilot.tabs.c.one": "{not json" });
    const loaded = loadTabs(storage, "c.one", "shop");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ sql: "", database: "shop" });
    storage.items.set("dpilot.tabs.c.one", JSON.stringify([{ id: 5 }]));
    expect(loadTabs(storage, "c.one", null)).toHaveLength(1);
  });

  test("keeps at most the tab limit", () => {
    const many = tabs(MAX_TABS + 3);
    const storage = memoryStorage({ "dpilot.tabs.c.one": JSON.stringify(many) });
    expect(loadTabs(storage, "c.one", null)).toHaveLength(MAX_TABS);
  });

  test("reports a save that the browser refused", () => {
    const refusing: TabStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    expect(saveTabs(refusing, "c.one", tabs(1))).toBe(false);
  });
});

import { expect, test } from "bun:test";
import { nextFocus, nodeId, type VisibleNode } from "./tree-model.ts";

// a (open) > a1, a2 (closed, expandable) ; b (closed, expandable) ; c (leaf)
const nodes: VisibleNode[] = [
  { id: "a", parent: null, expandable: true, expanded: true },
  { id: "a1", parent: "a", expandable: false, expanded: false },
  { id: "a2", parent: "a", expandable: true, expanded: false },
  { id: "b", parent: null, expandable: true, expanded: false },
  { id: "c", parent: null, expandable: false, expanded: false },
];

test("nodeId keeps names with dots and quotes distinct", () => {
  expect(nodeId(["a.b", "c"])).not.toBe(nodeId(["a", "b.c"]));
  const parts = ["s.x", 'we"ird db'];
  expect(JSON.parse(nodeId(parts))).toEqual(parts);
});

test("ArrowDown moves to the next visible node", () => {
  expect(nextFocus(nodes, "a", "ArrowDown")).toEqual({ focus: "a1", toggle: false });
  expect(nextFocus(nodes, "c", "ArrowDown")).toEqual({ focus: "c", toggle: false });
  expect(nextFocus(nodes, "b", "ArrowUp")).toEqual({ focus: "a2", toggle: false });
});

test("ArrowRight opens a collapsed node", () => {
  expect(nextFocus(nodes, "b", "ArrowRight")).toEqual({ focus: "b", toggle: true });
  expect(nextFocus(nodes, "c", "ArrowRight")).toEqual({ focus: "c", toggle: false });
});

test("ArrowRight on an open node moves to its first child", () => {
  expect(nextFocus(nodes, "a", "ArrowRight")).toEqual({ focus: "a1", toggle: false });
});

test("ArrowLeft on a closed node moves to its parent", () => {
  expect(nextFocus(nodes, "a2", "ArrowLeft")).toEqual({ focus: "a", toggle: false });
  expect(nextFocus(nodes, "a", "ArrowLeft")).toEqual({ focus: "a", toggle: true });
  expect(nextFocus(nodes, "b", "ArrowLeft")).toEqual({ focus: "b", toggle: false });
});

test("Home and End jump to the ends", () => {
  expect(nextFocus(nodes, "a2", "Home")).toEqual({ focus: "a", toggle: false });
  expect(nextFocus(nodes, "a2", "End")).toEqual({ focus: "c", toggle: false });
});

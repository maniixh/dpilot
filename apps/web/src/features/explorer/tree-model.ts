/** Stable tree ids: JSON keeps names with dots or quotes from colliding. */
export function nodeId(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export interface VisibleNode {
  id: string;
  parent: string | null;
  expandable: boolean;
  expanded: boolean;
}

export type TreeKey = "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Home" | "End";

export const TREE_KEYS: ReadonlySet<string> = new Set<TreeKey>([
  "ArrowDown",
  "ArrowUp",
  "ArrowRight",
  "ArrowLeft",
  "Home",
  "End",
]);

/** Focus movement for the WAI-ARIA tree pattern; `nodes` is the visible order. */
export function nextFocus(
  nodes: readonly VisibleNode[],
  current: string,
  key: TreeKey,
): { focus: string; toggle: boolean } {
  const index = nodes.findIndex((node) => node.id === current);
  const node = nodes[index];
  const stay = { focus: current, toggle: false };
  if (node === undefined) return stay;
  const at = (i: number) => nodes[Math.max(0, Math.min(nodes.length - 1, i))]?.id ?? current;

  switch (key) {
    case "ArrowDown":
      return { focus: at(index + 1), toggle: false };
    case "ArrowUp":
      return { focus: at(index - 1), toggle: false };
    case "Home":
      return { focus: at(0), toggle: false };
    case "End":
      return { focus: at(nodes.length - 1), toggle: false };
    case "ArrowRight": {
      if (!node.expandable) return stay;
      if (!node.expanded) return { focus: current, toggle: true };
      const child = nodes[index + 1];
      return child?.parent === current ? { focus: child.id, toggle: false } : stay;
    }
    case "ArrowLeft":
      if (node.expandable && node.expanded) return { focus: current, toggle: true };
      return node.parent === null ? stay : { focus: node.parent, toggle: false };
  }
}

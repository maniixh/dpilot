import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation } from "wouter";
import { nextFocus, TREE_KEYS, type TreeKey, type VisibleNode } from "./tree-model.ts";

interface TreeState {
  focused: string | null;
  setFocused(id: string): void;
  isExpanded(id: string): boolean;
  toggle(id: string): void;
}

const TreeContext = createContext<TreeState | null>(null);
const ParentContext = createContext<{ id: string | null; depth: number }>({ id: null, depth: 0 });

function useTree(): TreeState {
  const tree = useContext(TreeContext);
  if (tree === null) throw new Error("TreeNode must be rendered inside a Tree");
  return tree;
}

const ITEM = '[role="treeitem"]';

/** Reads the rendered, visible items in order; collapsed groups are not rendered at all. */
function visibleNodes(root: HTMLElement): {
  nodes: VisibleNode[];
  elements: Map<string, HTMLElement>;
} {
  const elements = new Map<string, HTMLElement>();
  const nodes: VisibleNode[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(ITEM)) {
    const id = element.dataset.nodeId;
    if (id === undefined) continue;
    elements.set(id, element);
    const expanded = element.getAttribute("aria-expanded");
    nodes.push({
      id,
      parent: element.dataset.parentId ?? null,
      expandable: expanded !== null,
      expanded: expanded === "true",
    });
  }
  return { nodes, elements };
}

/** A WAI-ARIA tree: roving tabindex, arrow keys, Home/End, Enter to open or toggle. */
export function Tree({ label, children }: { label: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    setFocused(id);
  }, []);

  const state = useMemo<TreeState>(
    () => ({ focused, setFocused, isExpanded: (id) => expanded.has(id), toggle }),
    [focused, expanded, toggle],
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!TREE_KEYS.has(event.key) || root.current === null) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM);
    const current = item?.dataset.nodeId;
    if (current === undefined) return;
    event.preventDefault();
    const { nodes, elements } = visibleNodes(root.current);
    const move = nextFocus(nodes, current, event.key as TreeKey);
    if (move.toggle) toggle(move.focus);
    setFocused(move.focus);
    elements.get(move.focus)?.focus();
  }

  return (
    <TreeContext.Provider value={state}>
      <div ref={root} role="tree" aria-label={label} onKeyDown={onKeyDown} className="text-sm">
        {children}
      </div>
    </TreeContext.Provider>
  );
}

export interface TreeNodeProps {
  id: string;
  label: ReactNode;
  /** Where Enter or a click on the label goes; rows without one toggle instead. */
  href?: string;
  expandable: boolean;
  /** Secondary text after the label, such as why a server can't be browsed. */
  hint?: ReactNode;
  /** Rendered only while expanded, so each level loads on expand. */
  children?: ReactNode;
  /** The first node of a tree takes the tab stop until another is focused. */
  first?: boolean;
}

export function TreeNode({ id, label, href, expandable, hint, children, first }: TreeNodeProps) {
  const tree = useTree();
  const parent = useContext(ParentContext);
  const [, navigate] = useLocation();
  const expanded = expandable && tree.isExpanded(id);
  const tabbable = tree.focused === null ? first === true : tree.focused === id;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || event.target !== event.currentTarget) return;
    event.preventDefault();
    if (href !== undefined) navigate(href);
    else if (expandable) tree.toggle(id);
  }

  const labelClass = "min-w-0 truncate py-1";
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      aria-level={parent.depth + 1}
      data-node-id={id}
      data-parent-id={parent.id ?? undefined}
      tabIndex={tabbable ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) tree.setFocused(id);
      }}
      onKeyDown={onKeyDown}
      className="outline-none"
    >
      <div
        className="tree-row flex items-baseline gap-1 rounded-sm pr-2 hover:bg-white/50"
        style={{ paddingLeft: `${parent.depth * 0.875}rem` }}
      >
        {expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => tree.toggle(id)}
            className="w-5 shrink-0 text-slate hover:text-ink"
          >
            <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>
              ›
            </span>
          </button>
        ) : (
          <span aria-hidden className="w-5 shrink-0" />
        )}
        {href !== undefined ? (
          <Link
            href={href}
            tabIndex={-1}
            onClick={() => tree.setFocused(id)}
            className={`${labelClass} hover:underline`}
          >
            {label}
          </Link>
        ) : expandable ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => tree.toggle(id)}
            className={`${labelClass} text-left`}
          >
            {label}
          </button>
        ) : (
          <span className={labelClass}>{label}</span>
        )}
        {hint !== undefined && <span className="ml-auto shrink-0 text-xs text-slate">{hint}</span>}
      </div>
      {expanded && (
        <ParentContext.Provider value={{ id, depth: parent.depth + 1 }}>
          {/* biome-ignore lint/a11y/useSemanticElements: a tree's group is not a form fieldset */}
          <div role="group">{children}</div>
        </ParentContext.Provider>
      )}
    </div>
  );
}

/** A level's loading or error line, with a retry for errors. */
export function TreeStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const parent = useContext(ParentContext);
  if (!loading && error === null) return null;
  return (
    <div
      role="none"
      className="py-1 pr-2 text-slate"
      style={{ paddingLeft: `${parent.depth * 0.875 + 1.5}rem` }}
    >
      {loading ? (
        "Loading…"
      ) : (
        <span role="alert" className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-down">{error}</span>
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Try again
          </button>
        </span>
      )}
    </div>
  );
}

/** Plain text for an empty level. */
export function TreeEmpty({ children }: { children: ReactNode }) {
  const parent = useContext(ParentContext);
  return (
    <div
      role="none"
      className="py-1 pr-2 text-slate"
      style={{ paddingLeft: `${parent.depth * 0.875 + 1.5}rem` }}
    >
      {children}
    </div>
  );
}

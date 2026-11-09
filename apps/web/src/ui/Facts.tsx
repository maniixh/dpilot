import type { ReactNode } from "react";

export function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="border-b border-rule pb-2 text-lg font-semibold">{title}</h2>
      <dl className="divide-y divide-rule">{children}</dl>
    </section>
  );
}

export function Fact({
  term,
  mono,
  action,
  children,
}: {
  term: string;
  mono?: boolean;
  /** Rendered after the value, e.g. a copy button. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
      <dt className="text-slate">{term}</dt>
      <dd className="flex min-w-0 items-baseline gap-3">
        <span className={mono ? "font-mono text-sm break-all" : "font-medium"}>{children}</span>
        {action}
      </dd>
    </div>
  );
}

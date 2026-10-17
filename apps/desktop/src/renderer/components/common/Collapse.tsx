import { useState, type ReactNode } from 'react';

export function Collapse({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="fd-collapse">
      <button
        type="button"
        className="fd-collapse__summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="fd-collapse__caret">{open ? '▾' : '▸'}</span>
        {summary}
      </button>
      {open && <div className="fd-collapse__content">{children}</div>}
    </div>
  );
}

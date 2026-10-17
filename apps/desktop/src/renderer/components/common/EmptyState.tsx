import type { ReactNode } from 'react';

export function EmptyState({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="fd-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 2.5 20.2 7v10L12 21.5 3.8 17V7L12 2.5Z"
          stroke="#f2a93b"
          strokeWidth="1.2"
          opacity="0.8"
        />
        <path d="M12 7v10M8 10.5h8" stroke="#37c5d8" strokeWidth="1.2" opacity="0.7" />
      </svg>
      <div className="fd-empty__title">{title}</div>
      {hint && <div className="fd-empty__hint">{hint}</div>}
      {actions && <div className="fd-empty__actions">{actions}</div>}
    </div>
  );
}

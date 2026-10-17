import type { ReactNode } from 'react';
import type { Tone } from '../../lib/labels';

export type { Tone } from '../../lib/labels';

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`fd-badge fd-badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** 状态徽标：圆点 + 文本；pulse 用于启动中/执行中 */
export function StatusChip({
  tone = 'neutral',
  pulse = false,
  title,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`fd-chip${pulse ? ' fd-chip--pulse' : ''}`} title={title}>
      <span className="fd-chip__dot" style={{ background: cssTone(tone) }} />
      {children}
    </span>
  );
}

const TONE_COLORS: Record<Tone, string> = {
  neutral: '#5d6f8a',
  ok: '#43d68c',
  warn: '#f2a93b',
  danger: '#ef5350',
  info: '#5aa2f0',
  accent: '#f2a93b',
  violet: '#9d7bff',
};

function cssTone(tone: Tone): string {
  return TONE_COLORS[tone];
}

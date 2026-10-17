/**
 * 本回合 token 用量小条：usage/updated 事件（thread/tokenUsage/updated 投影）驱动，
 * 无数据或 totalTokens=0 时不渲染。累计口径（线程累计，非单回合增量）。
 */
import type { TokenUsageSummary } from '../../contracts/engine';

export function fmtTokens(n: number): string {
  if (n >= 100000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function TokenUsageBar({ usage }: { usage: TokenUsageSummary }) {
  if (usage.totalTokens <= 0) return null;
  const parts = [`入 ${fmtTokens(usage.inputTokens)}`, `出 ${fmtTokens(usage.outputTokens)}`];
  if (usage.cachedInputTokens > 0) parts.push(`缓存 ${fmtTokens(usage.cachedInputTokens)}`);
  if (usage.reasoningOutputTokens > 0) parts.push(`思考 ${fmtTokens(usage.reasoningOutputTokens)}`);
  return (
    <div
      data-testid="token-usage-bar"
      style={{ margin: '8px 22px 0', fontSize: 11, color: 'var(--text-faint)' }}
    >
      本回合 Token：{parts.join(' · ')}
      {usage.modelContextWindow != null && usage.modelContextWindow > 0
        ? ` · 上下文窗口 ${fmtTokens(usage.modelContextWindow)}`
        : ''}
    </div>
  );
}

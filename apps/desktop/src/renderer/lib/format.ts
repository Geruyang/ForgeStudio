/**
 * 展示格式化工具（纯函数，供组件与测试共用）。
 */

/** 截断 SHA-256 之类的长摘要，保留可辨识前缀 */
export function shortSha(sha: string | undefined): string {
  if (!sha) return '—';
  return sha.length > 12 ? `${sha.slice(0, 10)}…${sha.slice(-4)}` : sha;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 时:分:秒（本地时区），无效时间返回占位符 */
export function formatClock(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 月-日 时:分，用于线程列表等 */
export function formatShortTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 运行时长（毫秒 → 可读），用于操作耗时与诊断 uptime */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

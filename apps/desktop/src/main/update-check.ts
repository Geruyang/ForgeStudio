/**
 * 更新检查（Z2C scaffold）：读取 updateFeedUrl 指向的 JSON 并与当前版本比对。
 * 仅"检查与告知"——不下载、不安装、不静默写盘；electron-updater 完整通道
 * （差分下载/签名校验/替换重启）待代码签名与更新服务器就绪后另行引入。
 * Feed 格式：{ "version": "0.1.1", "url": "https://…/ForgeStudio Setup.exe",
 *              "sha256": "…", "notes": "…" }
 */

export interface UpdateFeed {
  version: string;
  url: string;
  sha256?: string;
  notes?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  downloadUrl?: string;
  sha256?: string;
  notes?: string;
}

/** 语义化版本比较（x.y.z，容错预发布后缀按字典序）：a<b → -1，相等 → 0，a>b → 1 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}

/** 宽容解析 feed JSON（字段缺失/类型不符 → null，不虚报） */
export function parseUpdateFeed(raw: string): UpdateFeed | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o['version'] !== 'string' || typeof o['url'] !== 'string') return null;
  if (o['version'].length === 0 || o['url'].length === 0) return null;
  return {
    version: o['version'],
    url: o['url'],
    sha256: typeof o['sha256'] === 'string' ? o['sha256'] : undefined,
    notes: typeof o['notes'] === 'string' ? o['notes'] : undefined,
  };
}

/** 拉取并比对（fetch 注入可测） */
export async function checkForUpdate(
  currentVersion: string,
  feedUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}`);
  const feed = parseUpdateFeed(await res.text());
  if (!feed) throw new Error('更新源 JSON 格式不合法（需 version 与 url 字段）');
  const updateAvailable = compareVersions(currentVersion, feed.version) < 0;
  return {
    currentVersion,
    latestVersion: feed.version,
    updateAvailable,
    downloadUrl: updateAvailable ? feed.url : undefined,
    sha256: updateAvailable ? feed.sha256 : undefined,
    notes: updateAvailable ? feed.notes : undefined,
  };
}

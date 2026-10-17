// @vitest-environment node
// 更新检查（Z2C scaffold）单测：版本比较、feed 解析宽容性、fetch 注入的检查链路。
import { describe, expect, it } from 'vitest';
import { compareVersions, parseUpdateFeed, checkForUpdate } from '../update-check';

describe('compareVersions', () => {
  it('x.y.z 数值比较：小于/等于/大于', () => {
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });
  it('容错：v 前缀、预发布后缀、非数字段按 0', () => {
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0-beta.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.x.1', '0.0.1')).toBe(0);
  });
});

describe('parseUpdateFeed', () => {
  it('合法 feed → 解析（sha256/notes 可选）', () => {
    const feed = parseUpdateFeed('{"version":"0.1.1","url":"https://x/s.exe","sha256":"abc","notes":"修复"}');
    expect(feed).toMatchObject({ version: '0.1.1', url: 'https://x/s.exe', sha256: 'abc', notes: '修复' });
  });
  it('缺 version/url、坏 JSON、非对象 → null（不虚报）', () => {
    expect(parseUpdateFeed('{"url":"https://x"}')).toBeNull();
    expect(parseUpdateFeed('{"version":"","url":"https://x"}')).toBeNull();
    expect(parseUpdateFeed('not json')).toBeNull();
    expect(parseUpdateFeed('[1,2]')).toBeNull();
  });
});

describe('checkForUpdate（fetch 注入）', () => {
  const feed = (body: string, status = 200) =>
    (async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })) as unknown as typeof fetch;

  it('有新版本 → updateAvailable + 下载信息透传', async () => {
    const r = await checkForUpdate('0.1.0', 'https://feed', feed('{"version":"0.2.0","url":"https://d/s.exe","sha256":"abc","notes":"n"}'));
    expect(r.updateAvailable).toBe(true);
    expect(r.latestVersion).toBe('0.2.0');
    expect(r.downloadUrl).toBe('https://d/s.exe');
    expect(r.sha256).toBe('abc');
  });
  it('已是最新 → updateAvailable=false，不透传下载信息', async () => {
    const r = await checkForUpdate('0.3.0', 'https://feed', feed('{"version":"0.2.0","url":"https://d/s.exe"}'));
    expect(r.updateAvailable).toBe(false);
    expect(r.downloadUrl).toBeUndefined();
  });
  it('HTTP 非 2xx / 坏 feed → 抛错（明确失败，不静默）', async () => {
    await expect(checkForUpdate('0.1.0', 'https://feed', feed('{}', 500))).rejects.toThrow(/HTTP 500/);
    await expect(checkForUpdate('0.1.0', 'https://feed', feed('garbage'))).rejects.toThrow(/格式不合法/);
  });
});

/**
 * 差异渲染（纯函数）：把统一 diff 文本解析为文件/hunk/行结构，
 * 供 PatchCard 分块（分批）加载大差异。
 */
import { parsePatch } from 'diff';

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  fileName: string;
  hunks: DiffHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface ParsedFile {
  index?: string;
  oldFileName?: string;
  newFileName?: string;
  hunks: ParsedHunk[];
}

function parseHunk(hunk: ParsedHunk): DiffHunk {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const lines: DiffLine[] = [];
  for (const raw of hunk.lines) {
    if (raw.startsWith('+')) lines.push({ type: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ type: 'del', text: raw.slice(1) });
    else if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    else lines.push({ type: 'context', text: raw.slice(1) });
  }
  return { header, lines };
}

/**
 * 把统一 diff 文本转为结构化视图；不是合法 diff（或无 hunk 标记）返回 null，
 * 调用方回退为纯文本展示——不伪造解析结果。
 */
export function parseDiffText(text: string | undefined): DiffFile[] | null {
  if (!text || !text.includes('@@')) return null;
  let parsed: ParsedFile[];
  try {
    parsed = parsePatch(text) as ParsedFile[];
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const files: DiffFile[] = [];
  for (const f of parsed) {
    const hunks = (f.hunks ?? []).map(parseHunk);
    if (hunks.length === 0) continue;
    const fileName = f.newFileName ?? f.oldFileName ?? '(未命名)';
    files.push({ fileName: fileName.replace(/^a\//, '').replace(/^b\//, ''), hunks });
  }
  if (files.length === 0) return null;
  return files;
}

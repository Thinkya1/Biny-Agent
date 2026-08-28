/**
 * 记忆引用块的解析与剥离。
 *
 * 模型在回答末尾按协议附 `<memory-citations>` 块声明本回合实际使用了哪些记忆条目；
 * 回合结束时解析并回写使用统计，渲染层用同一解析器把块从正文剥离成角标。
 * 块本身保留在 session JSONL 中（append-only 审计不变），只有展示层会消费解析结果。
 */

const citationBlockPattern = /<memory-citations>\s*([\s\S]*?)\s*<\/memory-citations>/gu;
/** 条目行：id 与存储层 sanitizeIdentifier 同形（小写字母数字连字符，8–128 位），必须位于行首。 */
const citationLinePattern = /^-[ \t]*([a-z0-9][a-z0-9-]{7,127})[ \t]*(?:\|[ \t]*note=(.+))?$/u;

export interface MemoryCitation {
  /** 记忆条目 id；是否真实存在由调用方对照记忆库过滤。 */
  id: string;
  /** 可选的一句话用途说明。 */
  note?: string;
}

export interface ParsedMemoryCitations {
  citations: MemoryCitation[];
  /** 剥离引用块后的正文；没有块时与输入相同。 */
  textWithoutBlock: string;
}

/**
 * 解析并剥离最后一个引用块；容忍缺失、空块与畸形行（忽略而非报错），绝不影响回合主流程。
 * 行格式：`- <entry-id>[ | note=<一句话>]`。
 */
export function parseMemoryCitations(text: string): ParsedMemoryCitations {
  const matches = [...text.matchAll(citationBlockPattern)];
  if (!matches.length) return { citations: [], textWithoutBlock: text };
  const last = matches.at(-1);
  if (!last) return { citations: [], textWithoutBlock: text };
  const body = last[1] ?? "";
  const seen = new Set<string>();
  const citations: MemoryCitation[] = [];
  for (const rawLine of body.split("\n")) {
    const parsed = citationLinePattern.exec(rawLine.trim());
    if (!parsed?.[1]) continue;
    const id = parsed[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const note = parsed[2]?.trim();
    citations.push(note ? { id, note } : { id });
  }
  const start = last.index ?? 0;
  const textWithoutBlock = `${text.slice(0, start)}${text.slice(start + last[0].length)}`.trimEnd();
  return { citations, textWithoutBlock };
}

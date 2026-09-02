/**
 * Activity FTS 的文本预处理。
 *
 * 先把连续 CJK 文本交给 jieba 的精确模式，再把词之间用空格隔开交给
 * SQLite FTS5。这里所有写入、OCR 回写、旧库重建和查询都复用同一入口，避免
 * 新旧索引使用不同的分词规则。
 */
import { cut } from "jieba-wasm";

/** 与 activity FTS metadata version 对齐；修改分词逻辑时必须递增。 */
export const ACTIVITY_FTS_INDEX_VERSION = 6;

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/gu;

export function segmentActivityText(value: string | undefined): string {
  if (!value) return "";
  return value.replace(CJK_RUN, (run) => ` ${cut(run, true).join(" ")} `);
}

/** 构造安全的 FTS5 AND 前缀查询；每个 token 都在引号内，避免用户输入改变 MATCH 语法。 */
export function activityFtsMatch(query: string): string {
  return segmentActivityText(query)
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

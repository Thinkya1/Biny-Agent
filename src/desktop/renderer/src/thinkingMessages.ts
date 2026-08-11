/**
 * 思考状态文案表。
 *
 * 这些文案参考了 Claude Code 的 spinner verbs 以及社区整理版本，
 * 这里只维护产品实际展示的中文文案，不在运行时请求外部网站。
 */
export type ThinkingMessage = string;

export const THINKING_MESSAGES: readonly ThinkingMessage[] = [
  "推理中",
  "处理中",
  "计算中",
  "考虑中",
  "反思中",
  "斟酌中",
  "深思中",
  "反复思量",
  "遐想中",
  "正在处理",
  "处理中",
  "运算中",
  "酝酿中",
  "连接线索",
  "仔细琢磨",
  "沉浸思考",
  "嗯",
  "看看",
  "稍等",
  "等一下",
  "请稍候",
  "马上好",
  "工作中",
  "忙碌中",
  "嗡嗡运转",
  "搅动中",
  "渗透中",
  "慢炖中",
  "烹饪中",
  "烘焙中",
  "搅拌中",
  "启动中",
  "预热中",
  "加速中",
  "嗡嗡运转",
  "哼哼运转",
  "滴答滴答",
  "咔哒咔哒",
  "飞速运转",
  "疾驰中",
  "飞速中",
  "加速中",
  "前进中",
  "滚动中"
];

const FALLBACK_THINKING_MESSAGE: ThinkingMessage = "思考中";

export function pickThinkingMessage(): ThinkingMessage {
  const index = Math.floor(Math.random() * THINKING_MESSAGES.length);
  return THINKING_MESSAGES[index] ?? FALLBACK_THINKING_MESSAGE;
}

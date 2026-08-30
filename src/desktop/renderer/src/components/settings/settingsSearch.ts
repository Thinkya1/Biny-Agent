/**
 * 设置搜索的静态索引。
 *
 * 这里只收录分页名、分区标题和产品关键词，绝不接触表单值，因此 API Key、自定义指令和
 * 记忆正文不会意外进入搜索字符串或日志。
 */
import type { SettingsTab } from "./SettingsOverlay.js";

export interface SettingsSearchResult {
  tab: SettingsTab;
  sectionId: string;
  title: string;
  description: string;
  keywords: string[];
}

export const settingsSearchIndex: SettingsSearchResult[] = [
  { tab: "通用", sectionId: "appearance-theme", title: "显示模式", description: "浅色、深色与跟随系统", keywords: ["主题", "背景", "theme", "dark", "light"] },
  { tab: "通用", sectionId: "appearance-font", title: "界面字体", description: "字体与字号", keywords: ["字体", "字号", "font", "size"] },
  { tab: "通用", sectionId: "identity", title: "Agent 灵魂", description: "身份资料只读预览与提案审核", keywords: ["灵魂", "身份", "soul", "identity", "style", "user"] },
  { tab: "模型", sectionId: "models-connections", title: "模型连接", description: "供应商、服务地址与默认模型", keywords: ["模型", "供应商", "连接", "默认模型", "provider"] },
  { tab: "MCP 服务器", sectionId: "mcp-servers", title: "MCP 服务器", description: "市场、已安装服务与自定义连接", keywords: ["mcp", "服务器", "stdio", "remote", "sse", "http"] },
  { tab: "技能", sectionId: "settings-extensions-skills", title: "技能", description: "本机 Skill 列表与内容预览", keywords: ["skill", "技能", "agent", "自动提取"] },
  { tab: "插件", sectionId: "settings-extensions-plugins", title: "插件", description: "已配置的本地插件模块", keywords: ["plugin", "插件", "扩展", "模块"] },
  { tab: "活动记录", sectionId: "activity-overview", title: "活动记录器", description: "采集状态、权限、存储和本地隐私策略", keywords: ["activity", "recorder", "活动", "状态", "权限", "隐私"] },
  { tab: "活动记录", sectionId: "activity-capture", title: "采集参数", description: "快照防抖、心跳、空闲和 JPEG 质量", keywords: ["采集", "快照", "防抖", "心跳", "jpeg", "截图"] },
  { tab: "活动记录", sectionId: "activity-ocr", title: "OCR 与输入", description: "Vision OCR、语言和键盘鼠标活动", keywords: ["ocr", "vision", "输入", "键盘", "鼠标", "滚轮"] },
  { tab: "活动记录", sectionId: "activity-sensitive-apps", title: "敏感应用", description: "不保存文本和截图的 bundle ID 列表", keywords: ["敏感", "bundle", "应用", "屏蔽"] },
  { tab: "活动记录", sectionId: "activity-storage", title: "存储配置", description: "JPEG 容量上限与全局输出目录", keywords: ["存储", "目录", "jpeg", "fallback"] },
  { tab: "记忆", sectionId: "memory-overview", title: "记忆功能", description: "总开关与记忆范围", keywords: ["记忆", "启用", "memory"] },
  { tab: "记忆", sectionId: "memory-retrieval", title: "记忆召回", description: "每回合注入记忆概览，模型按需检索并标注引用", keywords: ["召回", "概览", "引用", "recall"] },
  { tab: "记忆", sectionId: "memory-features", title: "记忆生成", description: "自动生成与外部上下文", keywords: ["记忆", "生成", "外部上下文", "memory"] },
  { tab: "记忆", sectionId: "memory-evolution", title: "记忆进化", description: "长期策略、行为模式与策略偏差", keywords: ["长期策略", "目标", "原则", "行为模式", "偏差", "telos"] },
  { tab: "记忆", sectionId: "memory-models", title: "记忆处理模型", description: "主模型与高级覆盖", keywords: ["提取", "整理", "rewrite", "model"] },
  { tab: "记忆", sectionId: "memory-statistics", title: "记忆统计", description: "自动与手动记忆数量", keywords: ["统计", "数量", "自动", "手动"] },
  { tab: "记忆", sectionId: "memory-library", title: "记忆库", description: "添加、来源筛选与整理", keywords: ["来源", "项目", "偏好", "编辑", "清空"] },
  { tab: "记忆", sectionId: "memory-search", title: "搜索记忆", description: "关键词和路径搜索", keywords: ["搜索", "关键词", "路径"] },
  { tab: "联网搜索", sectionId: "web-search-provider", title: "搜索服务", description: "搜索提供方与结果设置", keywords: ["联网", "搜索", "网页", "provider"] },
  { tab: "聊天", sectionId: "chat-params-temperature", title: "温度", description: "采样温度，越低越确定、越高越发散", keywords: ["温度", "采样", "temperature", "聊天参数"] },
  { tab: "聊天", sectionId: "chat-params-max-tokens", title: "最大令牌数", description: "单次回复的最大输出 token 数", keywords: ["令牌", "输出", "max tokens", "token"] },
  { tab: "聊天", sectionId: "compaction-enable", title: "自动压缩", description: "启用开关与触发阈值", keywords: ["压缩", "上下文", "阈值", "compaction", "context"] },
  { tab: "聊天", sectionId: "compaction-keep", title: "保留策略", description: "保留最近消息条数与 token 上限", keywords: ["保留", "条数", "keep", "recent"] },
  { tab: "聊天", sectionId: "compaction-model", title: "压缩模型", description: "生成压缩摘要所用的模型", keywords: ["摘要", "模型", "summary", "model"] },
  { tab: "快速对话", sectionId: "quickchat-shortcut", title: "全局快捷键", description: "唤醒或收起 QuickChat 悬浮窗", keywords: ["快速对话", "quickchat", "快捷键", "悬浮窗", "shortcut"] },
  { tab: "快速对话", sectionId: "quickchat-behavior", title: "悬浮窗行为", description: "失焦隐藏、屏幕上下文注入与点击穿透", keywords: ["快速对话", "quickchat", "失焦", "屏幕上下文", "穿透", "悬浮窗"] },
  { tab: "联网搜索", sectionId: "web-search-cookies", title: "浏览器数据", description: "Cookie 导入、导出和清理", keywords: ["cookie", "浏览器", "导入", "导出"] },
  { tab: "关于", sectionId: "about-product", title: "关于 Biny", description: "版本与产品信息", keywords: ["版本", "about", "version"] }
];

export function searchSettings(query: string): SettingsSearchResult[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  return settingsSearchIndex.filter((item) => {
    const text = [item.tab, item.title, item.description, ...item.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

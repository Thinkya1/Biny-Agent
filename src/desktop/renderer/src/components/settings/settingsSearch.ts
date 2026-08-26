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
  { tab: "外观", sectionId: "appearance-theme", title: "显示模式", description: "浅色、深色与跟随系统", keywords: ["主题", "theme", "dark", "light"] },
  { tab: "外观", sectionId: "appearance-font", title: "界面字体", description: "字体与字号", keywords: ["字体", "字号", "font", "size"] },
  { tab: "个性化", sectionId: "personalization-global", title: "全局个性化", description: "人格与自定义指令", keywords: ["人格", "指令", "personality", "instructions"] },
  { tab: "个性化", sectionId: "personalization-chat", title: "当前聊天", description: "聊天级覆盖", keywords: ["聊天", "覆盖", "inherit"] },
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
  { tab: "记忆", sectionId: "memory-retrieval", title: "记忆检索", description: "查询重写、召回数与阈值", keywords: ["查询重写", "阈值", "召回", "相似度"] },
  { tab: "记忆", sectionId: "memory-features", title: "记忆生成", description: "自动生成与外部上下文", keywords: ["记忆", "生成", "外部上下文", "memory"] },
  { tab: "记忆", sectionId: "memory-evolution", title: "记忆进化", description: "长期策略、行为模式与策略偏差", keywords: ["长期策略", "目标", "原则", "行为模式", "偏差", "telos"] },
  { tab: "记忆", sectionId: "memory-models", title: "记忆处理模型", description: "主模型与高级覆盖", keywords: ["提取", "整理", "rewrite", "model"] },
  { tab: "记忆", sectionId: "memory-embedding", title: "Embedding 模型", description: "本地下载、云端隐私与索引", keywords: ["embedding", "向量", "下载", "索引", "隐私"] },
  { tab: "记忆", sectionId: "memory-statistics", title: "记忆统计", description: "自动与手动记忆数量", keywords: ["统计", "数量", "自动", "手动"] },
  { tab: "记忆", sectionId: "memory-library", title: "记忆库", description: "添加、来源筛选与整理", keywords: ["来源", "项目", "偏好", "编辑", "清空"] },
  { tab: "记忆", sectionId: "memory-search", title: "搜索记忆", description: "语义、关键词和路径搜索", keywords: ["搜索", "语义", "关键词", "路径"] },
  { tab: "联网搜索", sectionId: "web-search-provider", title: "搜索服务", description: "搜索提供方与结果设置", keywords: ["联网", "搜索", "网页", "provider"] },
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

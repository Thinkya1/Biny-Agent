/**
 * QuickChat 悬浮窗渲染进程入口。
 *
 * 只负责挂载 `QuickChatApp` 并加载共享样式层 + 悬浮窗自己的皮肤；不含业务逻辑。
 * 复用桌面端同一套 cascade layers 与主题变量，保证观感与主窗口一致。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QuickChatApp } from "./QuickChatApp.js";
import "../styles/layers.css";
import "./quickchat.css";

document.documentElement.dataset.platform = navigator.userAgent.includes("Mac OS") ? "darwin" : "other";
// 悬浮窗固定深色：半透明玻璃底在浅色下可读性差，且与主窗口深色基底保持一致。
document.documentElement.dataset.theme = "dark";

const root = document.getElementById("root");
if (!root) throw new Error("QuickChat renderer root is missing.");

createRoot(root).render(
  <StrictMode>
    <QuickChatApp />
  </StrictMode>
);

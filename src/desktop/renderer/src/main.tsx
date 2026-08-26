/**
 * 渲染进程入口。
 *
 * 只做挂载：找到 root 节点并渲染 `App`，不放任何业务逻辑。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/layers.css";

// 样式表按平台分叉（macOS 玻璃侧栏），挂载前先把平台标到根节点上。
document.documentElement.dataset.platform = navigator.userAgent.includes("Mac OS") ? "darwin" : "other";

const root = document.getElementById("root");
if (!root) throw new Error("Biny renderer root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

/**
 * Runtime Host 公共入口。
 *
 * 实现按职责位于 `runtime/host/`：协议、凭据、生命周期、业务组合、Server 和 Client 各自维护。
 * 旧调用方继续从这里导入，避免把应用入口和内部拆分绑定在一起。
 */
export * from "./host/index.js";

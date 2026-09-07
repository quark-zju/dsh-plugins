/**
 * dsh-web-notification —— 插件入口（Node 端）
 * 不包含任何宿主端逻辑，仅为 loader 提供入口（与官方 @deepseek-ai/dsh-client-notification 一致）。
 * 全部逻辑在客户端插件（./client）：监听会话 snapshot 检测回复完成并弹系统通知。
 */
export function apply() {}

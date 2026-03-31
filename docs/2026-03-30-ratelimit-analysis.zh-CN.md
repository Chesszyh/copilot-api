# GitHub Copilot API 429 (Too Many Requests) 深度分析报告

**日期**：2026-03-30  
**分析对象**：GitHub Copilot `/responses` 接口限流问题  
**涉及计划**：COPILOT_PLAN_INDIVIDUAL_EDU (个人/学生版)

## 1. 现象描述
在使用本项目反代 Copilot 给 Claude Code 使用时，高强度使用约 1 小时后，频繁出现 HTTP 429 错误。
- **错误代码**：`user_global_rate_limited:edu`
- **限流详情**：`x-ratelimit-exceeded: global-chat:global-user-tps-high-2025-04-08:userID:COPILOT_PLAN_INDIVIDUAL_EDU`
- **重试建议**：`retry-after: 2` (秒)

## 2. 核心原因分析

### 2.1 接口类型敏感度
本项目目前将符合条件的请求路由到 GitHub 的内部接口 `/responses`。该接口功能强大（支持推理、分相输出、上下文压缩），但 GitHub 对其 TPS（每秒并发数）的审计非常严格。相比之下，传统的 `/v1/chat/completions` 或标准的 `/v1/messages` 接口通常有更高的宽容度。

### 2.2 Intent 标识不一致
目前 `/responses` 请求固定携带 `openai-intent: conversation-agent`。
- **原生行为**：VS Code 在执行密集型编辑任务时，往往会切换到 `conversation-edits`。
- **风险**：GitHub 可能会对不同的意图（Intent）实施分级限流。`conversation-agent` 可能被视为普通聊天，限制更严；而 `conversation-edits` 可能拥有更高的突发配额。

### 2.3 密集型任务负载
Claude Code 会产生大量辅助请求：
- **Warmup (预热)**：检测模型可用性。
- **Compact (压缩)**：摘要超长对话。
- **Tool Invocations**：频繁的工具调用确认。
这些请求在本项目中如果都被路由到高级接口，会迅速耗尽 TPS 计数器。

## 3. 解决方案建议 (只读分析)

### 3.1 增加接口回退机制 (建议)
在 `config.json` 中增加 `useResponsesApi` 开关。当用户遇到 429 时，可以手动关闭该接口，强制项目回退到 `/v1/chat/completions` 或 `/v1/messages`。虽然会丢失部分高级功能（如 Reasoning 块的精准解析），但能保证可用性。

### 3.2 动态 Intent 调整
根据请求的内容或来源（如是否包含文件编辑指令），动态将 `openai-intent` 调整为 `conversation-edits`，以模拟 VS Code 原生行为。

### 3.3 强制小模型路由
进一步优化 `handleCompletion` 中的逻辑。目前虽然有针对 `isCompact` 的小模型转换，但可以考虑对所有非核心逻辑（如单纯的文本确认）强制使用 `gpt-5-mini` 等小模型，并走最基础的 API 路径。

### 3.4 客户端节流
如果服务端无法避免限流，建议在客户端（Claude Code 或其配置文件）中增加请求频率限制，或者在本项目中实现一个微型的请求队列（基于 `retry-after` 自动重试）。

## 4. 结论
目前的 429 报错主要是由于 GitHub 后端对 `/responses` 接口的高频审计触发的。在不改动代码的前提下，建议用户：
1. **降低并发**：减少 Claude Code 的并发任务。
2. **等待恢复**：GitHub 的 TPS 限制通常是滑动窗口，等待数分钟通常可恢复。
3. **环境切换**：如果可能，尝试使用非 EDU 计划的账号，其配额通常更高。

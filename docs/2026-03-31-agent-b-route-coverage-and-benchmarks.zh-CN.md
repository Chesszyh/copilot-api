# Agent B 开发文档：路由覆盖、链路回归与性能基准

## 1. 目标

本 agent 负责保证 observability 在三条主要代理链路上的覆盖一致，并给出性能验收依据。

本阶段必须完成：

- 确认并补齐 `chat.completions` observability 接入
- 做主链路回归验证
- 输出 benchmark 文档

## 2. 非目标

本 agent 不负责：

- 规则型质量信号设计
- `analysis_fact` schema 设计
- viewer 页面重构
- mock 生成器增强

## 3. 文件 ownership

本 agent 拥有以下主文件的最终集成权：

- `src/routes/chat-completions/handler.ts`
- `src/lib/observability/capture.ts`
- `tests/create-chat-completions.test.ts`
- `docs/observability-benchmarks.md`

允许配套修改但应最小化的文件：

- `tests/observability/*.test.ts`
- `src/routes/messages/handler.ts`
- `src/routes/responses/handler.ts`

如果修改了后两者，必须是为了统一 capture 行为，而不是顺手重构。

## 4. 建议工作树与分支

- worktree 目录：`.worktrees/agent-b-route-coverage`
- 分支名：`feat/observability-agent-b-route-coverage`

## 5. 需求拆解

### 5.1 路由覆盖确认

确认以下路由的 observability 生命周期是否一致：

- `messages`
- `responses`
- `chat.completions`

重点检查：

- 请求开始是否记录
- 流式响应是否在结束时补齐
- 错误路径是否落事件
- usage / token / timing 字段是否一致

### 5.2 回归验证

至少覆盖：

- stream
- non-stream
- error path
- mock/debug 开关不影响主链

### 5.3 benchmark 文档

文档中至少包含：

- 测试环境说明
- 开关关闭与开启的对比方法
- 推荐压测命令
- 结果记录模板
- dropped events / backlog / RSS / p50/p95/p99 记录项

## 6. 实施步骤

1. 审视三条 handler 的 capture 接入差异
2. 补齐 `chat-completions` 缺口
3. 统一错误和流结束路径
4. 补针对性测试
5. 形成 benchmark 文档

## 7. 设计约束

- 不得引入同步重处理
- 不得在 chunk 级路径上增加重计算
- 不得为了 benchmark 改写业务逻辑
- 如需共享字段，优先兼容 Agent A 的 schema

## 8. 测试要求

至少运行：

```bash
bun test tests/create-chat-completions.test.ts tests/responses-translation.test.ts tests/responses-stream-translation.test.ts tests/anthropic-request.test.ts tests/anthropic-response.test.ts
bun run lint
bun run typecheck
```

如新增 observability 针对性测试，应一并运行。

## 9. 交付格式

交付时必须说明：

- `chat.completions` 接入前后差异
- 是否改动共享 capture 接口
- benchmark 文档路径
- 采用了哪些验证命令

## 10. 与其他 agent 的协作规则

- 如果 Agent A 已冻结 schema，不要擅自变更类型定义
- 不要改 `pages/observability-viewer.html`
- benchmark 结果最好在 Agent A 合入后再复测一轮

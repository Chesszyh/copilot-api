# Agent C 开发文档：文档同步与 Viewer 轻量增强

## 执行状态

- 状态：已完成并合并到主分支 `all`
- 合并提交：`5fcd41f`
- 交付摘要：
  - README observability 章节同步
  - 用户手册同步
  - viewer 增加 session 搜索、状态/来源过滤、request 快速跳转
  - `tests/observability/viewer-route.test.ts` 断言更新

## 1. 目标

本 agent 负责把当前已实现的 observability 能力整理成可用文档，并对 viewer 做不影响后端协议的轻量增强。

本阶段必须完成：

- 同步 README 与中文用户手册
- 校正文档中已过时的描述
- 在不改 schema 的前提下做 viewer 轻量增强

## 2. 非目标

本 agent 不负责：

- `analysis_fact` 设计
- 质量信号计算
- `chat.completions` capture 主链修复
- 新增前端构建系统

## 3. 文件 ownership

本 agent 拥有以下主文件的最终集成权：

- `README.md`
- `docs/2026-03-30-agent-observability-user-manual.zh-CN.md`
- `pages/observability-viewer.html`
- `tests/observability/viewer-route.test.ts`

可参考但默认不修改：

- `docs/2026-03-31-agent-observability-status-and-next-plan.zh-CN.md`
- `src/routes/observability/viewer-route.ts`

## 4. 建议工作树与分支

- worktree 目录：`.worktrees/agent-c-docs-viewer`
- 分支名：`feat/observability-agent-c-docs-viewer`

## 5. 需求拆解

### 5.1 README 同步

至少补齐：

- observability 启用方式
- `/observability-viewer`
- mock 调试开关与接口
- 数据目录
- raw / pinned / retention 基本说明

### 5.2 用户手册同步

重点确保：

- 与当前实现一致
- 不再出现“没有独立 viewer”之类过时描述
- mock 调试和 JSON 阅读能力写清楚

### 5.3 viewer 轻量增强

允许的增强：

- session 筛选
- 状态过滤
- request 导航可读性增强
- 只读展示层体验提升

不允许的增强：

- 修改后端 schema
- 引入框架或构建系统
- 抢先消费 Agent A 尚未稳定的字段

## 6. 实施步骤

1. 盘点 README 与手册中的过时内容
2. 先更新文档
3. 再做 viewer 轻量增强
4. 补最小测试或页面断言

## 7. 设计约束

- 页面必须继续保持纯静态 HTML/JS 方案
- 不要把 viewer 做成复杂前端项目
- 所有增强都应以当前现有 API 为基础

## 8. 测试要求

至少运行：

```bash
bun test tests/observability/viewer-route.test.ts
bun run lint
bun run typecheck
```

如果 README 或 docs-only 变更多于页面改动，可在交付中说明代码测试范围未受影响。

## 9. 交付格式

交付时必须说明：

- 更新了哪些文档
- viewer 做了哪些轻量增强
- 是否依赖 Agent A 的新字段
- 运行了哪些验证命令

## 10. 与其他 agent 的协作规则

- 默认只消费已存在字段
- 如果必须展示 Agent A 新增字段，等其字段冻结后再接入
- 不要修改 `src/lib/observability/storage.ts`、`types.ts`、`worker.ts`

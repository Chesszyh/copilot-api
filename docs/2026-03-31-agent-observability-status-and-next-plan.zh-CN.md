# Agent 可观测性当前状态报告与下一阶段计划

## 1. 文档基线

本报告基于以下文档与当前代码状态整理：

- `docs/2026-03-30-agent-observability-design.zh-CN.md`
- `docs/2026-03-30-agent-observability-mvp-plan.zh-CN.md`
- `docs/2026-03-30-agent-observability-user-manual.zh-CN.md`
- `docs/2026-03-30-observability-viewer-and-mock-design.zh-CN.md`

## 2. 当前状态

### 2.1 已完成

当前已经完成并可用的部分包括：

- observability 配置与路径初始化
- capture / queue / worker / storage / redact / session 等核心后端骨架
- `messages` 与 `responses` 主链路的 observability 接入
- SQLite 结构化事件存储
- `raw/` 与 `pinned/` 文件留存
- `pin / unpin`
- `/observability/summary`
- `/observability/sessions`
- `/observability/sessions/:sessionId`
- `/observability/pin/:sessionId`
- 独立页面 `/observability-viewer`
- `debugMockEnabled` 开关
- `/observability/mock/generate`
- `/observability/mock/reset`
- mock 数据生成与独立清理
- viewer JSON 下载、复制、文件路径展示
- viewer 默认 JSON 源码视图
- viewer session 搜索、状态/来源过滤、request 快速跳转
- `analysis_fact` 落库与读取
- `analysis_fact` 聚合查询接口（`/observability/analysis`）
- `tool_event` 落库与读取（session 详情内返回）
- 4 个规则型质量信号：
  - `retry_after_answer`
  - `user_correction_signal`
  - `redundant_tool_signal`
  - `high_reasoning_low_outcome_signal`
- `chat.completions` 路由 observability 接入
- worker 自动提取工具调用事件（OpenAI/Anthropic 常见 JSON 结构）
- `docs/observability-benchmarks.md`

### 2.2 已合并提交（主分支 `all`）

本轮并行开发结果已合并到主分支，关键提交如下：

- `05674aa` `feat: add chat completions observability coverage`
- `1bfccc6` `feat: add observability analysis facts`
- `5fcd41f` `docs: refresh observability viewer guidance`

### 2.3 已完成但文档此前滞后

此前用户手册仍把系统描述为“只有 API，没有独立页面”，该描述现在已经过时。当前状态应以以下能力为准：

- 已存在独立的 observability viewer 页面
- 已存在 mock 调试入口
- 已支持较完善的 JSON 阅读体验

### 2.4 部分完成

以下部分已经具备基础，但尚未达到设计文档中的分析目标：

- 会话行为分析
  - 已有基础 summary 和 session 详情
  - 但还缺少更丰富的聚合与筛选
- Prompt / Agent 质量分析
  - 已具备 request/session 事实数据
  - 但规则型质量信号仍未落地

## 3. 尚未完成的 TODO

当前剩余的主要 TODO 只有 benchmark 实测结果归档。

### 3.1 benchmark 实测结果归档

`docs/observability-benchmarks.md` 已补齐方法和模板，但还缺真实环境的 off/on 压测结果表。

待补数据：

- p50/p95/p99
- RPS
- RSS
- queue backlog 峰值
- dropped events

已完成的工程收尾：

- `.claude/**` 已加入 eslint ignore
- `.claude/` 已加入 `.gitignore`

## 4. 不属于当前 TODO 的事项

以下内容虽然在设计里出现过，但属于明确延期或下一阶段范围，不应混入当前收尾 TODO：

- `turn` 实体
- 多用户面板
- OTel / Langfuse / Phoenix 导出兼容
- 黑盒质量评分
- 复杂 dashboard 筛选系统

## 5. 下一阶段建议目标

下一阶段只建议聚焦压测结果落地：

1. 填充 benchmark 实测结果（off / on 对照）
2. 固化执行脚本与采样窗口
3. 将结果同步到 `docs/observability-benchmarks.md`

## 6. 本轮并行执行结果

本轮按 3 个 agent 拆分执行，且均已完成并合并。

### Agent A: 质量信号与派生事实核心

完成项：

- 4 个规则型质量信号
- `analysis_fact` 存储与读取
- `session detail` 中暴露 `analysisFacts`
- 新增 `tests/observability/worker.test.ts`

详细开发文档：

- `docs/2026-03-31-agent-a-quality-signals-and-analysis-fact.zh-CN.md`

### Agent B: 路由覆盖、链路回归与性能基准

完成项：

- `chat.completions` 接入 observability capture
- 新增 `tests/observability/chat-completions-route.test.ts`
- 新增 `docs/observability-benchmarks.md`

详细开发文档：

- `docs/2026-03-31-agent-b-route-coverage-and-benchmarks.zh-CN.md`

### Agent C: 文档同步与 viewer 轻量增强

完成项：

- README observability 章节同步
- 用户手册同步
- viewer session 搜索 / 状态过滤 / 来源过滤 / request 跳转
- viewer route 测试更新

详细开发文档：

- `docs/2026-03-31-agent-c-docs-and-viewer-polish.zh-CN.md`

## 7. 下一轮并行建议（可选）

若继续并行开发，建议改成 2 路：

1. Agent X：`tool_event` + `analysis_fact` 聚合查询
2. Agent Y：benchmark 实测结果 + `.claude/` lint 收尾

## 9. 当前结论

当前 observability 计划已完成 A/B/C 三个并行任务并合并到主分支，且后续收尾已补上：

- `tool_event` 存储与会话读取
- `analysis_fact` 聚合读视图
- `.claude` lint 工作区治理

当前系统处于“可用 + 可分析”状态。下一阶段主要是补齐真实性能基准数据。

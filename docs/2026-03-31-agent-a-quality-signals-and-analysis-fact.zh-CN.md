# Agent A 开发文档：质量信号与派生事实核心

## 执行状态

- 状态：已完成并合并到主分支 `all`
- 合并提交：`1bfccc6`
- 交付摘要：
  - 落地 4 个规则型质量信号
  - 落地 `analysis_fact` 存储与读取
  - 在 session 详情返回中加入 `analysisFacts`
  - 新增 `tests/observability/worker.test.ts`

## 1. 目标

本 agent 负责把当前 observability 系统从“能记录事实”推进到“能产出最小质量诊断”。

本阶段必须完成：

- 落地最小规则型质量信号
- 设计并实现 `analysis_fact`
- 提供最小读取接口或复用现有读取接口暴露派生结果

## 2. 非目标

本 agent 不负责：

- viewer 页面大改
- README 与用户手册更新
- benchmark 结果记录
- 多用户设计
- 黑盒模型评分

## 3. 文件 ownership

本 agent 拥有以下主文件的最终集成权：

- `src/lib/observability/worker.ts`
- `src/lib/observability/storage.ts`
- `src/lib/observability/types.ts`
- `tests/observability/storage.test.ts`
- `tests/observability/routes.test.ts`

允许只读参考但默认不修改的文件：

- `src/routes/observability/summary-route.ts`
- `src/routes/observability/sessions-route.ts`
- `src/lib/observability/session.ts`

如果必须改动以上“允许只读参考”文件，应尽量保持接口兼容，并在交接说明里明确写出。

## 4. 建议工作树与分支

- worktree 目录：`.worktrees/agent-a-quality-signals`
- 分支名：`feat/observability-agent-a-quality-signals`

## 5. 需求拆解

### 5.1 必做质量信号

第一批建议至少实现以下 4 个：

- `retry_after_answer`
- `user_correction_signal`
- `redundant_tool_signal`
- `high_reasoning_low_outcome_signal`

要求：

- 规则必须可解释
- 规则输入只依赖当前已采集数据，避免引入额外上游依赖
- 每个信号都要在代码里有清晰字段定义

### 5.2 `analysis_fact`

建议最小字段：

- `sessionId`
- `requestId`
- `factType`
- `factValue`
- `factScore`
- `source`
- `createdAt`

要求：

- 可扩展
- 支持后续新增信号
- 不要设计成强耦合单表列爆炸

### 5.3 读取视图

至少满足一种：

- 在现有 session 详情返回中附带 `analysisFacts`
- 或新增最小只读路由

优先建议复用现有详情路由，减少前后端变更面。

## 6. 实施步骤

1. 先审视当前 `types.ts` 与 `storage.ts` 的持久化边界
2. 设计 `analysis_fact` 的类型与存储结构
3. 在 `worker.ts` 中增加规则计算入口
4. 增加事实写入逻辑
5. 补读取逻辑
6. 补测试

## 7. 设计约束

- 不得引入复杂规则引擎
- 不得为了信号计算阻塞主链
- 不得修改 viewer 协议，除非确有必要
- 优先保持向后兼容

## 8. 测试要求

至少运行：

```bash
bun test tests/observability/storage.test.ts tests/observability/routes.test.ts
bun run lint
bun run typecheck
```

如新增专门测试，应一并运行。

## 9. 交付格式

交付时必须说明：

- 新增了哪些质量信号
- 每个信号的触发规则
- `analysis_fact` 的 schema 设计
- 是否改动了现有 API 响应结构
- 运行了哪些测试

## 10. 与其他 agent 的协作规则

- Agent B 与 Agent C 读取 schema 时，以本 agent 最终定义为准
- 如需共享字段，请先在提交说明中稳定字段名
- 不要改 `pages/observability-viewer.html`

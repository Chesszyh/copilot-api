# Observability Viewer 与 Mock 调试设计

## 目标

新增一个独立的 observability 页面，用来查看本地代理采集到的会话、请求、原文引用和 pin 状态，并在调试模式下提供 mock 数据生成入口。

## 范围

- 新增独立页面 `/observability-viewer`
- 兼容 `/observability-viewer/` -> `301` 重定向
- 页面读取本地 observability 的 summary、sessions、detail、pin 接口
- `debugMockEnabled` 打开时显示 mock 调试区入口
- 使用 `Fira Code` + `Fira Sans`，蓝色和琥珀色作为主视觉
- 支持键盘可访问与 `prefers-reduced-motion`

## 交互结构

- 顶部概览卡片
  - session 总数
  - request 总数
  - 失败 request 数
  - pinned session 数
- 左侧 session 列表
  - 支持刷新
  - 支持选择单条 session 查看详情
- 右侧 session 详情
  - 展示 session 元信息
  - 展示 request 时间线和关键字段
  - 支持 pin / unpin
- 调试区
  - 仅在 `debugMockEnabled` 为 true 时显示
  - 预留 mock 生成与 reset 入口

## 数据源

页面只消费本地 observability API，不直接请求 GitHub Copilot。

- `GET /observability/summary`
- `GET /observability/analysis`
- `GET /observability/sessions`
- `GET /observability/sessions/:sessionId`
- `POST /observability/pin/:sessionId`
- `DELETE /observability/pin/:sessionId`

## 配置注入

服务端在渲染页面时注入最小配置对象：

```json
{
  "debugMockEnabled": false
}
```

页面启动后读取该配置来决定是否显示 mock 调试区。

## 验收标准

- `/observability-viewer` 能正常打开
- `/observability-viewer/` 重定向到规范地址
- 页面可以加载 summary 和 session 列表
- 点击 session 能加载详情
- pin / unpin 走本地 observability API
- `debugMockEnabled` 为 true 时页面显示 mock 调试入口
- 页面支持 reduced motion 与可见 focus 样式

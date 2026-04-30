# AI-PRD-Studio 技术全景报告（交接蓝图）

本文档面向下一任高级 Agent，目标是在最短时间内无缝接管当前项目。

---

## 0. 项目当前架构快照

- 前端主入口：`src/app/page.tsx`
- 关键渲染组件：`src/components/prd/prd-markdown.tsx`
- 后端 API：
  - `src/app/api/inspect/route.ts`：上传数据质检与字段映射
  - `src/app/api/analyze/route.ts`：洞察提炼（Top 3）
  - `src/app/api/generate-prd/route.ts`：PRD 流式生成 / 采纳建议重写
  - `src/app/api/critic/route.ts`：双轨并发审查（Challenger vs Champion）
- Markdown 辅助工具：
  - `src/lib/markdown/headings.ts`：统一 slug 与目录提取
  - `src/lib/markdown/prose.ts`：PRD 排版 class 集合
- 指标持久化：
  - `src/hooks/use-dashboard-metrics.ts`（`localStorage`）

---

## 1. 双轨并行博弈架构（Critic Dual-Track）

### 1.1 并发赛跑实现

核心位于 `src/app/api/critic/route.ts`：

- 使用 `Promise.allSettled([runTrackA(payload), runTrackB(payload)])` 并发执行两条审查轨道。
- 两轨都执行完后再统一仲裁，同时保证归档完整（不因任一轨失败而中断）。

### 1.2 30s 级别超时机制（当前为 28s）

Track A（RAG Challenger）中实现：

- `const controller = new AbortController()`
- `const timeout = setTimeout(() => controller.abort("Track A timeout"), 28_000)`
- Tavily 请求与模型请求均绑定 `signal: controller.signal`
- `finally` 中 `clearTimeout(timeout)`

这属于硬超时截断策略，超时后 Track A 失败会进入降级仲裁，不会卡死 API。

### 1.3 Champion vs Challenger 仲裁与降级

仲裁逻辑（`POST` 尾部）：

1. 若 Track A fulfilled：优先返回 `source: "rag"`。
2. 否则若 Track B fulfilled：返回 `source: "local"`，并携带 `fallbackReason`。
3. 若两者都失败：返回 `source: "degraded"` + 安全兜底建议（仍为 200 响应）。

**关键保障**：即使双轨异常，接口也不会向前端抛 500，前端可始终渲染 CriticPanel。

### 1.4 A/B 原始结果归档

无论最终仲裁返回哪一轨，都会落盘：

- `critic_rag_track.json`
- `critic_local_track.json`

目录选择策略：

- 优先复用 `outputs/` 下该品类最近目录（按目录名倒序）
- 不存在时新建 `outputs/<timestamp>_<safeProductName>/`

---

## 2. 数据流与非侵入式 Diff 逻辑

### 2.1 关于 `/api/revise/` 的现状说明

当前代码库 **不存在** `src/app/api/revise/route.ts`。

“重写（Revise）”能力被折叠进 `src/app/api/generate-prd/route.ts`：

- 通过可选字段 `basePrd` + `evolutionSuggestion` 触发“采纳并进化”分支
- 否则走默认“从洞察生成 PRD”分支

### 2.2 `<mark>` 注入策略

`generate-prd` 的重写分支 Prompt 明确要求：

- 对新增/改写关键内容使用 `<mark>...</mark>` 包裹
- 输出完整 PRD Markdown

这是一种“内容级标注、渲染层消费”的非侵入式对比策略，不改数据库结构。

### 2.3 前端高亮渲染

在 `src/components/prd/prd-markdown.tsx`：

- `ReactMarkdown` 启用 `rehype-raw`，允许 HTML 标签（含 `<mark class="diff-highlight">`）进入渲染树。
- Mermaid 代码块仍在 `components.code` 中被拦截，不影响 `<mark>` 路径。

在 `src/app/globals.css`：

- 定义 `.diff-highlight` 视觉样式（浅绿底 + 左边框 + 轻圆角），实现 Notion 风格增量强调。

### 2.4 导出时清洗 UI 标签

`src/app/page.tsx` 的 `handleExportMarkdown`：

- 导出前执行：
  - `const cleanMarkdown = prdContent.replace(/<mark[^>]*>|<\/mark>/g, "")`
- Blob 使用 `cleanMarkdown`，确保导出的 `.md` 无 UI 高亮标签，保持正式文档纯净。

---

## 3. 数据治理：分层抽样算法（Stratified Sampling）

核心在 `src/app/page.tsx`：

- `parseRatingValue(rating: string)`：从数字/字符串中解析 1~5 评分（含容错）
- `stratifiedSampleByRating(items, 500)`：按好中差真实比例抽样

### 3.1 分层定义

- 好评：4~5
- 中评：3
- 差评：1~2

### 3.2 抽样流程

1. 将样本分桶（positive / neutral / negative）
2. 计算每桶目标配额：`floor(ratio * maxSize)`
3. 按剩余容量二次分配余量，尽可能补满到 500
4. 每桶随机打乱后抽取配额
5. 若仍不足，回退池补齐
6. 最终再次打乱，输出不超过 500 条

### 3.3 无评分场景处理

- 若无法识别有效评分信号：直接全量打乱后截取 500，避免时间/文件顺序偏置。

### 3.4 接入位置

- `toReviewItems()` 在内容过滤后调用 `stratifiedSampleByRating(...)`
- 上游上传与 `inspect` API 链路不变，仅改变样本代表性

---

## 4. 工程鲁棒性与风控

### 4.1 Mermaid 渲染防爆机制

`src/components/prd/prd-markdown.tsx`：

- `try/catch` 包裹 `mermaid.render(...)`
- `suppressErrorRendering: true`，抑制 Mermaid 内置“炸弹错误图”侵入
- `isErrorSvg(...)` 二次检查错误 SVG 关键词（syntax/parse/lexical）
- 任何失败均回退为普通 `<pre><code>` 文本块，保障主 UI 不崩
- 主题当前为 `neutral`，适配商业亮色展示

### 4.2 频率限制（Rate Limiting）现状

经扫描 `src/`，**当前未实现应用层 IP 频率限制**（无内存桶、无 429 分支、无 `x-forwarded-for` 逻辑）。

这意味着：

- 目前 API 风控主要依赖输入校验（`zod`）与失败降级
- 尚无针对恶意高频请求的服务保护

建议后续加固（可放入下一 sprint）：

1. 在关键 API（`generate-prd`、`critic`）增加内存 Map 限流（窗口计数或令牌桶）
2. 按 `x-forwarded-for` / `cf-connecting-ip` 提取客户端标识
3. 超限返回 429 + Retry-After
4. 保留最小审计日志，避免泄露敏感信息

---

## 5. 前端端到端流转图（当前真实行为）

1. 上传 CSV/Excel -> 本地解析 -> `runInspectPipeline`
2. `POST /api/inspect` 返回字段映射与拦截结论
3. 通过后形成标准化样本（最多 500，分层抽样）
4. `POST /api/analyze` 得到 Top 3 痛点
5. `POST /api/generate-prd` 流式生成 PRD
6. 流结束后自动触发 `POST /api/critic`
7. CriticPanel 展示建议；可点击“采纳并进化”
8. 采纳后再次调用 `generate-prd` 的重写分支，并再次触发 critic 审查

---

## 6. 环境变量与部署角色（Vercel）

### 必需

- `OPENAI_API_KEY`
  - 用于 `inspect/analyze/generate-prd/critic` 的模型调用
- `OPENAI_BASE_URL`
  - 自定义兼容端点，代码会自动补 `/v1`

### 条件必需

- `TAVILY_API_KEY`
  - `generate-prd`：外部竞品检索（开启 `enableSearch` 时）
  - `critic` Track A：联网 Challenger 轨道
  - 缺失时 Track A 失败，但 Critic 会降级到 Track B

---

## 7. 作品集演示导向的特殊逻辑（需知）

1. `use-dashboard-metrics` 预置了演示初始值（非零）：
   - `totalReviews: 500`, `totalInsights: 12`, `totalPrds: 38`, `avgRlhfScore: 4.8`
2. Critic 双轨采用“永不向前端抛 500”策略，优先稳定演示体验。
3. Mermaid 采用保守渲染与降级，避免图表语法噪声破坏页面。
4. 导出会清洗 `<mark>`，实现“页面可视 diff / 文档正式交付”双目标。
5. 目录锚点采用统一 slug 工具（`generateSlug`），支持侧栏大纲平滑跳转。
6. 上传链路包含大量 `console.log` 探针，利于演示现场快速诊断。

---

## 8. 下一任 Agent 接棒优先级建议

### P0（稳定性）

- 引入 API 级限流（IP + 429）
- 将 `critic` 与 `generate-prd` 的目录归档策略统一为同一 run-id，减少多目录分裂

### P1（质量）

- 将 “采纳并进化” 从单建议串联升级为多建议批量应用
- 增加 `<mark>` 区域统计（改写句数/段落数）用于质量评估

### P2（工程）

- 将 `page.tsx` 超大文件拆分为 feature 组件与 hooks
- 为 `critic` 补集成测试（超时、双失败、单轨成功分支）

---

我已经完成了对代码库的完整深度审计，核心逻辑已全部文档化，下一任 Agent 可根据此文件无缝接管本项目。


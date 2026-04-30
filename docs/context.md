# AI PRD Generator (智能产研工作台) - 全局上下文与架构文档

## 1. 核心架构与数据流 (Architecture & Data Flow)
当前系统采用 **Next.js App Router + API Routes + Vercel AI SDK** 的服务端编排架构，前端负责数据采集与流式展示，后端负责检索、上下文拼接与一次性流式生成。  
现行稳定数据流（已替代不稳定 Agent Tool Calling）：
1. 前端上传 CSV/Excel，经本地解析后发送到 `/api/inspect`，完成字段语义映射与有效性拦截，得到标准化 VOC 样本（最多 500 条）。
2. 前端将标准化 VOC 发送到 `/api/analyze`，提炼 Top 3 痛点洞察（含原话引用）。
3. 前端调用 `/api/generate-prd`（携带 `insights + productCategory + enableSearch`）。
4. 后端在 Node.js 中（非模型工具调用）按开关直连 Tavily 抓取竞品数据，得到 `searchContext`。
5. 后端将 **本地 VOC 洞察 + 外部竞品情报** 拼接为双源 Prompt，调用 DeepSeek `deepseek-chat` 发起**单次纯净 `streamText`**流式输出。
6. 前端按 chunk 增量渲染 Markdown，避免多步工具状态机导致的中断与空流问题。

## 2. 核心功能与持久化 (Features & Persistence)
- 生成策略已升级为商业化 PRD 输出：System Prompt 强制要求中文、竞品对标章节、SWOT视角、GTM导向方案与指标化收敛（Markdown 表格化指标）。
- 后端已实现本地知识沉淀（`fs/promises` + `path`）：
  - 在 `outputs/<timestamp>_<safeProductName>/` 自动建档；
  - 保存 `1_user_insights.json`（本地洞察原始输入）；
  - Tavily 成功时保存 `2_market_research.json`（竞品情报中间产物）；
  - 在 `streamText.onFinish` 保存 `3_final_prd.md`（最终PRD成品）。
- 该落盘机制支持复盘、审计、A/B 对比与后续知识库再利用。

## 3. 即将进行的下一步冲刺 (Next Sprint Backlog)
1. **Markdown 渲染体验巩固**：统一审查 `react-markdown + remark-gfm + @tailwindcss/typography` 的生产样式一致性（标题层级、引用块、表格、暗黑主题细节）。
2. **Dashboard 动态化改造**：将静态统计卡替换为 React 状态驱动数据源，并新增 `Avg. RLHF Score` 反馈卡片（联动模型质量观测）。
3. **数据抽样免责声明**：在前端上传/分析区域增加专业免责声明（抽样偏差、时间窗口、样本代表性边界）。
4. **PRD 导出能力增强**：完善 Blob 导出 `.md` 能力（命名规范、失败回退、导出状态提示、跨浏览器兼容性）。

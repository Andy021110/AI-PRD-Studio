# AI-PRD-Studio

AI-PRD-Studio 是一个面向真实业务场景的 AI 产品需求生成工作台：输入用户评论数据，系统自动完成质检、洞察提炼、PRD 生成、Critic 审查与迭代重写，输出可直接用于评审与沟通的商业化 PRD。

## 项目愿景

传统 PRD 产出常见两个问题：一是“只会写文档不懂市场”，二是“只看主观经验忽略真实用户反馈”。  
AI-PRD-Studio 的目标是把 **用户声音（VOC）**、**竞品情报** 与 **工程可执行性** 融合到同一条自动化链路，帮助产品团队更快形成可落地、可验证、可迭代的需求方案。

## 核心架构

### 1) Multi-Agent 端到端流水线

- `POST /api/inspect`：上传后先做数据合法性校验与字段映射（rating/date/content）
- `POST /api/analyze`：提炼 Top 3 高价值痛点，保留原始用户引用
- `POST /api/generate-prd`：流式生成 PRD（可切换“从零生成”与“采纳建议重写”）
- `POST /api/critic`：Dual-Track Critic 并行审查（见下）

### 2) Dual-Track Critic（博弈式自检）

Critic 采用双轨并发赛跑，避免单点失效：

- **Track A / Challenger（RAG）**：联网检索市场信息，执行外部事实约束审查
- **Track B / Champion（Local）**：本地专家人格快速审查，保障低延迟可用性
- **仲裁策略**：优先返回 Track A；Track A 失败时自动降级到 Track B；双轨都失败时返回 `degraded` 兜底建议

这套机制把“更准”和“更稳”分离：联网能力提升质量，本地能力保障服务连续性。

### 3) 分层抽样（Stratified Sampling）

针对大规模评论，系统不做简单前 N 条截断，而是按评分桶进行分层抽样：

- 好评（4~5）/ 中评（3）/ 差评（1~2）分别配额
- 按真实分布分配样本，再补齐余量到目标上限（默认 500）
- 无评分信号时回退为随机抽样

该策略显著降低样本偏置，让洞察更接近真实用户结构。

## 非侵入式 Diff 展示（Revise 体验）

“采纳并进化”模式下，模型会用 `<mark>...</mark>` 标注新增或改写内容，前端渲染层高亮展示，形成可视化差异对比；导出 Markdown 时再自动清洗 `<mark>` 标签，保证交付文档纯净。

这是一种内容标注与渲染解耦的设计：

- **页面层**：可视化增量，便于评审
- **导出层**：干净文档，便于流转

## 28s 超时熔断的工程思考

Track A 引入 `AbortController` + 28s 硬超时，超时立即中断外部请求并进入降级仲裁。  
设计重点不是“每次都成功联网”，而是“任何情况下都不给前端制造不可恢复的卡死/500”。

工程收益：

- 限制第三方波动对主流程的拖累
- 在演示与生产环境下都保持稳定可用
- 让错误成为可管理状态，而不是用户可见故障

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+

### 安装与运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

### 环境变量

创建 `.env.local`：

```bash
OPENAI_API_KEY=your_openai_key
OPENAI_BASE_URL=https://your-compatible-endpoint
TAVILY_API_KEY=your_tavily_key
```

说明：

- `OPENAI_API_KEY`、`OPENAI_BASE_URL`：必需
- `TAVILY_API_KEY`：启用联网检索与 Critic Track A 时必需

## Demo 数据

- 前端上传区提供一键下载：`/data/amazon_sample.csv`
- 仓库内原始数据位于 `data/`

## 项目结构（关键目录）

```text
src/
  app/
    api/
      inspect/
      analyze/
      generate-prd/
      critic/
    page.tsx
  components/prd/prd-markdown.tsx
  lib/markdown/
docs/
  handover_guide.md
data/
public/data/
outputs/
```

## 工程化说明

- 严格环境变量注入，禁止在代码中硬编码密钥
- Critic 双轨结果归档到 `outputs/`，便于审计与复盘
- Mermaid 渲染失败自动降级为代码块，避免页面崩溃
- API 边界统一做输入校验（`zod`）

## License

For portfolio and demonstration purposes.

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { z } from "zod";
import { resolveArchiveDir, writeArchiveFile } from "@/lib/archive/safe-archive";

const insightSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  quotes: z.array(z.string().min(1)).min(2),
});

const requestSchema = z.object({
  productCategory: z.string().min(1),
  insights: z.array(insightSchema).min(1),
  enableSearch: z.boolean().optional().default(false),
  basePrd: z.string().optional(),
  evolutionSuggestion: z.string().optional(),
});

function buildProvider() {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
    throw new Error("Missing OPENAI_API_KEY or OPENAI_BASE_URL.");
  }

  const rawBaseUrl = process.env.OPENAI_BASE_URL.trim().replace(/\/+$/, "");
  const normalizedBaseUrl = rawBaseUrl.endsWith("/v1")
    ? rawBaseUrl
    : `${rawBaseUrl}/v1`;

  return createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: normalizedBaseUrl,
  });
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const openai = buildProvider();
    const enableSearch = payload.enableSearch ?? false;
    const outputDir = await resolveArchiveDir(payload.productCategory);

    await writeArchiveFile(
      outputDir,
      "1_user_insights.json",
      JSON.stringify(payload.insights, null, 2),
    );

    let searchContext = "未开启竞品检索或检索失败。";

    if (enableSearch && process.env.TAVILY_API_KEY) {
      console.log("=== 🔍 阶段1：后端直连 Tavily 抓取外部数据 ===");
      try {
        const query = `${payload.productCategory} market competitors pain points reviews`;
        const tavilyResponse = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
          }),
        });

        if (tavilyResponse.ok) {
          const data = (await tavilyResponse.json()) as {
            results?: Array<{ title?: string; content?: string; url?: string }>;
          };
          searchContext = JSON.stringify(data.results ?? []);
          console.log("=== 🔍 阶段1完成：成功拿到数据 ===");
          await writeArchiveFile(
            outputDir,
            "2_market_research.json",
            JSON.stringify(data.results ?? [], null, 2),
          );
        }
      } catch (e) {
        console.error("Tavily search failed", e);
      }
    }

    console.log("=== 🔍 阶段2：触发生成，并将监听结果落盘 ===");
    const result = streamText({
      model: openai.chat("deepseek-chat"),
      temperature: 0.2,
      system: `You are an Expert AI Hardware CPO and Top-tier Business Strategist.
Your task is to write a comprehensive, commercially viable PRD in pure Markdown.

CRITICAL INSTRUCTIONS: 
1. You MUST output the ENTIRE document in professional Chinese (中文). 
2. You MUST integrate the provided [Market Competitor Data] into your analysis. Do not ignore it.

Format Requirements (Strictly follow this structure):
- Start with exactly: > **🤖 Critic 质检报告：已融合全网竞品数据** (如果传入了外部数据) 或 > **🤖 Critic 质检报告：基于本地洞察**
- Section 1: 迭代背景与核心目标 (Executive Summary - 结合大盘趋势与本地客诉) 
- Section 2: 市场大盘与竞品对标 (Market & Competitor Analysis - 核心重点！必须引用传入的竞品情报，指名道姓地对比竞品策略，并使用 SWOT 分析法总结我们的机会与威胁)
- Section 3: 痛点归因分析 (Problem Definition - 必须引用真实的本地用户反馈原话)
- Section 4: 解决方案与商业策略 (Solutions & Go-To-Market - 结合硬核技术方案与定价/包装等商业策略，避免脱离市场的纯技术自嗨)
- Section 5: 成功指标 (Success Metrics - 必须使用 Markdown 表格)
- You MUST include at least TWO Mermaid diagrams in the PRD:
  1) one \`pie\` chart for pain-point distribution or market share,
  2) one \`flowchart TD\` for core business process or system architecture.
- Strict Mermaid guardrails:
  - Allowed syntax only: \`pie\`, \`title\`, \`flowchart TD\`, and simple \`A --> B\` style edges.
  - Forbidden chart types: \`quadrantChart\`, \`mindmap\`, \`journey\`, \`timeline\`, \`stateDiagram\`, \`sequenceDiagram\`, \`gantt\`, \`sankey\`, \`xychart\`, and any other advanced type.
  - Use plain labels without quotes, parentheses, or special punctuation in Mermaid lines.
  - Keep Mermaid blocks short and conservative: pie (3-6 rows), flowchart (5-10 nodes max).
  - Wrap each diagram strictly in a separate \`\`\`mermaid code block. Do not output prose inside the code block.
- Markdown formatting hard rules:
  - Markdown tables MUST use standard multi-line table syntax; each row must occupy exactly one line.
  - NEVER compress table rows into a single line with \`||\` or continuous pipes.
  - For execution checklists, prefer bullet lists (\`- [ ]\`) over giant single-line pipe tables.
- Output quality gate:
  - Ensure headings, paragraphs, bullet lists, and tables are separated by blank lines for stable rendering.`,
      prompt: payload.basePrd && payload.evolutionSuggestion
        ? `
当前任务是对现有 PRD 做“采纳并进化”重写，而不是从零生成。

[产品品类]
${payload.productCategory}

[当前 PRD 草案]
${payload.basePrd}

[需要采纳的审查建议]
${payload.evolutionSuggestion}

要求：
1) 保留原文结构主线，但根据建议进行实质性增强。
2) 所有新增或改写的关键内容必须用 <mark>...</mark> 包裹。
3) 输出完整 PRD Markdown（不是局部片段）。
4) CRITICAL RULE: You MUST wrap all modified, added, or deeply revised text strictly within <mark> and </mark> tags.
5) CRITICAL RULE: Do NOT wrap unchanged original text with <mark>.
`
        : `
产品品类 (Product Category): ${payload.productCategory}

[本地用户洞察 (Local User Insights / VOC)]
${JSON.stringify(payload.insights, null, 2)}

[全网竞品情报 (Market Competitor Data)]
${searchContext}

请严格基于上述双源数据，立即生成一份高质量、具有极强商业对标价值的全中文 PRD。
`,
      onFinish: async ({ text }) => {
        try {
          await writeArchiveFile(outputDir, "3_final_prd.md", text);
          if (outputDir) {
            console.log(`\n✅ 报告已完美落盘保存至: ${outputDir}`);
          }
        } catch (err) {
          console.error("保存 PRD 失败:", err);
        }
      },
    });

    return result.toTextStreamResponse();
  } catch (error) {
    console.error("\n=== ❌ 探针 4：捕获到全局致命崩溃 ===");
    const message =
      error instanceof Error ? error.message : "Unknown generate-prd error.";
    return new Response(
      JSON.stringify({ message: `Generate PRD failed: ${message}` }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}


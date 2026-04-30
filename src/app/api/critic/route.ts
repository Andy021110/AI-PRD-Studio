import { z } from "zod";
import { resolveArchiveDir, writeArchiveFile } from "@/lib/archive/safe-archive";

const requestSchema = z.object({
  productCategory: z.string().min(1),
  prdMarkdown: z.string().min(1),
});

const suggestionSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  action: z.string().min(1),
});

const modelResponseSchema = z.object({
  suggestions: z.array(suggestionSchema).min(1),
});

type CriticSuggestion = z.infer<typeof suggestionSchema>;

type CriticTrackSuccess = {
  suggestions: CriticSuggestion[];
  track: "rag" | "local";
  meta?: Record<string, unknown>;
};

function getModelEndpoint() {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
    throw new Error("Missing OPENAI_API_KEY or OPENAI_BASE_URL.");
  }
  const rawBaseUrl = process.env.OPENAI_BASE_URL.trim().replace(/\/+$/, "");
  const normalizedBaseUrl = rawBaseUrl.endsWith("/v1")
    ? rawBaseUrl
    : `${rawBaseUrl}/v1`;
  return `${normalizedBaseUrl}/chat/completions`;
}

function parseJsonObject(raw: string) {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model did not return a JSON object.");
  }
  const jsonText = raw.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonText) as unknown;
}

async function callModel({
  system,
  prompt,
  signal,
}: {
  system: string;
  prompt: string;
  signal?: AbortSignal;
}) {
  const endpoint = getModelEndpoint();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const payloadText = await response.text();
    throw new Error(`Model call failed (${response.status}): ${payloadText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Model response is empty.");
  }
  return content;
}

function expertPersona(productCategory: string) {
  const lower = productCategory.toLowerCase();
  if (
    lower.includes("software") ||
    lower.includes("saas") ||
    lower.includes("app") ||
    lower.includes("平台")
  ) {
    return "你是资深软件架构与安全专家，重点审查权限模型、并发容量、异常恢复与可观测性。";
  }
  return "你是资深硬件产品与供应链专家，重点审查BOM、功耗热设计、可靠性和量产风险。";
}

async function runTrackA({
  productCategory,
  prdMarkdown,
}: {
  productCategory: string;
  prdMarkdown: string;
}): Promise<CriticTrackSuccess> {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("Missing TAVILY_API_KEY for Track A.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Track A timeout"), 28_000);

  try {
    const query = `${productCategory} PRD best practices standards checklist`;
    const tavilyResponse = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
      }),
      signal: controller.signal,
    });

    if (!tavilyResponse.ok) {
      throw new Error(`Tavily failed with status ${tavilyResponse.status}`);
    }

    const tavilyPayload = (await tavilyResponse.json()) as {
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };
    const topSources = (tavilyPayload.results ?? []).slice(0, 5);

    const system = `You are Track A (Challenger), a strict external-facts PRD critic.
Return JSON only with this shape:
{
  "suggestions": [
    { "title": "...", "rationale": "...", "action": "..." }
  ]
}
Rules:
- Exactly 3 suggestions.
- Each suggestion must cite market/industry rationale from provided context.
- Keep concise and practical.
- CRITICAL RULE: You MUST generate the final JSON response entirely in Simplified Chinese (简体中文).
- Do NOT use English for any titles, rationale, actions, or any other JSON text values.
- If any draft token appears in English, rewrite it to natural, professional Simplified Chinese before final output.`;

    const prompt = `Product Category: ${productCategory}

[External Context]
${JSON.stringify(topSources, null, 2)}

[Current PRD Draft]
${prdMarkdown}

Provide exactly 3 fact-grounded critique suggestions in JSON.
Final response must be 100% Simplified Chinese in all text fields.`;

    const modelText = await callModel({
      system,
      prompt,
      signal: controller.signal,
    });
    const parsed = parseJsonObject(modelText);
    const validated = modelResponseSchema.parse(parsed);

    return {
      track: "rag",
      suggestions: validated.suggestions.slice(0, 3),
      meta: { sources: topSources.length },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runTrackB({
  productCategory,
  prdMarkdown,
}: {
  productCategory: string;
  prdMarkdown: string;
}): Promise<CriticTrackSuccess> {
  const system = `You are Track B (Champion), a fast local-domain PRD critic.
${expertPersona(productCategory)}
Return JSON only with this shape:
{
  "suggestions": [
    { "title": "...", "rationale": "...", "action": "..." }
  ]
}
Rules:
- Exactly 3 suggestions.
- Prioritize actionable quality improvements.
- CRITICAL RULE: You MUST generate the final JSON response entirely in Simplified Chinese (简体中文).
- Do NOT use English for any titles, rationale, actions, or any other JSON text values.
- If any draft token appears in English, rewrite it to natural, professional Simplified Chinese before final output.`;

  const prompt = `Product Category: ${productCategory}

[Current PRD Draft]
${prdMarkdown}

Output 3 concise expert suggestions in JSON only.
Final response must be 100% Simplified Chinese in all text fields.`;

  const modelText = await callModel({ system, prompt });
  const parsed = parseJsonObject(modelText);
  const validated = modelResponseSchema.parse(parsed);

  return {
    track: "local",
    suggestions: validated.suggestions.slice(0, 3),
  };
}

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const outputDir = await resolveArchiveDir(payload.productCategory, {
      reuseLatestByProduct: true,
    });

    const [trackASettled, trackBSettled] = await Promise.allSettled([
      runTrackA(payload),
      runTrackB(payload),
    ]);

    const ragArchive =
      trackASettled.status === "fulfilled"
        ? { ok: true, data: trackASettled.value }
        : { ok: false, error: String(trackASettled.reason) };
    const localArchive =
      trackBSettled.status === "fulfilled"
        ? { ok: true, data: trackBSettled.value }
        : { ok: false, error: String(trackBSettled.reason) };

    await Promise.all([
      writeArchiveFile(
        outputDir,
        "critic_rag_track.json",
        JSON.stringify(ragArchive, null, 2),
      ),
      writeArchiveFile(
        outputDir,
        "critic_local_track.json",
        JSON.stringify(localArchive, null, 2),
      ),
    ]);

    if (trackASettled.status === "fulfilled") {
      return Response.json({
        source: "rag",
        suggestions: trackASettled.value.suggestions.slice(0, 3),
      });
    }

    if (trackBSettled.status === "fulfilled") {
      return Response.json({
        source: "local",
        fallbackReason: String(trackASettled.reason),
        suggestions: trackBSettled.value.suggestions.slice(0, 3),
      });
    }

    return Response.json({
      source: "degraded",
      suggestions: [
        {
          title: "审查服务暂时不可用",
          rationale: "联网与本地审查都未成功返回，系统已自动降级。",
          action: "请稍后重试，或先继续手动优化 PRD。",
        },
      ],
      fallbackReason: "Both tracks failed",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown critic error.";
    return Response.json(
      {
        source: "degraded",
        suggestions: [
          {
            title: "审查请求参数异常",
            rationale: message,
            action: "请检查请求体后重试。",
          },
        ],
      },
      { status: 200 },
    );
  }
}


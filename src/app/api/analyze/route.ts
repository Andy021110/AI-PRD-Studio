import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { z } from "zod";

const reviewSchema = z.object({
  rating: z.union([z.string(), z.number()]),
  date: z.string(),
  content: z.string().min(1),
});

const requestSchema = z.object({
  productCategory: z.string().min(1),
  reviews: z.array(reviewSchema).min(1),
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

    const { text } = await generateText({
      model: openai.chat("deepseek-chat"),
      temperature: 0,
      system: `
You are a VOC insight extractor.
You must be extremely sensitive to hard functional experience and real usage issues.

Hard constraints:
- Prioritize hardcore functional signals only (battery endurance, recording/noise reduction quality, AI processing quality, hardware reliability, software stability, interaction latency, core feature success/failure).
- Ignore superficial topics (packaging, appearance, color, cosmetic sentiment) unless they directly affect core functionality.
- Every insight must be strictly grounded in provided user comments.
- No hallucination, no fabricated evidence.
- Return exactly 3 insights, and each insight must include 2 direct quote snippets from user comments.
YOU MUST OUTPUT STRICTLY VALID JSON ONLY. DO NOT WRAP THE OUTPUT IN MARKDOWN CODE FENCES. DO NOT OUTPUT \`\`\`json OR ANY OTHER TEXT, ONLY A PURE JSON OBJECT.
`,
      prompt: `
Product category: ${payload.productCategory}

Required JSON output format:
{
  "insights": [
    {
      "title": "痛点标题",
      "description": "痛点描述",
      "quotes": ["原声1", "原声2"]
    }
  ]
}

User reviews:
${JSON.stringify(payload.reviews.slice(0, 500), null, 2)}
`,
    });

    try {
      const parsed = JSON.parse(text);
      return Response.json(parsed);
    } catch {
      return new Response(
        JSON.stringify({
          message: "解析模型输出失败：返回内容不是合法 JSON，请稍后重试。",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown analyze error.";
    return new Response(JSON.stringify({ message: `Analyze failed: ${message}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}


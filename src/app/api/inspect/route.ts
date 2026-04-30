import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

const inspectRequestSchema = z.object({
  headers: z.array(z.string()).min(1),
  sampleRows: z.array(z.record(z.string(), z.unknown())).min(1),
});

const inspectResponseSchema = z.object({
  isValid: z.boolean(),
  productCategory: z.string(),
  mapping: z.object({
    ratingColumn: z.string().nullable(),
    dateColumn: z.string().nullable(),
    contentColumn: z.string(),
  }),
  rejectReason: z.string(),
});

function buildPrompt(headers: string[], sampleRows: Record<string, unknown>[]) {
  return `
You are a Data Inspector Agent for enterprise product-feedback pipelines.

Your job:
1) Decide whether the uploaded table is product feedback/review data.
2) Infer the product category.
3) Map table columns to rating/date/content fields.

Rules:
- If data is not product review/feedback (e.g. code snippets, finance statements), set isValid=false.
- If isValid=false, provide a clear rejectReason in Chinese.
- mapping.contentColumn must be one of the headers when isValid=true.
- mapping.ratingColumn and mapping.dateColumn can be null when no suitable column exists.
- Never invent headers outside the provided list.
- Keep rejectReason short and actionable.

Provided headers:
${JSON.stringify(headers, null, 2)}

Sample rows:
${JSON.stringify(sampleRows, null, 2)}
`;
}

export async function POST(request: Request) {
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
      return NextResponse.json(
        { message: "Missing OPENAI_API_KEY or OPENAI_BASE_URL." },
        { status: 500 },
      );
    }

    const payload = inspectRequestSchema.parse(await request.json());

    const rawBaseUrl = process.env.OPENAI_BASE_URL.trim().replace(/\/+$/, "");
    const normalizedBaseUrl = rawBaseUrl.endsWith("/v1")
      ? rawBaseUrl
      : `${rawBaseUrl}/v1`;

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: normalizedBaseUrl,
    });

    const prompt = buildPrompt(payload.headers, payload.sampleRows);
    let object: z.infer<typeof inspectResponseSchema>;

    try {
      const result = await generateObject({
        model: openai.chat("deepseek-chat"),
        schema: inspectResponseSchema,
        mode: "tool",
        temperature: 0,
        prompt,
      });
      object = result.object;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canFallback = message.includes("response_format");
      if (!canFallback) {
        throw error;
      }

      const textResult = await generateText({
        model: openai.chat("deepseek-chat"),
        temperature: 0,
        prompt: `${prompt}

Return only a JSON object with this shape:
{
  "isValid": boolean,
  "productCategory": string,
  "mapping": {
    "ratingColumn": string | null,
    "dateColumn": string | null,
    "contentColumn": string
  },
  "rejectReason": string
}
`,
      });

      const rawText = textResult.text.trim();
      const jsonBlockMatch = rawText.match(/\{[\s\S]*\}/);
      const jsonText = jsonBlockMatch ? jsonBlockMatch[0] : rawText;
      const parsed = JSON.parse(jsonText);
      object = inspectResponseSchema.parse(parsed);
    }

    return NextResponse.json(object);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown inspect error.";
    return NextResponse.json(
      { message: `Inspect failed: ${message}` },
      { status: 400 },
    );
  }
}


"use client";

import Papa from "papaparse";
import * as XLSX from "xlsx";
import { ChangeEvent, useMemo, useState } from "react";
import {
  BadgeCheck,
  FileSpreadsheet,
  Sparkles,
  Star,
  UploadCloud,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { PrdMarkdown } from "@/components/prd/prd-markdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toaster } from "@/components/ui/toaster";
import { useDashboardMetrics } from "@/hooks/use-dashboard-metrics";
import { useToast } from "@/hooks/use-toast";
import { extractMarkdownHeadings } from "@/lib/markdown/headings";
import { cn } from "@/lib/utils";

type ReviewItem = {
  rating: string;
  date: string;
  content: string;
};

type DataRow = Record<string, unknown>;

type InspectResponse = {
  isValid: boolean;
  productCategory: string;
  mapping: {
    ratingColumn: string | null;
    dateColumn: string | null;
    contentColumn: string;
  };
  rejectReason: string;
};

type InsightItem = {
  title: string;
  description: string;
  quotes: string[];
};

type CriticSuggestion = {
  title: string;
  rationale: string;
  action: string;
};

const INVALID_DATA_MESSAGE =
  "数据格式不匹配，请检查是否包含 rating, date, content 字段";
const FILE_INPUT_ID = "reviews-file-input";

function toSafeString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function normalizeHeaders(headers: string[]) {
  const seen = new Map<string, number>();
  return headers.map((rawHeader, index) => {
    const base = toSafeString(rawHeader) || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function shuffleInPlace<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function parseRatingValue(rating: string): number | null {
  const numeric = Number(rating);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 5) {
    return numeric;
  }

  const matched = rating.match(/([1-5](?:\.\d+)?)/);
  if (!matched) {
    return null;
  }

  const extracted = Number(matched[1]);
  if (!Number.isFinite(extracted)) {
    return null;
  }

  if (extracted <= 1 && extracted >= 0) {
    return Math.max(1, Math.round(extracted * 5));
  }

  if (extracted > 1 && extracted <= 5) {
    return Math.round(extracted);
  }

  return null;
}

function stratifiedSampleByRating(items: ReviewItem[], maxSize: number) {
  if (items.length <= maxSize) {
    return items;
  }

  const positives: ReviewItem[] = [];
  const neutrals: ReviewItem[] = [];
  const negatives: ReviewItem[] = [];
  let hasRatingSignal = false;

  for (const item of items) {
    const parsed = parseRatingValue(item.rating);
    if (parsed === null) {
      continue;
    }

    hasRatingSignal = true;
    if (parsed >= 4) {
      positives.push(item);
    } else if (parsed === 3) {
      neutrals.push(item);
    } else {
      negatives.push(item);
    }
  }

  if (!hasRatingSignal) {
    const shuffled = [...items];
    shuffleInPlace(shuffled);
    return shuffled.slice(0, maxSize);
  }

  const totalRated = positives.length + neutrals.length + negatives.length;
  const buckets = [
    { source: positives, target: 0 },
    { source: neutrals, target: 0 },
    { source: negatives, target: 0 },
  ];

  let assigned = 0;
  for (const bucket of buckets) {
    const ratio = totalRated === 0 ? 0 : bucket.source.length / totalRated;
    const target = Math.floor(ratio * maxSize);
    bucket.target = Math.min(target, bucket.source.length);
    assigned += bucket.target;
  }

  let remaining = maxSize - assigned;
  if (remaining > 0) {
    const bySpareCapacity = [...buckets].sort(
      (a, b) =>
        b.source.length - b.target - (a.source.length - a.target),
    );
    for (const bucket of bySpareCapacity) {
      if (remaining === 0) {
        break;
      }
      const spare = bucket.source.length - bucket.target;
      if (spare <= 0) {
        continue;
      }
      const extra = Math.min(spare, remaining);
      bucket.target += extra;
      remaining -= extra;
    }
  }

  const sampled: ReviewItem[] = [];
  for (const bucket of buckets) {
    if (bucket.target === 0) {
      continue;
    }
    const shuffledBucket = [...bucket.source];
    shuffleInPlace(shuffledBucket);
    sampled.push(...shuffledBucket.slice(0, bucket.target));
  }

  if (sampled.length < maxSize) {
    const sampledSet = new Set(sampled.map((item) => `${item.date}|${item.rating}|${item.content}`));
    const fallbackPool = items.filter(
      (item) => !sampledSet.has(`${item.date}|${item.rating}|${item.content}`),
    );
    shuffleInPlace(fallbackPool);
    sampled.push(...fallbackPool.slice(0, maxSize - sampled.length));
  }

  shuffleInPlace(sampled);
  return sampled.slice(0, maxSize);
}

function toReviewItems(rows: DataRow[], mapping: InspectResponse["mapping"]) {
  const normalized = rows
    .map((row) => {
      const rating = mapping.ratingColumn
        ? toSafeString(row[mapping.ratingColumn])
        : "";
      const date = mapping.dateColumn ? toSafeString(row[mapping.dateColumn]) : "";
      const content = toSafeString(row[mapping.contentColumn]);

      if (!content) {
        return null;
      }

      return {
        rating: rating || "N/A",
        date: date || "N/A",
        content,
      } satisfies ReviewItem;
    })
    .filter((item): item is ReviewItem => item !== null);

  return stratifiedSampleByRating(normalized, 500);
}

export default function Home() {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [fileName, setFileName] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGeneratingPrd, setIsGeneratingPrd] = useState(false);
  const [enableSearch, setEnableSearch] = useState(false);
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [prdContent, setPrdContent] = useState("");
  const [selectedRlhfScore, setSelectedRlhfScore] = useState<number | null>(null);
  const [hasSubmittedRlhf, setHasSubmittedRlhf] = useState(false);
  const [isCriticLoading, setIsCriticLoading] = useState(false);
  const [criticSource, setCriticSource] = useState<"rag" | "local" | "degraded" | null>(null);
  const [criticSuggestions, setCriticSuggestions] = useState<CriticSuggestion[]>([]);
  const [criticFallbackReason, setCriticFallbackReason] = useState("");
  const { toast } = useToast();
  const {
    totalReviews,
    totalInsights,
    totalPrds,
    avgRlhfScore,
    incrementReviews,
    incrementInsights,
    incrementPrds,
    submitRlhfScore,
  } = useDashboardMetrics();

  const stats = [
    {
      label: "本周处理评论",
      value: totalReviews.toLocaleString("zh-CN"),
      trend: "动态累计",
    },
    {
      label: "识别痛点簇",
      value: totalInsights.toLocaleString("zh-CN"),
      trend: "动态累计",
    },
    {
      label: "生成 PRD 草案",
      value: totalPrds.toLocaleString("zh-CN"),
      trend: "动态累计",
    },
    {
      label: "Avg. RLHF Score",
      value: avgRlhfScore.toFixed(1),
      trend: "待接入反馈",
    },
  ];

  const pipelineSteps = [
    "1. 数据接入",
    "2. 痛点洞察",
    "3. PRD 草案",
    "4. RLHF 与导出",
  ];

  const currentStep = useMemo(() => {
    if (isInspecting || reviews.length === 0) {
      return 1;
    }
    if (isAnalyzing || insights.length === 0) {
      return 2;
    }
    if (isGeneratingPrd || !prdContent.trim()) {
      return 3;
    }
    return 4;
  }, [insights.length, isAnalyzing, isGeneratingPrd, isInspecting, prdContent, reviews.length]);

  const prdHeadings = useMemo(
    () => extractMarkdownHeadings(prdContent),
    [prdContent],
  );

  const runInspectPipeline = async (
    headers: string[],
    rows: DataRow[],
    uploadedFileName: string,
  ) => {
    console.log("--- Upload Step 4: runInspectPipeline:start ---", {
      uploadedFileName,
      headerCount: headers.length,
      rowCount: rows.length,
    });
    if (headers.length === 0 || rows.length === 0) {
      throw new Error(INVALID_DATA_MESSAGE);
    }

    const sampleRows = rows.slice(0, 5);
    const response = await fetch("/api/inspect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        headers,
        sampleRows,
      }),
    });
    console.log("--- Upload Step 5: /api/inspect responded ---", {
      status: response.status,
      ok: response.ok,
    });

    const inspectPayload = (await response.json()) as
      | InspectResponse
      | { message?: string };

    if (!response.ok) {
      const errorMessage =
        "message" in inspectPayload
          ? inspectPayload.message
          : "数据质检服务暂不可用。";
      throw new Error(errorMessage || "数据质检服务暂不可用。");
    }

    const inspectResult = inspectPayload as InspectResponse;
    if (!inspectResult.isValid) {
      setReviews([]);
      setProductCategory("");
      setFileName("");
      toast({
        variant: "destructive",
        title: "上传被拦截",
        description:
          inspectResult.rejectReason || "该数据不属于产品评价数据，已拒绝导入。",
      });
      return;
    }

    if (!inspectResult.mapping.contentColumn) {
      throw new Error(INVALID_DATA_MESSAGE);
    }

    const normalized = toReviewItems(rows, inspectResult.mapping);
    if (normalized.length === 0) {
      throw new Error(INVALID_DATA_MESSAGE);
    }

    setReviews(normalized);
    setFileName(uploadedFileName);
    setProductCategory(inspectResult.productCategory || "未知品类");
    setInsights([]);
    setPrdContent("");
    setSelectedRlhfScore(null);
    setHasSubmittedRlhf(false);
    setIsCriticLoading(false);
    setCriticSuggestions([]);
    setCriticSource(null);
    setCriticFallbackReason("");
    incrementReviews(normalized.length);
    toast({
      variant: "success",
      title: "上传成功",
      description: `成功解析 ${normalized.length} 条评价数据！`,
    });
  };

  const resetWithError = (message: string) => {
    setReviews([]);
    setFileName("");
    setProductCategory("");
    setInsights([]);
    setPrdContent("");
    setSelectedRlhfScore(null);
    setHasSubmittedRlhf(false);
    setIsCriticLoading(false);
    setCriticSuggestions([]);
    setCriticSource(null);
    setCriticFallbackReason("");
    toast({
      variant: "destructive",
      title: "上传失败",
      description: message.includes("格式") ? INVALID_DATA_MESSAGE : message,
    });
  };

  const handleStartAnalysis = async () => {
    if (reviews.length === 0 || !productCategory) {
      toast({
        variant: "destructive",
        title: "无法启动",
        description: "请先上传并解析有效数据。",
      });
      return;
    }

    setIsAnalyzing(true);
    setInsights([]);
    setPrdContent("");
    setSelectedRlhfScore(null);
    setHasSubmittedRlhf(false);
    setIsCriticLoading(false);
    setCriticSuggestions([]);
    setCriticSource(null);
    setCriticFallbackReason("");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productCategory,
          reviews,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message || "多智能体分析启动失败。");
      }

      const payload = (await response.json()) as { insights?: InsightItem[] };
      if (!payload.insights || payload.insights.length !== 3) {
        throw new Error("洞察返回结构不符合预期。");
      }

      setInsights(payload.insights);
      incrementInsights(payload.insights.length);
      toast({
        variant: "success",
        title: "分析完成",
        description: "已提炼出 Top 3 核心痛点。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "多智能体分析失败。";
      toast({
        variant: "destructive",
        title: "分析失败",
        description: message,
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleGeneratePrd = async () => {
    if (insights.length === 0 || !productCategory) {
      toast({
        variant: "destructive",
        title: "无法生成 PRD",
        description: "请先完成第一步用户痛点挖掘。",
      });
      return;
    }

    setIsGeneratingPrd(true);
    setPrdContent("");
    setSelectedRlhfScore(null);
    setHasSubmittedRlhf(false);
    setIsCriticLoading(false);
    setCriticSuggestions([]);
    setCriticSource(null);
    setCriticFallbackReason("");

    try {
      const response = await fetch("/api/generate-prd", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          insights,
          productCategory,
          enableSearch,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message || "PRD 生成失败。");
      }

      if (!response.body) {
        throw new Error("服务端未返回可读取流。");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let accumulated = "";

      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (!done && chunk.value) {
          accumulated += decoder.decode(chunk.value, { stream: true });
          setPrdContent(accumulated);
        }
      }

      accumulated += decoder.decode();
      if (!accumulated.trim()) {
        throw new Error("PRD 流式输出为空，请稍后重试。");
      }
      setPrdContent(accumulated);
      incrementPrds();
      toast({
        variant: "success",
        title: "PRD 已生成",
        description: "结构化 PRD 草案已完成。",
      });
      void triggerCriticReview(accumulated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PRD 生成失败。";
      toast({
        variant: "destructive",
        title: "生成失败",
        description: message,
      });
    } finally {
      setIsGeneratingPrd(false);
    }
  };

  const handleExportMarkdown = () => {
    if (!prdContent.trim()) {
      toast({
        variant: "destructive",
        title: "无法导出",
        description: "当前还没有可导出的 PRD 内容。",
      });
      return;
    }

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate(),
    )}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `PRD_${timestamp}.md`;

    const cleanMarkdown = prdContent.replace(/<mark[^>]*>|<\/mark>/g, "");
    const blob = new Blob([cleanMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleSubmitRlhf = (score: number) => {
    if (hasSubmittedRlhf) {
      return;
    }
    setSelectedRlhfScore(score);
    setHasSubmittedRlhf(true);
    submitRlhfScore(score);
    toast({
      variant: "success",
      title: "感谢反馈",
      description: `已记录 ${score} 星评分，系统将持续优化输出质量。`,
    });
  };

  const handleJumpToHeading = (slug: string) => {
    const target = document.getElementById(slug);
    if (!target) {
      return;
    }

    let scrollParent: HTMLElement | null = target.parentElement;
    while (scrollParent) {
      const style = window.getComputedStyle(scrollParent);
      const canScrollY =
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollParent.scrollHeight > scrollParent.clientHeight;
      if (canScrollY) {
        break;
      }
      scrollParent = scrollParent.parentElement;
    }

    if (scrollParent) {
      const parentRect = scrollParent.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const nextTop =
        scrollParent.scrollTop + (targetRect.top - parentRect.top) - 96;
      scrollParent.scrollTo({ top: nextTop, behavior: "smooth" });
    } else {
      target.style.scrollMarginTop = "96px";
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    window.history.replaceState(null, "", `#${slug}`);
  };

  const triggerCriticReview = async (currentPrd: string) => {
    if (!currentPrd.trim() || !productCategory) {
      return;
    }

    setIsCriticLoading(true);
    setCriticSuggestions([]);
    setCriticSource(null);
    setCriticFallbackReason("");

    try {
      const response = await fetch("/api/critic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productCategory,
          prdMarkdown: currentPrd,
        }),
      });

      const payload = (await response.json()) as {
        source?: "rag" | "local" | "degraded";
        fallbackReason?: string;
        suggestions?: CriticSuggestion[];
      };

      setCriticSource(payload.source ?? "degraded");
      setCriticSuggestions((payload.suggestions ?? []).slice(0, 3));
      setCriticFallbackReason(payload.fallbackReason ?? "");
    } catch (error) {
      setCriticSource("degraded");
      setCriticSuggestions([
        {
          title: "审查服务暂不可用",
          rationale: error instanceof Error ? error.message : "Unknown critic error.",
          action: "请稍后重试或先继续手动优化 PRD。",
        },
      ]);
    } finally {
      setIsCriticLoading(false);
    }
  };

  const handleAdoptSuggestion = async (suggestion: CriticSuggestion) => {
    if (isGeneratingPrd || !productCategory || insights.length === 0) {
      return;
    }

    setIsGeneratingPrd(true);
    setPrdContent("");
    setSelectedRlhfScore(null);
    setHasSubmittedRlhf(false);
    setIsCriticLoading(false);
    setCriticSuggestions([]);
    setCriticSource(null);
    setCriticFallbackReason("");

    try {
      const response = await fetch("/api/generate-prd", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          insights,
          productCategory,
          enableSearch,
          basePrd: prdContent,
          evolutionSuggestion: `标题: ${suggestion.title}\n原因: ${suggestion.rationale}\n采纳动作: ${suggestion.action}`,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message || "PRD 重写失败。");
      }

      if (!response.body) {
        throw new Error("服务端未返回可读取流。");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let accumulated = "";

      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (!done && chunk.value) {
          accumulated += decoder.decode(chunk.value, { stream: true });
          setPrdContent(accumulated);
        }
      }

      accumulated += decoder.decode();
      if (!accumulated.trim()) {
        throw new Error("PRD 重写输出为空，请稍后重试。");
      }
      setPrdContent(accumulated);
      incrementPrds();
      toast({
        variant: "success",
        title: "PRD 已进化",
        description: "已采纳建议并完成重写。",
      });

      void triggerCriticReview(accumulated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PRD 重写失败。";
      toast({
        variant: "destructive",
        title: "重写失败",
        description: message,
      });
    } finally {
      setIsGeneratingPrd(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    console.log("--- Upload Step 1: onChange triggered ---", {
      hasFile: Boolean(file),
      fileName: file?.name ?? "",
      fileType: file?.type ?? "",
      fileSize: file?.size ?? 0,
    });
    if (!file) {
      return;
    }

    const lowerName = file.name.toLowerCase();
    const isCsvFile =
      file.type.includes("csv") || lowerName.endsWith(".csv");
    const isExcelFile =
      lowerName.endsWith(".xlsx") ||
      lowerName.endsWith(".xls") ||
      file.type.includes("spreadsheetml") ||
      file.type.includes("ms-excel");
    console.log("--- Upload Step 2: file type check ---", {
      isCsvFile,
      isExcelFile,
      lowerName,
    });

    if (!isCsvFile && !isExcelFile) {
      toast({
        variant: "destructive",
        title: "上传失败",
        description: INVALID_DATA_MESSAGE,
      });
      event.target.value = "";
      return;
    }

    setIsInspecting(true);
    console.log("--- Upload Step 3: setIsInspecting(true) ---");

    if (isCsvFile) {
      console.log("--- Upload Step 3A: entering CSV parser ---");
      Papa.parse<DataRow>(file, {
        header: true,
        skipEmptyLines: true,
        complete: async (result) => {
          console.log("--- Upload Step 3B: CSV parse complete ---", {
            fieldCount: result.meta.fields?.length ?? 0,
            rowCount: result.data?.length ?? 0,
          });
          try {
            const headers = normalizeHeaders(
              (result.meta.fields ?? [])
                .map((header) => header.trim())
                .filter(Boolean),
            );
            const rows = (result.data ?? []).filter(
              (row) => row && Object.keys(row).length > 0,
            );

            await runInspectPipeline(headers, rows, file.name);
          } catch (error) {
            console.error("--- Upload Step 3C: CSV pipeline error ---", error);
            const message =
              error instanceof Error ? error.message : INVALID_DATA_MESSAGE;
            resetWithError(message);
          } finally {
            setIsInspecting(false);
            event.target.value = "";
            console.log("--- Upload Step 3D: CSV flow finished ---");
          }
        },
        error: () => {
          setIsInspecting(false);
          event.target.value = "";
          console.error("--- Upload Step 3E: CSV parser error callback ---");
          resetWithError("CSV 读取失败，请确认文件内容后重试。");
        },
      });
      return;
    }

    console.log("--- Upload Step 3F: entering Excel parser ---");
    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      try {
        const arrayBuffer = loadEvent.target?.result;
        if (!(arrayBuffer instanceof ArrayBuffer)) {
          throw new Error(INVALID_DATA_MESSAGE);
        }

        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
          throw new Error(INVALID_DATA_MESSAGE);
        }

        const worksheet = workbook.Sheets[firstSheetName];
        const matrix = XLSX.utils.sheet_to_json<(string | number | boolean)[]>(
          worksheet,
          { header: 1, defval: "" },
        );

        if (matrix.length < 2) {
          throw new Error(INVALID_DATA_MESSAGE);
        }

        const [rawHeaders, ...dataRows] = matrix;
        const headers = normalizeHeaders(rawHeaders.map((cell) => toSafeString(cell)));
        const rows = dataRows
          .filter((row) => row.some((cell) => toSafeString(cell).length > 0))
          .map((row) => {
            const record: DataRow = {};
            headers.forEach((header, index) => {
              record[header] = row[index] ?? "";
            });
            return record;
          });

        await runInspectPipeline(headers, rows, file.name);
      } catch (error) {
        console.error("--- Upload Step 3G: Excel pipeline error ---", error);
        const message =
          error instanceof Error ? error.message : INVALID_DATA_MESSAGE;
        resetWithError(message);
      } finally {
        setIsInspecting(false);
        event.target.value = "";
        console.log("--- Upload Step 3H: Excel flow finished ---");
      }
    };

    reader.onerror = () => {
      setIsInspecting(false);
      event.target.value = "";
      console.error("--- Upload Step 3I: Excel read error callback ---");
      resetWithError("Excel 读取失败，请确认文件内容后重试。");
    };

    reader.readAsArrayBuffer(file);
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-foreground">
      <Toaster richColors position="top-right" />
      <main className="px-4 py-6 md:px-8">
        <div className="mx-auto flex w-full max-w-[1560px] gap-6">
          <aside className="sticky top-6 hidden h-[calc(100vh-3rem)] w-72 shrink-0 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-100/80 p-5 shadow-sm lg:block">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Pipeline Navigator
            </p>
            <div className="mt-4 space-y-2">
              {pipelineSteps.map((step, index) => {
                const stepNumber = index + 1;
                const isReached = stepNumber <= currentStep;
                const isActive = stepNumber === currentStep;
                return (
                  <div
                    key={step}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm transition",
                      isActive
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : isReached
                          ? "border-zinc-300 bg-white text-zinc-700"
                          : "border-zinc-200 bg-zinc-50 text-zinc-400",
                    )}
                  >
                    {step}
                  </div>
                );
              })}
            </div>

            {prdHeadings.length > 0 && (
              <div className="mt-8">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  PRD 动态大纲
                </p>
                <div className="mt-3 space-y-1">
                  {prdHeadings.map((heading) => (
                    <button
                      key={heading.slug}
                      type="button"
                      onClick={() => handleJumpToHeading(heading.slug)}
                      className={cn(
                        "w-full rounded-md px-2 py-1 text-left text-sm text-zinc-600 transition hover:bg-white hover:text-zinc-900",
                        heading.level === 3 && "pl-5 text-xs",
                      )}
                    >
                      {heading.text}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <div className="min-w-0 flex-1">
            <div className="mx-auto flex w-full max-w-[1220px] flex-col gap-8">
              <header className="space-y-2">
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                  Enterprise Dashboard
                </p>
                <h2 className="text-2xl font-semibold text-zinc-900 md:text-3xl">
                  全自动智能体产品需求生成系统
                </h2>
              </header>

              <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {stats.map((stat) => (
                  <Card
                    key={stat.label}
                    className="rounded-xl border border-zinc-200 bg-white shadow-sm"
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-zinc-400">
                        {stat.label}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-3xl font-semibold tracking-tight text-zinc-900">
                        {stat.value}
                      </p>
                      <p className="mt-2 text-sm text-zinc-400">{stat.trend}</p>
                    </CardContent>
                  </Card>
                ))}
              </section>
              <p className="text-xs text-zinc-500">* 数据基于分层抽样规则</p>

              <section>
                <Card className="rounded-xl border border-zinc-200 bg-white shadow-sm">
                  <CardContent className="flex min-h-[320px] flex-col items-center justify-center gap-6 text-center">
                    <div className="rounded-full border border-zinc-200 bg-white p-4">
                      <FileSpreadsheet className="h-8 w-8 text-sky-600" />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-xl font-semibold text-zinc-900">
                        上传评论数据集 (CSV / Excel)
                      </h3>
                      <p className="max-w-md text-sm text-zinc-400">
                        上传后将自动进行 AI 前置风控、语义字段映射与样本抽取，为多智能体分析准备标准输入。
                      </p>
                      <a
                        href="/data/amazon_sample.csv"
                        download
                        className="inline-flex items-center text-sm font-medium text-sky-600 underline-offset-4 hover:underline"
                      >
                        下载示例数据集（amazon_sample.csv）
                      </a>
                    </div>
                    <label
                      htmlFor={FILE_INPUT_ID}
                      aria-disabled={isInspecting}
                      className={cn(
                        buttonVariants(),
                        "cursor-pointer rounded-md bg-zinc-900 text-white shadow-sm hover:bg-zinc-800",
                        isInspecting && "cursor-not-allowed bg-zinc-400 text-zinc-200",
                      )}
                      onClick={(event) => {
                        if (isInspecting) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        <UploadCloud className="h-4 w-4" />
                        {isInspecting ? "AI 质检中..." : "选择 CSV/Excel 文件"}
                      </span>
                    </label>
                    <details className="w-full max-w-xl rounded-lg border border-zinc-200 bg-white p-4 text-left">
                      <summary className="cursor-pointer text-sm font-medium text-zinc-700">
                        查看数据格式要求
                      </summary>
                      <p className="mt-2 text-xs leading-6 text-zinc-400">
                        支持 CSV / Excel（.xlsx, .xls），且至少需包含可映射到{" "}
                        <code className="rounded bg-zinc-100 px-1 py-0.5">content</code>
                        的列；系统会自动识别并映射{" "}
                        <code className="rounded bg-zinc-100 px-1 py-0.5">rating</code>
                        、<code className="rounded bg-zinc-100 px-1 py-0.5">date</code>、
                        <code className="rounded bg-zinc-100 px-1 py-0.5">content</code> 字段。
                      </p>
                    </details>
                    <input
                      id={FILE_INPUT_ID}
                      type="file"
                      accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="sr-only"
                      onClick={(event) => {
                        // Ensure selecting the same file still triggers onChange.
                        event.currentTarget.value = "";
                      }}
                      onChange={handleFileChange}
                    />
                  </CardContent>
                </Card>
              </section>

              {reviews.length > 0 && (
                <section>
                  <Card className="rounded-xl border border-zinc-200 bg-white shadow-sm">
                    <CardHeader className="flex flex-row items-center justify-between gap-4">
                      <div>
                        <CardTitle className="text-zinc-900">数据预览</CardTitle>
                        <p className="mt-1 text-sm text-zinc-400">
                          当前文件：{fileName}（共 {reviews.length} 条）
                        </p>
                        <Badge className="mt-3 inline-flex items-center gap-1 bg-emerald-500/20 text-emerald-300">
                          <BadgeCheck className="h-3.5 w-3.5" />
                          当前识别产品：{productCategory}
                        </Badge>
                      </div>
                      <Button
                        className="bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-70"
                        onClick={handleStartAnalysis}
                        disabled={isAnalyzing}
                      >
                        <Sparkles className="h-4 w-4" />
                        {isAnalyzing ? "挖掘中..." : "1. 挖掘真实用户痛点"}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-24">Rating</TableHead>
                            <TableHead className="w-40">Date</TableHead>
                            <TableHead>Content</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {reviews.slice(0, 20).map((row, index) => (
                            <TableRow key={`${row.date}-${index}`}>
                              <TableCell>{row.rating}</TableCell>
                              <TableCell>{row.date}</TableCell>
                              <TableCell className="max-w-xl truncate">
                                {row.content}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </section>
              )}

              {insights.length > 0 && (
                <section>
                  <Card className="rounded-xl border border-zinc-200 bg-white shadow-sm">
                    <CardHeader>
                      <CardTitle className="text-zinc-900">洞察看板 (Insights Board)</CardTitle>
                      <p className="text-sm text-zinc-400">以下痛点均由真实用户评价片段支撑。</p>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-4">
                        {insights.map((insight) => (
                          <Card key={insight.title} className="rounded-xl border border-zinc-200 bg-white shadow-sm">
                            <CardHeader className="pb-2">
                              <CardTitle className="text-base text-zinc-900">
                                {insight.title}
                              </CardTitle>
                              <p className="text-sm text-zinc-600">{insight.description}</p>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              {insight.quotes.slice(0, 2).map((quote, index) => (
                                <blockquote
                                  key={`${insight.title}-${index}`}
                                  className="border-l-2 border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-zinc-700"
                                >
                                  “{quote}”
                                </blockquote>
                              ))}
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                      <div className="mt-5 rounded-lg border border-cyan-200 bg-cyan-50 p-3">
                        <label className="flex cursor-pointer items-center justify-between gap-4">
                          <span className="text-sm font-medium text-cyan-700">
                            🌐 开启全网竞品检索 (MI Probe)
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-cyan-600"
                            checked={enableSearch}
                            onChange={(event) => setEnableSearch(event.target.checked)}
                            disabled={isGeneratingPrd}
                          />
                        </label>
                      </div>
                      <div className="mt-5">
                        <Button
                          onClick={handleGeneratePrd}
                          disabled={isGeneratingPrd}
                          className="w-full bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-500"
                        >
                          {isGeneratingPrd
                            ? "正在撰写 PRD..."
                            : "2. 基于上述真实洞察生成 PRD"}
                        </Button>
                      </div>
                      {(isGeneratingPrd || prdContent) && (
                        <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
                          <div className="mb-4 flex justify-end">
                            <Button
                              type="button"
                              onClick={handleExportMarkdown}
                              disabled={!prdContent.trim()}
                              className="rounded-md bg-zinc-900 text-white shadow-sm hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-500"
                            >
                              ⬇️ 导出为 Markdown
                            </Button>
                          </div>
                          <PrdMarkdown
                            content={prdContent}
                            isStreaming={isGeneratingPrd}
                          />
                          <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                            <p className="text-sm font-semibold text-zinc-800">
                              Dual-Track Critic 审查面板
                            </p>
                            {isCriticLoading ? (
                              <p className="mt-2 text-sm text-zinc-500">Agent 正在审查中...</p>
                            ) : criticSuggestions.length > 0 ? (
                              <div className="mt-3 space-y-3">
                                {criticSuggestions.map((item, index) => (
                                  <div
                                    key={`${item.title}-${index}`}
                                    className="rounded-md border border-zinc-200 bg-white p-3"
                                  >
                                    <p className="text-sm font-medium text-zinc-900">
                                      {index + 1}. {item.title}
                                    </p>
                                    <p className="mt-1 text-xs text-zinc-500">{item.rationale}</p>
                                    <p className="mt-2 text-sm text-zinc-700">{item.action}</p>
                                    <div className="mt-3">
                                      <Button
                                        type="button"
                                        onClick={() => handleAdoptSuggestion(item)}
                                        disabled={isGeneratingPrd}
                                        className="h-8 rounded-md bg-zinc-900 px-3 text-xs text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-500"
                                      >
                                        采纳并进化
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                                {criticSource && (
                                  <p className="text-xs text-zinc-500">
                                    当前建议来源: {criticSource}
                                    {criticFallbackReason
                                      ? `（已降级: ${criticFallbackReason}）`
                                      : ""}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="mt-2 text-sm text-zinc-500">
                                PRD 生成完成后将自动触发 Critic 审查。
                              </p>
                            )}
                          </div>
                          {!isGeneratingPrd && prdContent.trim() && (
                            <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                              <p className="text-sm font-medium text-zinc-800">
                                这份 PRD 对你有帮助吗？请给一个质量评分
                              </p>
                              <div className="mt-3 flex items-center gap-2">
                                {[1, 2, 3, 4, 5].map((score) => {
                                  const active =
                                    (selectedRlhfScore ?? 0) >= score;
                                  return (
                                    <button
                                      key={score}
                                      type="button"
                                      onClick={() => handleSubmitRlhf(score)}
                                      disabled={hasSubmittedRlhf}
                                      className="rounded p-1 transition hover:bg-zinc-100 disabled:cursor-not-allowed"
                                      aria-label={`提交 ${score} 星评分`}
                                    >
                                      <Star
                                        className={cn(
                                          "h-5 w-5",
                                          active
                                            ? "fill-amber-400 text-amber-500"
                                            : "text-zinc-300",
                                        )}
                                      />
                                    </button>
                                  );
                                })}
                              </div>
                              {hasSubmittedRlhf && (
                                <p className="mt-2 text-xs text-emerald-600">感谢反馈</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </section>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

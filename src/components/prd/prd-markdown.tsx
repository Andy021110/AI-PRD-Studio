"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";

import { generateSlug } from "@/lib/markdown/headings";
import { cn } from "@/lib/utils";
import { PRD_PROSE_CLASS } from "@/lib/markdown/prose";

type PrdMarkdownProps = {
  content: string;
  baselineContent?: string;
  isStreaming?: boolean;
  className?: string;
};

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
};

type MermaidBlockProps = {
  chart: string;
  isStreaming: boolean;
};

let mermaidInitialized = false;

function flattenText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => flattenText(item)).join("");
  }
  if (!node || typeof node !== "object") {
    return "";
  }
  if (!("props" in node)) {
    return "";
  }

  const candidate = node as { props?: { children?: ReactNode } };
  return flattenText(candidate.props?.children);
}

function isErrorSvg(svg: string) {
  const normalized = svg.toLowerCase();
  return (
    normalized.includes("syntax error in text") ||
    normalized.includes("parse error") ||
    normalized.includes("lexical error")
  );
}

function isLikelyMermaidSnippet(raw: string) {
  const firstLine = raw.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
  return (
    firstLine === "pie" ||
    firstLine.startsWith("pie ") ||
    firstLine.startsWith("flowchart") ||
    firstLine.startsWith("graph ")
  );
}

function sanitizeMermaidChart(rawChart: string) {
  const lines = rawChart
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return rawChart.trim();
  }

  const header = lines[0].toLowerCase();
  if (header === "pie" || header.startsWith("pie ")) {
    const result: string[] = [];
    const titleLine = lines.find(
      (line, index) => index > 0 && line.toLowerCase().startsWith("title "),
    );

    if (titleLine) {
      result.push(`pie ${titleLine}`);
    } else {
      result.push(lines[0]);
    }

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.toLowerCase().startsWith("title ")) {
        continue;
      }

      // Normalize common model slip: "Label = 30" -> "Label : 30".
      if (line.includes("=") && !line.includes(":")) {
        result.push(line.replace("=", ":"));
        continue;
      }

      result.push(line);
    }

    return result.join("\n");
  }

  return lines.join("\n");
}

function normalizeCollapsedTableLine(line: string) {
  const pipeCount = (line.match(/\|/g) ?? []).length;
  if (pipeCount < 6 || !line.includes("||")) {
    return line;
  }

  const firstPipe = line.indexOf("|");
  if (firstPipe < 0) {
    return line;
  }

  const leadText = line.slice(0, firstPipe).trim();
  const tableText = line
    .slice(firstPipe)
    .replace(/\s*\|\|\s*/g, "\n|")
    .trim();

  const rows = tableText
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => (row.startsWith("|") ? row : `| ${row}`))
    .map((row) => (row.endsWith("|") ? row : `${row} |`));

  if (rows.length === 0) {
    return line;
  }

  const headerCells = rows[0]
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (headerCells.length < 2) {
    return line;
  }

  if (rows.length === 1 || !/^\|\s*:?-{2,}/.test(rows[1])) {
    const separator = `| ${headerCells.map(() => "---").join(" | ")} |`;
    rows.splice(1, 0, separator);
  }

  const tableBlock = rows.join("\n");
  return leadText ? `${leadText}\n\n${tableBlock}` : tableBlock;
}

function normalizeMarkdownForRender(rawContent: string) {
  return rawContent
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeCollapsedTableLine(line))
    .join("\n");
}

function stripMarkTags(raw: string) {
  return raw.replace(/<mark[^>]*>|<\/mark>/g, "");
}

function isHighlightableParagraph(paragraph: string) {
  const trimmed = paragraph.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes("```")) {
    return false;
  }

  return !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\|)/.test(trimmed);
}

function applyIterationHighlights(currentContent: string, baselineContent?: string) {
  const cleanCurrent = stripMarkTags(currentContent);
  if (!baselineContent?.trim()) {
    return cleanCurrent;
  }

  if (currentContent.includes("<mark")) {
    // Respect backend-provided marks when present.
    return currentContent;
  }

  const baselineParagraphs = new Set(
    stripMarkTags(baselineContent)
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean),
  );

  const currentParagraphs = cleanCurrent.split(/\n{2,}/);
  return currentParagraphs
    .map((paragraph) => {
      const normalized = paragraph.trim();
      if (!normalized || !isHighlightableParagraph(paragraph)) {
        return paragraph;
      }
      if (baselineParagraphs.has(normalized)) {
        return paragraph;
      }
      return `<mark class="diff-highlight">${paragraph}</mark>`;
    })
    .join("\n\n");
}

function looksIncompleteMermaid(chart: string) {
  const trimmed = chart.trim();
  if (!trimmed) {
    return true;
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return true;
  }

  const header = lines[0].toLowerCase();
  if (header === "pie" || header.startsWith("pie ")) {
    const rows = lines.slice(1).filter((line) => line.includes(":"));
    return rows.length < 2;
  }

  if (header.startsWith("flowchart")) {
    return !lines.some((line) => line.includes("-->"));
  }

  return false;
}

function MermaidBlock({ chart, isStreaming }: MermaidBlockProps) {
  const [svg, setSvg] = useState("");
  const [hasError, setHasError] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const latestValidSvgRef = useRef("");
  const mermaidId = useId().replace(/:/g, "");
  const sanitizedChart = sanitizeMermaidChart(chart);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const runSafeRender = async () => {
      if (isStreaming && looksIncompleteMermaid(sanitizedChart)) {
        setIsPending(true);
        setHasError(false);
        return;
      }

      try {
        const { default: mermaid } = await import("mermaid");

        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: "neutral",
            suppressErrorRendering: true,
          });
          mermaidInitialized = true;
        }

        await mermaid.parse(sanitizedChart);
        const renderId = `prd-mermaid-${mermaidId}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await mermaid.render(renderId, sanitizedChart);
        if (cancelled) {
          return;
        }

        if (isErrorSvg(result.svg)) {
          throw new Error("Mermaid returned error SVG.");
        }

        latestValidSvgRef.current = result.svg;
        setSvg(result.svg);
        setHasError(false);
        setIsPending(false);
      } catch {
        if (cancelled) {
          return;
        }

        setHasError(true);
        setIsPending(isStreaming && looksIncompleteMermaid(sanitizedChart));

        // Preserve the last valid chart to avoid permanent downgrade
        // when stream chunks are temporarily invalid/incomplete.
        if (latestValidSvgRef.current) {
          setSvg(latestValidSvgRef.current);
        } else if (!isStreaming) {
          setSvg("");
        }
      }
    };

    setIsPending(isStreaming);
    setHasError(false);
    debounceTimer = setTimeout(() => {
      void runSafeRender();
    }, 180);

    return () => {
      cancelled = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [mermaidId, sanitizedChart, isStreaming]);

  if (isPending) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }

  if (hasError || !svg) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <div
      className="my-6 w-full overflow-x-auto rounded-lg border border-zinc-200 bg-white p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function PrdMarkdown({
  content,
  baselineContent,
  isStreaming = false,
  className,
}: PrdMarkdownProps) {
  const displayContent = useMemo(
    () =>
      normalizeMarkdownForRender(
        applyIterationHighlights(content, isStreaming ? undefined : baselineContent),
      ),
    [baselineContent, content, isStreaming],
  );
  const fallbackText = isStreaming
    ? "正在生成结构化 PRD，请稍候..."
    : "暂无可展示的 PRD 内容。";
  const markdownComponents = useMemo<Components>(() => {
    const seenHeadingSlugs = new Map<string, number>();
    const createHeadingId = (children: ReactNode) => {
      const text = flattenText(children).trim();
      const base = generateSlug(text) || "section";
      const nextCount = (seenHeadingSlugs.get(base) ?? 0) + 1;
      seenHeadingSlugs.set(base, nextCount);
      return nextCount === 1 ? base : `${base}-${nextCount}`;
    };

    return {
      table: ({
        className: tableClassName,
        ...props
      }: ComponentPropsWithoutRef<"table">) => (
        <div className="my-6 w-full overflow-x-auto rounded-lg border border-zinc-200">
          <table
            className={cn("w-full border-collapse text-sm", tableClassName)}
            {...props}
          />
        </div>
      ),
      h2: ({ children, ...props }: ComponentPropsWithoutRef<"h2">) => (
        <h2
          {...props}
          id={createHeadingId(children)}
          className={cn("scroll-mt-24", props.className)}
        >
          {children}
        </h2>
      ),
      h3: ({ children, ...props }: ComponentPropsWithoutRef<"h3">) => (
        <h3
          {...props}
          id={createHeadingId(children)}
          className={cn("scroll-mt-24", props.className)}
        >
          {children}
        </h3>
      ),
      code: ({
        className: codeClassName,
        inline,
        children,
        ...props
      }: MarkdownCodeProps) => {
        const chart = String(children).trim();
        const shouldUseMermaid =
          !inline &&
          (codeClassName?.includes("language-mermaid") ||
            isLikelyMermaidSnippet(chart));

        if (shouldUseMermaid) {
          return <MermaidBlock chart={chart} isStreaming={isStreaming} />;
        }

        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        );
      },
    };
  }, [isStreaming]);

  return (
    <div className={cn(PRD_PROSE_CLASS, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={markdownComponents}
      >
        {displayContent.trim() || fallbackText}
      </ReactMarkdown>
    </div>
  );
}


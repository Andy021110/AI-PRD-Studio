"use client";

import { useEffect, useId, useMemo, useState } from "react";
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
  const [failed, setFailed] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const mermaidId = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const renderChart = async (attempt = 0) => {
      if (isStreaming && looksIncompleteMermaid(chart)) {
        setIsPending(true);
        setFailed(false);
        setSvg("");
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

        const result = await mermaid.render(`prd-mermaid-${mermaidId}`, chart);
        if (!cancelled) {
          if (isErrorSvg(result.svg)) {
            throw new Error("Mermaid returned error SVG.");
          }
          setSvg(result.svg);
          setFailed(false);
          setIsPending(false);
        }
      } catch {
        if (cancelled) {
          return;
        }

        if (isStreaming && attempt < 4) {
          setIsPending(true);
          timer = setTimeout(() => {
            void renderChart(attempt + 1);
          }, 220 * (attempt + 1));
          return;
        }

        setFailed(true);
        setIsPending(false);
        setSvg("");
      }
    };

    setIsPending(isStreaming);
    setFailed(false);
    setSvg("");
    void renderChart();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [chart, mermaidId, isStreaming]);

  if (isPending) {
    return (
      <pre>
        <code>{chart}</code>
      </pre>
    );
  }

  if (failed || !svg) {
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
  isStreaming = false,
  className,
}: PrdMarkdownProps) {
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
      code: ({ className: codeClassName, children, ...props }: MarkdownCodeProps) => {
        if (codeClassName?.includes("language-mermaid")) {
          const chart = String(children).trim();
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
        {content.trim() || fallbackText}
      </ReactMarkdown>
    </div>
  );
}


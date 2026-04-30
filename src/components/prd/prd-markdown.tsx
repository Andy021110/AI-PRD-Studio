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
};

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

function MermaidBlock({ chart }: MermaidBlockProps) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const mermaidId = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;

    const renderChart = async () => {
      try {
        const { default: mermaid } = await import("mermaid");

        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          suppressErrorRendering: true,
        });

        const result = await mermaid.render(`prd-mermaid-${mermaidId}`, chart);
        if (!cancelled) {
          if (isErrorSvg(result.svg)) {
            setFailed(true);
            setSvg("");
            return;
          }
          setSvg(result.svg);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          setSvg("");
        }
      }
    };

    void renderChart();

    return () => {
      cancelled = true;
    };
  }, [chart, mermaidId]);

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
          return <MermaidBlock chart={chart} />;
        }

        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        );
      },
    };
  }, [content]);

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


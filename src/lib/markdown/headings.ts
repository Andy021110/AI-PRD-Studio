export type MarkdownHeading = {
  level: 2 | 3;
  text: string;
  slug: string;
};

export function generateSlug(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~()[\]{}<>]/g, "")
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeHeadingText(raw: string) {
  return raw
    .replace(/\s#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const seen = new Map<string, number>();
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    const match = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const level = match[1].length as 2 | 3;
    const text = normalizeHeadingText(match[2]);
    if (!text) {
      continue;
    }

    const base = generateSlug(text) || "section";
    const nextCount = (seen.get(base) ?? 0) + 1;
    seen.set(base, nextCount);
    const slug = nextCount === 1 ? base : `${base}-${nextCount}`;

    headings.push({ level, text, slug });
  }

  return headings;
}


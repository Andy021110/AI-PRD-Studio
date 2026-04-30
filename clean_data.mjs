import fs from "node:fs";
import path from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import csv from "csv-parser";

const DATA_DIR = path.resolve("data");
const OUTPUT_DIR = path.resolve("public");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "sample_reviews.json");
const TARGET_SAMPLE_SIZE = 500;

function pickFirstNonEmpty(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) {
      const normalized = String(value).trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return "";
}

function parseCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

async function main() {
  console.log("🚀 开始执行亚马逊评论数据清洗流水线...");

  const files = await readdir(DATA_DIR);
  const csvFiles = files
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .map((name) => path.join(DATA_DIR, name));

  if (csvFiles.length === 0) {
    throw new Error("未在 data/ 目录找到任何 CSV 文件。");
  }

  console.log(`📦 发现 ${csvFiles.length} 个 CSV 文件，开始解析...`);

  let rawCount = 0;
  const allCleanRows = [];

  for (const filePath of csvFiles) {
    const fileName = path.basename(filePath);
    const rows = await parseCsvFile(filePath);
    rawCount += rows.length;

    let fileCleanCount = 0;
    for (const row of rows) {
      const ratingRaw = pickFirstNonEmpty(row, ["reviews.rating", "rating"]);
      const date = pickFirstNonEmpty(row, ["reviews.date", "date"]);
      const content = pickFirstNonEmpty(row, [
        "reviews.text",
        "text",
        "reviews.title",
      ]);

      const rating = Number.parseFloat(ratingRaw);
      const isValid =
        Number.isFinite(rating) && content.trim().length >= 10 && ratingRaw !== "";

      if (!isValid) {
        continue;
      }

      allCleanRows.push({
        rating,
        date,
        content: content.trim(),
      });
      fileCleanCount += 1;
    }

    console.log(
      `🧹 ${fileName} 解析完成：原始 ${rows.length} 条，清洗后 ${fileCleanCount} 条。`,
    );
  }

  if (allCleanRows.length === 0) {
    throw new Error("清洗后无可用数据，请检查原始 CSV 字段映射。");
  }

  shuffleInPlace(allCleanRows);
  const finalSampleSize = Math.min(TARGET_SAMPLE_SIZE, allCleanRows.length);
  const sampled = allCleanRows.slice(0, finalSampleSize);

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(sampled, null, 2), "utf8");

  if (finalSampleSize < TARGET_SAMPLE_SIZE) {
    console.log(
      `⚠️ 清洗后仅有 ${allCleanRows.length} 条有效数据，已输出全部可用样本到 ${OUTPUT_FILE}。`,
    );
  } else {
    console.log(
      `✅ 成功从 ${rawCount} 条原始数据中抽取并清洗出 ${finalSampleSize} 条优质样本，已写入 public 目录。`,
    );
  }

  console.log(`📄 输出文件：${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("❌ 数据清洗流程失败：", error.message);
  process.exitCode = 1;
});

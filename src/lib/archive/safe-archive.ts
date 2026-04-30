import fs from "fs/promises";
import path from "path";

function safeProductName(productCategory: string) {
  return (
    productCategory.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_") || "Unknown_Product"
  );
}

function nowTimestamp() {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isLikelyServerlessRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_REGION ||
      process.env.AWS_EXECUTION_ENV ||
      process.env.LAMBDA_TASK_ROOT,
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isReadonlyFsLikeError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = "code" in error ? String(error.code) : "";
  if (["EROFS", "EACCES", "EPERM"].includes(maybeCode)) {
    return true;
  }

  const message = toErrorMessage(error);
  return (
    message.includes("/var/task/") ||
    message.includes("\\var\\task\\") ||
    message.includes("read-only file system")
  );
}

function logArchiveSkip(reason: string, details?: string) {
  console.warn(
    `[archive] skip persistence: ${reason}${details ? ` | ${details}` : ""}`,
  );
}

export async function resolveArchiveDir(
  productCategory: string,
  options?: { reuseLatestByProduct?: boolean },
): Promise<string | null> {
  if (isLikelyServerlessRuntime()) {
    logArchiveSkip("serverless runtime detected");
    return null;
  }

  const outputsRoot = path.join(process.cwd(), "outputs");
  const safeName = safeProductName(productCategory);

  try {
    await fs.mkdir(outputsRoot, { recursive: true });
  } catch (error) {
    logArchiveSkip("cannot create outputs root", toErrorMessage(error));
    return null;
  }

  if (options?.reuseLatestByProduct) {
    try {
      const entries = await fs.readdir(outputsRoot, { withFileTypes: true });
      const matched = entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${safeName}`))
        .map((entry) => entry.name)
        .sort()
        .reverse();

      if (matched.length > 0) {
        return path.join(outputsRoot, matched[0]);
      }
    } catch (error) {
      if (!isReadonlyFsLikeError(error)) {
        logArchiveSkip("cannot read outputs root", toErrorMessage(error));
      }
      return null;
    }
  }

  const folderName = `${nowTimestamp()}_${safeName}`;
  const outputDir = path.join(outputsRoot, folderName);

  try {
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
  } catch (error) {
    logArchiveSkip("cannot create archive dir", toErrorMessage(error));
    return null;
  }
}

export async function writeArchiveFile(
  outputDir: string | null,
  fileName: string,
  content: string,
) {
  if (!outputDir) {
    logArchiveSkip(`missing output dir for ${fileName}`);
    return;
  }

  try {
    await fs.writeFile(path.join(outputDir, fileName), content, "utf-8");
  } catch (error) {
    if (!isReadonlyFsLikeError(error)) {
      logArchiveSkip(`write failed for ${fileName}`, toErrorMessage(error));
      return;
    }
    logArchiveSkip(`readonly fs for ${fileName}`, toErrorMessage(error));
  }
}

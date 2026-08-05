import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setClipboard } from "../../ink/termio/osc.js";
import type { LocalJSXCommandCall } from "../../types/command.js";
import { getCwd } from "../../utils/cwd.js";
import { execFileNoThrowWithCwd } from "../../utils/execFileNoThrow.js";
import { sideQuery } from "../../utils/sideQuery.js";
import { generateContinuationPrompt } from "./generator.js";
import { buildContinuationSource } from "./source.js";

const FALLBACK_DIR = join(tmpdir(), "mindcode");
const FALLBACK_FILE = "continuation-prompt.md";

async function gitSnapshot(cwd: string): Promise<{
  root?: string;
  status: string;
  diffStat: string;
}> {
  const [status, diffStat] = await Promise.all([
    execFileNoThrowWithCwd("git", ["status", "--short"], {
      cwd,
      timeout: 5_000,
    }),
    execFileNoThrowWithCwd("git", ["diff", "--stat"], { cwd, timeout: 5_000 }),
  ]);
  const rootResult = await execFileNoThrowWithCwd(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd, timeout: 5_000 },
  );
  return {
    root: rootResult.code === 0 ? rootResult.stdout.trim() : undefined,
    status: status.code === 0 ? status.stdout : "not a Git repository",
    diffStat: diffStat.code === 0 ? diffStat.stdout : "not a Git repository",
  };
}

async function copyAndPersist(text: string): Promise<string> {
  const fallbackPath = join(FALLBACK_DIR, FALLBACK_FILE);
  await mkdir(FALLBACK_DIR, { recursive: true });
  await writeFile(fallbackPath, text, "utf8");
  try {
    const clipboardOutput = await setClipboard(text);
    if (clipboardOutput) process.stdout.write(clipboardOutput);
    return `Continuation prompt скопирован в clipboard. Резервная копия: ${fallbackPath}`;
  } catch {
    return `Clipboard недоступен. Continuation prompt сохранён: ${fallbackPath}`;
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  if (context.messages.length === 0) {
    onDone("Нельзя создать continuation prompt: текущая сессия пуста");
    return null;
  }

  try {
    const cwd = getCwd();
    const git = await gitSnapshot(cwd);
    const source = buildContinuationSource({
      messages: context.messages,
      cwd,
      repoRoot: git.root,
      gitStatus: git.status,
      gitDiffStat: git.diffStat,
      focus: args.trim(),
    });
    const prompt = await generateContinuationPrompt(
      source,
      args.trim(),
      sideQuery,
      context.abortController.signal,
    );
    onDone(await copyAndPersist(prompt), { display: "system" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onDone(
      `Не удалось создать continuation prompt через GPT-5.6 Luna: ${message}`,
    );
  }
  return null;
};

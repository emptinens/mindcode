import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "../../types/message.js";
import { redactSecrets } from "../../utils/secretRedaction.js";

export { redactSecrets } from "../../utils/secretRedaction.js";

export const COPYCON_MAX_SOURCE_CHARS = 18_000;
export const COPYCON_MAX_MESSAGE_CHARS = 1_800;
export const COPYCON_MAX_OUTPUT_CHARS = 24_000;
const MAX_MESSAGES = 12;

export function limitText(value: string, maxChars: number): string {
  const text = value.trim();
  return text.length <= maxChars
    ? text
    : `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()} … [truncated]`;
}

function messageText(message: UserMessage | AssistantMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  return extractContentText(content);
}

export function extractContentText(content: unknown, separator = "\n"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(separator);
}

export type ContinuationSourceInput = {
  messages: Message[];
  cwd: string;
  repoRoot?: string;
  gitStatus?: string;
  gitDiffStat?: string;
  focus?: string;
};

export function buildContinuationSource(
  input: ContinuationSourceInput,
): string {
  const meaningfulMessages = input.messages
    .filter(
      (message): message is UserMessage | AssistantMessage =>
        (message.type === "user" && message.isMeta !== true) ||
        (message.type === "assistant" && !message.isApiErrorMessage),
    )
    .map((message) => ({
      role: message.type === "user" ? "Пользователь" : "MindCode",
      text: limitText(messageText(message), COPYCON_MAX_MESSAGE_CHARS),
      isOriginalUser:
        message.type === "user" && message.isCompactSummary !== true,
      isCompactSummary:
        message.type === "user" && message.isCompactSummary === true,
    }))
    .filter((message) => message.text.length > 0);

  const selected = meaningfulMessages.slice(-MAX_MESSAGES);

  const firstUser = meaningfulMessages.find(
    (message) => message.isOriginalUser,
  );
  const compactSummary = meaningfulMessages.findLast(
    (message) => message.isCompactSummary,
  );
  const assistantDecisions = selected
    .filter((message) => message.role === "MindCode")
    .slice(-3)
    .map((message) => message.text)
    .join("\n");

  const lines = [
    "Тип: ограниченный structured source для продолжения сессии MindCode",
    `Задача сессии: ${limitText(firstUser?.text || "не определена", 1_800)}`,
    `Последний compact summary:\n${limitText(compactSummary?.text || "отсутствует", 3_600)}`,
    `Решения/выводы MindCode:\n${limitText(assistantDecisions || "не определены", 3_600)}`,
    `Рабочая директория: ${input.cwd}`,
    `Корень Git-репозитория: ${input.repoRoot ?? "не обнаружен"}`,
    `Git status:\n${limitText(input.gitStatus || "недоступен", 2_400)}`,
    `Git diff --stat:\n${limitText(input.gitDiffStat || "недоступен", 2_400)}`,
    `Фокус пользователя: ${limitText(input.focus || "не задан", 800)}`,
    "Проверки и незавершённые шаги: извлечь только из приведённых существенных сообщений; повторно проверить перед продолжением.",
    "Последние существенные сообщения (без tool dumps):",
    ...selected.map((message) => `${message.role}: ${message.text}`),
    "Правило: восстановить незавершённую работу по этому source, перепроверить состояние файлов и продолжить с ближайшего шага.",
  ];

  return limitText(redactSecrets(lines.join("\n")), COPYCON_MAX_SOURCE_CHARS);
}

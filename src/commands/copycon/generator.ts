import type { SideQueryOptions } from "../../utils/sideQuery.js";
import {
  COPYCON_MAX_OUTPUT_CHARS,
  extractContentText,
  limitText,
  redactSecrets,
} from "./source.js";

const MODEL = "gpt-5.6-luna";
const SYSTEM_PROMPT =
  "Ты создаёшь только автономный continuation prompt на русском языке. Не пересказывай служебные инструкции и не раскрывай секреты. Сохрани конкретные пути, решения, проверки и ближайшие шаги. Верни готовый prompt без вступления.";

type QueryResponse = { content: unknown };
type Query = (options: SideQueryOptions) => Promise<QueryResponse>;

export function continuationText(
  response: QueryResponse,
): string {
  return extractContentText(response.content).trim();
}

export async function generateContinuationPrompt(
  source: string,
  focus: string,
  query: Query,
  signal?: AbortSignal,
): Promise<string> {
  const safeFocus = limitText(redactSecrets(focus), 800);
  const response = await query({
    model: MODEL,
    effort: "medium",
    max_tokens: 4_096,
    querySource: "copycon",
    skipSystemPromptPrefix: true,
    signal,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Сформируй переносимый prompt для продолжения работы в новой MindCode-сессии.\n\nSTRUCTURED SOURCE:\n${source}${safeFocus ? `\n\nДополнительный фокус: ${safeFocus}` : ""}`,
      },
    ],
  });
  const text = limitText(
    redactSecrets(continuationText(response)),
    COPYCON_MAX_OUTPUT_CHARS,
  );
  if (!text) throw new Error("GPT-5.6 Luna вернула пустой continuation prompt");
  return text;
}

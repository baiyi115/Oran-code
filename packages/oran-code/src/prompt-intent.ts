const CASUAL_PROMPT_PATTERNS = [
  /^(?:hi|hello|hey|hiya|yo|good\s+(?:morning|afternoon|evening))[\s.!?~]*$/i,
  /^(?:thanks|thank\s+you|thx|ty)[\s.!?~]*$/i,
  /^(?:bye|goodbye|see\s+you)[\s.!?~]*$/i,
  /^(?:who\s+are\s+you|what\s+can\s+you\s+do)[\s.!?~]*$/i,
  /^(?:你好|您好|嗨|哈喽|在吗|早上好|下午好|晚上好)[\s！!。.?？~～]*$/,
  /^(?:谢谢|多谢|感谢|好的?谢谢)[\s！!。.?？~～]*$/,
  /^(?:再见|拜拜|回头见)[\s！!。.?？~～]*$/,
  /^(?:你是谁|你能做什么)[\s！!。.?？~～]*$/,
] as const;

/** Requests that can be answered safely without workspace inspection or tools. */
export function isCasualConversationPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  return normalized.length > 0 && CASUAL_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

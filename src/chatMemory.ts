export type ChatRole = "user" | "assistant";

export type ChatTurn = {
  role: ChatRole;
  text: string;
  at: string;
};

const MAX_TURNS = 8;
const memory = new Map<number, ChatTurn[]>();

export function appendChatTurn(chatId: number, role: ChatRole, text: string): void {
  const turns = memory.get(chatId) ?? [];
  turns.push({ role, text: compact(text), at: new Date().toISOString() });
  memory.set(chatId, turns.slice(-MAX_TURNS));
}

export function getChatContext(chatId: number): string {
  const turns = memory.get(chatId) ?? [];
  if (turns.length === 0) return "(no previous turns)";
  return turns.map((turn) => `${turn.role.toUpperCase()} [${turn.at}]: ${turn.text}`).join("\n");
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1200);
}

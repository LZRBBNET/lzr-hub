/** Explicit deep links never fall back to a different customer. No network side effects. */
export function initialConversationSelection<T extends { channel: string; externalConversationId: string }>(items: T[], target?: string): T | undefined {
  if (target === undefined) return items[0];
  const matches = items.filter(item => `${item.channel}:${item.externalConversationId}` === target);
  return matches.length === 1 ? matches[0] : undefined;
}

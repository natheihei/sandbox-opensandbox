// Minimal provider-utils export used by session text slicing tests.
export function extractLines({
  text,
  startLine,
  endLine,
}: {
  text: string;
  startLine?: number;
  endLine?: number;
}): string {
  const lines = text.split('\n');
  const start = startLine == null ? 0 : Math.max(0, startLine - 1);
  const end = endLine == null ? lines.length : endLine;

  return lines.slice(start, end).join('\n');
}

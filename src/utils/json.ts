export const stripFences = (raw: string): string => {
  const fenced = raw.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
};

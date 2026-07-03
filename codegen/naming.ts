/** Word-level splits for path literals that are single words in the spec. */
const WORD_SPLITS: Record<string, string[]> = {
  checkin: ["check", "in"],
  checkout: ["check", "out"],
};

/** Splits a path literal (snake_case or kebab-case) into lowercase words. */
export function words(literal: string): string[] {
  return literal
    .split(/[_-]/)
    .flatMap((word) => WORD_SPLITS[word.toLowerCase()] ?? [word])
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

export function camelCase(literal: string): string {
  const [first, ...rest] = words(literal);
  return (first ?? "") + rest.map(capitalize).join("");
}

export function pascalCase(literal: string): string {
  return words(literal).map(capitalize).join("");
}

export function singular(literal: string): string {
  if (literal.endsWith("ies")) return literal.slice(0, -3) + "y";
  return literal.endsWith("s") && !literal.endsWith("ss") ? literal.slice(0, -1) : literal;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** First lowercase word of a camelCase identifier, e.g. "cancelInvoicePayment" -> "cancel". */
export function firstWord(identifier: string): string {
  const match = identifier.match(/^[a-z]+/);
  return match ? match[0] : "";
}

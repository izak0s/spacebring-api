/** Dependency-free string helpers shared by the generator modules. */

/**
 * Spec descriptions are HTML with an OAuth-scopes section that doesn't apply
 * to this Basic-auth client; strip that, convert <code> to backticks, drop tags.
 */
export function cleanDescription(html: string): string {
  let text = html.split(/<h3>OAuth<\/h3>/)[0].replace(/<code>(.*?)<\/code>/g, "`$1`");
  // Strip tags until stable: a single pass can splice new tags together
  // ("<scr<b>ipt>" -> "<script>"). The spec is remote input, and this text
  // lands inside generated block comments.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== previous);
  // Last, so no earlier replacement can reconstruct a comment terminator.
  return text.replace(/\*\//g, "*\\/").trim();
}

export function docComment(lines: string[]): string {
  const content = lines.filter((line) => line.length > 0);
  if (content.length === 0) return "";
  if (content.length === 1) return `/** ${content[0]} */\n`;
  return `/**\n${content.map((line) => ` * ${line}`).join("\n *\n")}\n */\n`;
}

export function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

export function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

// Keys and namespace segments are already camelCase; pascalCase() would
// flatten their humps ("creditNotes" -> "Creditnotes"), so just upper-first.
export function upperFirst(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

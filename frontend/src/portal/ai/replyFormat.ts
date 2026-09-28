/** A run of reply text, bold when the model wrapped it in **double asterisks**. */
export interface Inline {
  text: string;
  bold: boolean;
}

export type ReplyBlock =
  | { kind: 'heading'; text: Inline[] }
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'bullets'; items: Inline[][] }
  | { kind: 'numbered'; start: number; items: Inline[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/** Split text on **bold** markers. Unpaired markers are left as typed. */
export function parseInline(text: string): Inline[] {
  const parts = text.split('**');
  if (parts.length % 2 === 0) return [{ text, bold: false }];
  return parts
    .map((part, index) => ({ text: part, bold: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}

/**
 * Turn a plain-text assistant reply into paragraphs (keeping line breaks), headings and
 * bullet or numbered lists. The result is rendered as React elements, never as HTML.
 */
export function parseReply(reply: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  // Whether the next line may extend the last block (false after a blank line or heading).
  let continuing = false;

  for (const line of reply.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      continuing = false;
      continue;
    }
    const last = continuing ? blocks[blocks.length - 1] : undefined;
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (heading) {
      blocks.push({ kind: 'heading', text: parseInline(heading[1].trim()) });
      continuing = false;
      continue;
    }
    continuing = true;
    if (bullet) {
      const item = parseInline(bullet[1].trim());
      if (last?.kind === 'bullets') last.items.push(item);
      else blocks.push({ kind: 'bullets', items: [item] });
    } else if (numbered) {
      const item = parseInline(numbered[2].trim());
      if (last?.kind === 'numbered') last.items.push(item);
      else blocks.push({ kind: 'numbered', start: Number(numbered[1]), items: [item] });
    } else if ((last?.kind === 'bullets' || last?.kind === 'numbered') && /^\s/.test(line)) {
      // An indented line continues the previous list item.
      const index = last.items.length - 1;
      last.items[index] = [...last.items[index], { text: ' ', bold: false }, ...parseInline(line.trim())];
    } else if (last?.kind === 'paragraph') {
      last.lines.push(parseInline(line.trim()));
    } else {
      blocks.push({ kind: 'paragraph', lines: [parseInline(line.trim())] });
    }
  }
  return blocks;
}

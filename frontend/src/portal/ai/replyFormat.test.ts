import { describe, expect, it } from 'vitest';
import { toAssistantMessages, type ChatEntry } from './chat';
import { parseInline, parseReply } from './replyFormat';

describe('parseInline', () => {
  it('splits bold runs', () => {
    expect(parseInline('Use **SMART** goals')).toEqual([
      { text: 'Use ', bold: false },
      { text: 'SMART', bold: true },
      { text: ' goals', bold: false },
    ]);
  });

  it('leaves unpaired markers as typed', () => {
    expect(parseInline('a ** b')).toEqual([{ text: 'a ** b', bold: false }]);
  });
});

describe('parseReply', () => {
  it('splits paragraphs on blank lines and keeps line breaks', () => {
    const blocks = parseReply('First line\nsecond line\n\nNext paragraph');
    expect(blocks).toEqual([
      { kind: 'paragraph', lines: [[{ text: 'First line', bold: false }], [{ text: 'second line', bold: false }]] },
      { kind: 'paragraph', lines: [[{ text: 'Next paragraph', bold: false }]] },
    ]);
  });

  it('recognizes bullet and numbered lists, headings and continuation lines', () => {
    const blocks = parseReply('## Plan\n- one\n* two\n  continued\n\n3. third\n4) fourth');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'bullets', 'numbered']);
    const bullets = blocks[1];
    expect(bullets.kind === 'bullets' && bullets.items).toEqual([
      [{ text: 'one', bold: false }],
      [{ text: 'two', bold: false }, { text: ' ', bold: false }, { text: 'continued', bold: false }],
    ]);
    const numbered = blocks[2];
    expect(numbered.kind === 'numbered' && numbered.start).toBe(3);
    expect(numbered.kind === 'numbered' && numbered.items).toHaveLength(2);
  });

  it('never produces markup from HTML-looking text', () => {
    const blocks = parseReply('<img src=x onerror=alert(1)>');
    expect(blocks).toEqual([{ kind: 'paragraph', lines: [[{ text: '<img src=x onerror=alert(1)>', bold: false }]] }]);
  });
});

describe('toAssistantMessages', () => {
  it('keeps the newest 40 non-empty messages and caps their length', () => {
    const entries: ChatEntry[] = Array.from({ length: 45 }, (_, index) => ({
      id: index,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index === 44 ? 'x'.repeat(9000) : `message ${index}`,
    }));
    entries.splice(10, 0, { id: 100, role: 'assistant', content: '   ' });
    const messages = toAssistantMessages(entries);
    expect(messages).toHaveLength(40);
    expect(messages[0].content).toBe('message 5');
    expect(messages[39]).toEqual({ role: 'user', content: 'x'.repeat(8000) });
  });
});

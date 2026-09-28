import type { NoteProposal } from '../../api/ai';
import { MAX_RISK_FLAGS, type NoteFormat } from '../../api/notes';

/** The text of a note: section text for structured formats, `content` for freeform. */
export interface NoteText {
  sections: Record<string, string>;
  content: string;
}

/** A block of text that changes place when a note switches format. */
export interface TextMove {
  from: string;
  to: string;
}

/** Label used for freeform note text in move descriptions. */
export const FREEFORM_LABEL = 'Note';

/**
 * Where a section's text goes when the new format has no section with the same id, in order
 * of preference. Anything unmatched falls back to the new format's first section, which is
 * always its "presenting information" section (Subjective, Data, Behavior, Goals, ...).
 */
const SECTION_AFFINITY: Record<string, string[]> = {
  subjective: ['data', 'behavior', 'situation', 'problem'],
  objective: ['data', 'behavior'],
  data: ['subjective', 'behavior', 'situation'],
  behavior: ['data', 'subjective'],
  situation: ['problem', 'subjective', 'data'],
  problem: ['situation', 'subjective', 'data'],
  intervention: ['data', 'objective'],
  response: ['assessment'],
  assessment: ['response'],
};

export function isFreeform(format: NoteFormat): boolean {
  return format.sections.length === 0;
}

function hasText(text: string | undefined): text is string {
  return Boolean(text && text.trim());
}

/** Every section of the format, in order, with missing ones empty and unknown ones dropped. */
export function normalizeSections(format: NoteFormat, sections: Record<string, string>): Record<string, string> {
  return Object.fromEntries(format.sections.map((section) => [section.id, sections[section.id] ?? '']));
}

/** True when a note has no text anywhere. */
export function noteTextIsEmpty(text: NoteText): boolean {
  return !hasText(text.content) && !Object.values(text.sections).some(hasText);
}

function appendBlock(existing: string, block: string): string {
  return hasText(existing) ? `${existing.trimEnd()}\n\n${block}` : block;
}

/**
 * Re-home a note's text in another format without losing any of it. Sections with the same id
 * carry over as they are; other text is appended, labeled with its old heading, to the closest
 * section of the new format (or combined into one text for freeform). `moves` lists what was
 * re-homed so the clinician can confirm it; it's empty when nothing changes place.
 */
export function convertNoteText(
  from: NoteFormat,
  to: NoteFormat,
  text: NoteText,
): { text: NoteText; moves: TextMove[] } {
  if (from.id === to.id) {
    return {
      text: isFreeform(to) ? { sections: {}, content: text.content } : { sections: normalizeSections(to, text.sections), content: '' },
      moves: [],
    };
  }

  if (isFreeform(from)) {
    const sections = normalizeSections(to, {});
    if (isFreeform(to) || !hasText(text.content)) {
      return { text: { sections, content: isFreeform(to) ? text.content : '' }, moves: [] };
    }
    const first = to.sections[0];
    sections[first.id] = text.content;
    return { text: { sections, content: '' }, moves: [{ from: FREEFORM_LABEL, to: first.label }] };
  }

  const filled = from.sections.filter((section) => hasText(text.sections[section.id]));

  if (isFreeform(to)) {
    const content = filled.map((section) => `${section.label}: ${text.sections[section.id].trim()}`).join('\n\n');
    return {
      text: { sections: {}, content },
      moves: filled.map((section) => ({ from: section.label, to: FREEFORM_LABEL })),
    };
  }

  const targetIds = new Set(to.sections.map((section) => section.id));
  const sections = normalizeSections(to, {});
  for (const section of filled) {
    if (targetIds.has(section.id)) sections[section.id] = text.sections[section.id];
  }
  const moves: TextMove[] = [];
  for (const section of filled) {
    if (targetIds.has(section.id)) continue;
    const targetId = (SECTION_AFFINITY[section.id] ?? []).find((id) => targetIds.has(id)) ?? to.sections[0].id;
    sections[targetId] = appendBlock(sections[targetId], `${section.label}: ${text.sections[section.id].trim()}`);
    moves.push({ from: section.label, to: to.sections.find((target) => target.id === targetId)!.label });
  }
  return { text: { sections, content: '' }, moves };
}

/** Add AI risk flags to a note's flags, skipping duplicates and staying under the server limit. */
export function mergeRiskFlags(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((flag) => flag.trim().toLowerCase()));
  const merged = [...existing];
  for (const raw of incoming) {
    const flag = raw.trim();
    const key = flag.toLowerCase();
    if (!flag || seen.has(key)) continue;
    seen.add(key);
    merged.push(flag);
  }
  return merged.slice(0, MAX_RISK_FLAGS);
}

/** Use the AI draft's text for one section, keeping everything else. */
export function applyProposalSection(text: NoteText, proposal: NoteProposal, sectionId: string): NoteText {
  return { sections: { ...text.sections, [sectionId]: proposal.sections[sectionId] ?? '' }, content: text.content };
}

/** Replace the whole note text with the AI draft. */
export function applyProposalAll(format: NoteFormat, proposal: NoteProposal): NoteText {
  if (isFreeform(format)) return { sections: {}, content: proposal.content };
  return { sections: normalizeSections(format, proposal.sections), content: '' };
}

/** Whether the AI draft's text is what the note currently has (for one section, or freeform content). */
export function proposalApplied(text: NoteText, proposal: NoteProposal, sectionId?: string): boolean {
  if (sectionId === undefined) return hasText(proposal.content) && text.content === proposal.content;
  const suggested = proposal.sections[sectionId] ?? '';
  return hasText(suggested) && text.sections[sectionId] === suggested;
}

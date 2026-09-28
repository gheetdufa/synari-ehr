import { describe, expect, it } from 'vitest';
import type { NoteProposal } from '../../api/ai';
import { BIRP, DAP, FREEFORM_FORMAT, GIRP, SOAP } from './formats.fixture';
import {
  applyProposalAll,
  applyProposalSection,
  convertNoteText,
  mergeRiskFlags,
  normalizeSections,
  noteTextIsEmpty,
  proposalApplied,
} from './noteText';

const soapText = {
  sections: { subjective: 'Reports better sleep.', objective: 'Calm, good eye contact.', assessment: 'Improving.', plan: 'Continue CBT.' },
  content: '',
};

describe('normalizeSections', () => {
  it('keeps every section in format order, fills gaps and drops unknown ids', () => {
    const result = normalizeSections(SOAP, { plan: 'P', stray: 'x', subjective: 'S' });
    expect(Object.keys(result)).toEqual(['subjective', 'objective', 'assessment', 'plan']);
    expect(result).toEqual({ subjective: 'S', objective: '', assessment: '', plan: 'P' });
  });
});

describe('noteTextIsEmpty', () => {
  it.each([
    [{ sections: { a: '  ', b: '\n' }, content: '' }, true],
    [{ sections: {}, content: '   ' }, true],
    [{ sections: { a: 'text' }, content: '' }, false],
    [{ sections: {}, content: 'narrative' }, false],
  ])('%j -> %s', (text, expected) => {
    expect(noteTextIsEmpty(text)).toBe(expected);
  });
});

describe('convertNoteText', () => {
  it('leaves text alone for the same format', () => {
    const { text, moves } = convertNoteText(SOAP, SOAP, soapText);
    expect(text).toEqual(soapText);
    expect(moves).toEqual([]);
  });

  it('carries matching sections over and moves the rest to the closest section, labeled', () => {
    const { text, moves } = convertNoteText(SOAP, DAP, soapText);
    expect(text.sections).toEqual({
      data: 'Subjective: Reports better sleep.\n\nObjective: Calm, good eye contact.',
      assessment: 'Improving.',
      plan: 'Continue CBT.',
    });
    expect(text.content).toBe('');
    expect(moves).toEqual([
      { from: 'Subjective', to: 'Data' },
      { from: 'Objective', to: 'Data' },
    ]);
  });

  it('maps assessment to response and falls back to the first section', () => {
    const { text, moves } = convertNoteText(SOAP, GIRP, soapText);
    expect(text.sections.goals).toBe('Subjective: Reports better sleep.\n\nObjective: Calm, good eye contact.');
    expect(text.sections.response).toBe('Assessment: Improving.');
    expect(text.sections.intervention).toBe('');
    expect(text.sections.plan).toBe('Continue CBT.');
    expect(moves.map((move) => move.to)).toEqual(['Goals', 'Goals', 'Response']);
  });

  it('keeps every word when converting in the other direction', () => {
    const birp = {
      sections: { behavior: 'Tearful.', intervention: 'Grounding skills.', response: 'Engaged well.', plan: 'Weekly.' },
      content: '',
    };
    const { text } = convertNoteText(BIRP, SOAP, birp);
    expect(text.sections).toEqual({
      subjective: 'Behavior: Tearful.',
      objective: 'Intervention: Grounding skills.',
      assessment: 'Response: Engaged well.',
      plan: 'Weekly.',
    });
  });

  it('only reports moves for sections that have text', () => {
    const { moves } = convertNoteText(SOAP, DAP, { sections: { subjective: '', objective: '  ', assessment: 'A', plan: '' }, content: '' });
    expect(moves).toEqual([]);
  });

  it('combines sections into freeform content with headings', () => {
    const { text, moves } = convertNoteText(SOAP, FREEFORM_FORMAT, {
      sections: { subjective: 'S text', objective: '', assessment: 'A text', plan: '' },
      content: '',
    });
    expect(text).toEqual({ sections: {}, content: 'Subjective: S text\n\nAssessment: A text' });
    expect(moves).toEqual([
      { from: 'Subjective', to: 'Note' },
      { from: 'Assessment', to: 'Note' },
    ]);
  });

  it('puts freeform content into the first section', () => {
    const { text, moves } = convertNoteText(FREEFORM_FORMAT, BIRP, { sections: {}, content: 'Whole session narrative.' });
    expect(text.sections).toEqual({ behavior: 'Whole session narrative.', intervention: '', response: '', plan: '' });
    expect(text.content).toBe('');
    expect(moves).toEqual([{ from: 'Note', to: 'Behavior' }]);
  });

  it('switches an empty freeform note without moves', () => {
    const { text, moves } = convertNoteText(FREEFORM_FORMAT, SOAP, { sections: {}, content: ' ' });
    expect(text).toEqual({ sections: { subjective: '', objective: '', assessment: '', plan: '' }, content: '' });
    expect(moves).toEqual([]);
  });
});

describe('applying an AI proposal', () => {
  const proposal: NoteProposal = {
    format: 'SOAP',
    sections: { subjective: 'AI S', objective: 'AI O', assessment: 'AI A', plan: 'AI P' },
    content: '',
    risk_flags: ['Mentioned passive thoughts of death'],
  };

  it('uses one section and keeps the rest', () => {
    const result = applyProposalSection(soapText, proposal, 'objective');
    expect(result.sections).toEqual({ ...soapText.sections, objective: 'AI O' });
    expect(proposalApplied(result, proposal, 'objective')).toBe(true);
    expect(proposalApplied(result, proposal, 'plan')).toBe(false);
  });

  it('replaces all sections, normalized to the format', () => {
    const result = applyProposalAll(SOAP, { ...proposal, sections: { plan: 'AI P', subjective: 'AI S' } });
    expect(result).toEqual({ sections: { subjective: 'AI S', objective: '', assessment: '', plan: 'AI P' }, content: '' });
  });

  it('replaces freeform content', () => {
    const freeform: NoteProposal = { format: 'FREEFORM', sections: {}, content: 'AI narrative', risk_flags: [] };
    const result = applyProposalAll(FREEFORM_FORMAT, freeform);
    expect(result).toEqual({ sections: {}, content: 'AI narrative' });
    expect(proposalApplied(result, freeform)).toBe(true);
  });

  it('does not treat an empty suggestion as applied', () => {
    const empty: NoteProposal = { ...proposal, sections: { ...proposal.sections, plan: '' } };
    expect(proposalApplied({ sections: { plan: '' }, content: '' }, empty, 'plan')).toBe(false);
  });

  it('merges risk flags without duplicates and within the server limit', () => {
    expect(mergeRiskFlags(['Self-harm mentioned'], [' self-harm mentioned ', 'Substance use', ''])).toEqual([
      'Self-harm mentioned',
      'Substance use',
    ]);
    const many = Array.from({ length: 25 }, (_, index) => `Flag ${index}`);
    expect(mergeRiskFlags([], many)).toHaveLength(20);
  });
});

import type { NoteFormat } from '../../api/notes';

/** Test fixtures mirroring the server's formats (backend/synari/services/note_formats.py). */
export const SOAP: NoteFormat = {
  id: 'SOAP',
  name: 'SOAP',
  description: 'Subjective, Objective, Assessment, Plan.',
  sections: [
    { id: 'subjective', label: 'Subjective', guidance: 'What the client reported.' },
    { id: 'objective', label: 'Objective', guidance: 'What you observed.' },
    { id: 'assessment', label: 'Assessment', guidance: 'Your clinical interpretation.' },
    { id: 'plan', label: 'Plan', guidance: 'Next steps.' },
  ],
};

export const DAP: NoteFormat = {
  id: 'DAP',
  name: 'DAP',
  description: 'Data, Assessment, Plan.',
  sections: [
    { id: 'data', label: 'Data', guidance: 'Subjective and objective information.' },
    { id: 'assessment', label: 'Assessment', guidance: 'Your interpretation.' },
    { id: 'plan', label: 'Plan', guidance: 'Next steps.' },
  ],
};

export const BIRP: NoteFormat = {
  id: 'BIRP',
  name: 'BIRP',
  description: 'Behavior, Intervention, Response, Plan.',
  sections: [
    { id: 'behavior', label: 'Behavior', guidance: 'Presentation and behaviors.' },
    { id: 'intervention', label: 'Intervention', guidance: 'Interventions used.' },
    { id: 'response', label: 'Response', guidance: 'How the client responded.' },
    { id: 'plan', label: 'Plan', guidance: 'Next steps.' },
  ],
};

export const GIRP: NoteFormat = {
  id: 'GIRP',
  name: 'GIRP',
  description: 'Goals, Intervention, Response, Plan.',
  sections: [
    { id: 'goals', label: 'Goals', guidance: 'Goals addressed.' },
    { id: 'intervention', label: 'Intervention', guidance: 'Interventions used.' },
    { id: 'response', label: 'Response', guidance: 'How the client responded.' },
    { id: 'plan', label: 'Plan', guidance: 'Next steps.' },
  ],
};

export const FREEFORM_FORMAT: NoteFormat = {
  id: 'FREEFORM',
  name: 'Freeform',
  description: 'A single narrative note.',
  sections: [],
};

export const ALL_FORMATS: NoteFormat[] = [SOAP, DAP, BIRP, GIRP, FREEFORM_FORMAT];

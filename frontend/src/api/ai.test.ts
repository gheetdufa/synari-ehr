import { describe, expect, it } from 'vitest';
import { aiErrorMessage } from './ai';
import { ApiError } from './client';

describe('aiErrorMessage', () => {
  it.each([
    [new ApiError(503, 'AI is not configured'), "AI features aren't set up on this server, so this can't run right now."],
    [new ApiError(502, null), "The AI service couldn't complete the request. Try again shortly."],
    [new ApiError(502, 'Rate limited by the provider'), 'Rate limited by the provider'],
    [new ApiError(403, 'Only clinicians can write notes'), 'AI note drafting is only for clinicians who write notes.'],
    [
      new ApiError(404, 'Client not found'),
      "You can't open this client's clinical record, so Synari can't use it. Choose one of your clients.",
    ],
    [
      new ApiError(422, "That client isn't part of this appointment"),
      "This client wasn't in the linked appointment. Link the right session (or none) and try again.",
    ],
    [new ApiError(422, [{ loc: ['body', 'source_text'], msg: 'Field required' }]), 'source_text: Field required'],
    [new Error('offline'), 'offline'],
  ])('explains %s', (error, message) => {
    expect(aiErrorMessage(error)).toBe(message);
  });
});

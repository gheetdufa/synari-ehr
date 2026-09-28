import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, newPasswordError, passwordErrorField } from './auth';
import { ApiError } from './client';

describe('password rules', () => {
  it('asks for at least 12 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(newPasswordError('eleven-char')).toBe('Use at least 12 characters');
    expect(newPasswordError('twelve-chars')).toBeNull();
  });

  it.each([
    ['Current password is incorrect', 'current'],
    ['This password is too common. Choose something less predictable.', 'new'],
    ["Don't base your password on your name, email or practice name.", 'new'],
    ['This password has appeared in a data breach. Choose a different one.', 'new'],
    ['This reset link is invalid or has expired', null],
    ['This invitation is invalid or has expired. Ask your practice to send a new one.', null],
  ])('puts %j on the %s password field', (message, field) => {
    expect(passwordErrorField(new ApiError(400, message))).toBe(field);
  });

  it('leaves other failures to the form', () => {
    expect(passwordErrorField(new ApiError(409, 'An account with this email already exists'))).toBeNull();
    expect(passwordErrorField(new ApiError(500, 'Password service unavailable'))).toBeNull();
    expect(passwordErrorField(new Error('This password is too common.'))).toBeNull();
  });
});

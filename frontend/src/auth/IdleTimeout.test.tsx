import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleTimeout } from './IdleTimeout';

describe('IdleTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('warns a minute before and then signs out after 30 idle minutes', () => {
    const onTimeout = vi.fn();
    render(<IdleTimeout limitMinutes={30} onTimeout={onTimeout} />);
    act(() => vi.advanceTimersByTime(29 * 60_000 + 5_000));
    expect(screen.getByText(/Are you still there/)).toBeInTheDocument();
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60_000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("uses the server's limit for the session", () => {
    const onTimeout = vi.fn();
    render(<IdleTimeout limitMinutes={5} onTimeout={onTimeout} />);
    act(() => vi.advanceTimersByTime(3 * 60_000 + 55_000));
    expect(screen.queryByText(/Are you still there/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText(/Are you still there/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('keeps the session alive while the user is active', () => {
    const onTimeout = vi.fn();
    render(<IdleTimeout limitMinutes={30} onTimeout={onTimeout} />);
    for (let minute = 0; minute < 40; minute += 5) {
      act(() => vi.advanceTimersByTime(5 * 60_000));
      act(() => {
        window.dispatchEvent(new Event('keydown'));
      });
    }
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

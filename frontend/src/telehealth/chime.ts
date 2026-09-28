/** A soft two-note chime, synthesized with WebAudio so no sound file is needed. */

let context: AudioContext | null = null;

/**
 * Browsers only let pages play sound after a click or tap. Call this from a click handler (for
 * example "Join session") so later chimes can play.
 */
export function primeChime(): void {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
  context ??= new window.AudioContext();
  void context.resume().catch(() => undefined);
}

export function playChime(): void {
  if (!context || context.state !== 'running') return;
  const start = context.currentTime;
  [659.25, 880].forEach((frequency, index) => {
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const at = start + index * 0.18;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 1);
  });
}

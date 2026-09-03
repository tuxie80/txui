/**
 * The "your query finished" sound.
 *
 * Synthesised with WebAudio rather than shipped as a file: it is two sine
 * tones, an audio asset would be larger than the code that makes it, and this
 * way there is nothing to load before the first beep can play.
 *
 * Two distinct shapes, because the whole point is being told *what* happened
 * without looking: success rises (a major third up), failure falls. Both are
 * short and quiet — this fires when you have switched to another window, not
 * to demand attention like an alarm.
 */

/** Frequency pairs in Hz: [first tone, second tone]. */
const TONES = {
  ok:    [660, 880],   // E5 → A5, rising
  error: [440, 330],   // A4 → E4, falling
} as const;

export type BeepKind = keyof typeof TONES;

/** Lazily created and reused — browsers cap how many contexts a page may open. */
let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx || ctx.state === 'closed') ctx = new Ctor();
    // A context created before the first user gesture starts suspended.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;   // no audio device, autoplay policy, headless test run
  }
}

/**
 * Play the finished-notification sound. Never throws and never rejects: a
 * missing audio device must not take down the query that just succeeded.
 */
export function beep(kind: BeepKind = 'ok'): void {
  const ac = audioContext();
  if (!ac) return;
  try {
    const [f1, f2] = TONES[kind];
    const t0 = ac.currentTime;
    const noteLen = 0.11;

    [f1, f2].forEach((freq, i) => {
      const start = t0 + i * noteLen;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      // A hard start/stop on a sine is a click; ramp both ends instead.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.14, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + noteLen);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + noteLen);
    });
  } catch {
    /* audio unavailable — silence is the correct fallback */
  }
}

import { describe, expect, it } from 'vitest';
import { FeatureExtractor } from './features.js';
import type { Hearing } from './hearing.js';
import { type AudioSettings, DEFAULT_AUDIO_SETTINGS } from './settings.js';
import {
  concat,
  kickRamp,
  kickTrack,
  melody,
  mix,
  silence,
  toBlocks,
  whiteNoise,
} from './synth.js';
import { Tracker } from './tracker.js';

const RATE = 16000;
/** Where the first kick of a made-up track lies. */
const OFFSET = 0.2;

function listen(
  samples: Float32Array,
  settings: Partial<AudioSettings> = {},
  rate = RATE,
): Hearing[] {
  const extractor = new FeatureExtractor();
  const tracker = new Tracker({ ...DEFAULT_AUDIO_SETTINGS, ...settings });
  return toBlocks(samples, rate).flatMap((block) => tracker.push(extractor.push(block)));
}

const last = (hearings: Hearing[]): Hearing => hearings[hearings.length - 1] as Hearing;
const at = (hearings: Hearing[], seconds: number): Hearing =>
  hearings.find((hearing) => Math.abs(hearing.at - seconds) < 0.001) as Hearing;
const firstWhere = (hearings: Hearing[], test: (hearing: Hearing) => boolean, from = 0) =>
  hearings.find((hearing) => hearing.at >= from && test(hearing));

/** How far a beat is from the nearest kick of a steady tempo, in milliseconds. */
function phaseError(beatAt: number, bpm: number): number {
  const period = 60 / bpm;
  const shifted = beatAt - OFFSET;
  return (shifted - Math.round(shifted / period) * period) * 1000;
}

const kicks = (bpm: number, seconds: number, rate = RATE, hatsDb?: number) =>
  kickTrack(bpm, { seconds, rate, ...(hatsDb === undefined ? {} : { hatsDb }) });

describe('Tracker: a steady tempo', () => {
  for (const bpm of [90, 100, 126, 140, 150, 170]) {
    it(`finds ${bpm} bpm and the place of its beat within 10 seconds`, () => {
      const hearings = listen(kicks(bpm, 14, RATE, -20));
      const heard = last(hearings);
      expect(heard.heard).toBe('beat');
      expect(Math.abs((heard.bpm ?? 0) - bpm)).toBeLessThan(1);
      for (const hearing of hearings.filter((each) => each.at > 10)) {
        expect(hearing.beatAt).toBeDefined();
        expect(Math.abs(phaseError(hearing.beatAt as number, bpm))).toBeLessThan(30);
      }
    });
  }

  it('does the same from sound at 48 kHz', () => {
    for (const bpm of [126, 170]) {
      const hearings = listen(kicks(bpm, 14, 48000), {}, 48000);
      expect(last(hearings).heard).toBe('beat');
      expect(Math.abs((last(hearings).bpm ?? 0) - bpm)).toBeLessThan(1);
      expect(Math.abs(phaseError(last(hearings).beatAt as number, bpm))).toBeLessThan(30);
    }
  });

  it('says what it hears every 100 ms, and where the beat last fell', () => {
    const hearings = listen(kicks(126, 14, RATE, -20));
    hearings.forEach((hearing, i) => {
      expect(hearing.at).toBeCloseTo((hearings[0]?.at ?? 0) + i / 10, 6);
      expect(hearing.confidence).toBeGreaterThanOrEqual(0);
      expect(hearing.confidence).toBeLessThanOrEqual(1);
      expect(Number.isFinite(hearing.level)).toBe(true);
      if (hearing.heard === 'beat') {
        // Not later than now, and not more than a beat ago.
        expect(hearing.beatAt).toBeLessThanOrEqual(hearing.at);
        expect(hearing.beatAt).toBeGreaterThan(hearing.at - 60 / (hearing.bpm ?? 126));
      } else {
        expect(hearing.beatAt).toBeUndefined();
      }
    });
    expect(hearings[0]?.bpm).toBeUndefined();
    expect(hearings[0]?.heard).toBe('music');
  });

  it('does not take 126 for 63 or 252, with hats on the eighths', () => {
    const loudHats = listen(kicks(126, 16, RATE, -8));
    expect(Math.abs((last(loudHats).bpm ?? 0) - 126)).toBeLessThan(1);
    expect(last(loudHats).heard).toBe('beat');
  });

  it('keeps 126 when every other kick is left out, and still hears a beat', () => {
    const track = kickTrack(126, { seconds: 16, rate: RATE, skip: (beat) => beat % 2 === 1 });
    const heard = last(listen(track));
    expect(Math.abs((heard.bpm ?? 0) - 126)).toBeLessThan(1);
    expect(heard.heard).toBe('beat');
  });

  it('is not put off by a single missed kick', () => {
    const track = kickTrack(126, { seconds: 24, rate: RATE, hatsDb: -20, skip: (b) => b === 20 });
    const hearings = listen(track);
    const first = firstWhere(hearings, (hearing) => hearing.heard === 'beat') as Hearing;
    expect(first.at).toBeLessThan(8);
    for (const hearing of hearings.filter((each) => each.at >= first.at)) {
      expect(hearing.heard).toBe('beat');
    }
    expect(Math.abs((last(hearings).bpm ?? 0) - 126)).toBeLessThan(1);
  });

  it('keeps to the range it is given', () => {
    const fast = kicks(170, 16);
    const unlimited = last(listen(fast));
    expect(Math.abs((unlimited.bpm ?? 0) - 170)).toBeLessThan(1);
    const limited = last(listen(fast, { bpmMax: 150 }));
    expect(limited.bpm).toBeDefined();
    expect(limited.bpm).toBeLessThanOrEqual(150);
    expect(limited.bpm).toBeGreaterThanOrEqual(80);
  });
});

describe('Tracker: a tempo that changes', () => {
  it('follows a step from 126 to 132 once it has held for a while', () => {
    const hearings = listen(concat(kicks(126, 12, RATE, -20), kicks(132, 18, RATE, -20)));
    expect(Math.abs((at(hearings, 11).bpm ?? 0) - 126)).toBeLessThan(1);
    // The old tempo is not dropped at once: a tempo has to hold for lockAfter beats.
    expect(Math.abs((at(hearings, 14).bpm ?? 0) - 126)).toBeLessThan(1);
    expect(Math.abs((at(hearings, 28).bpm ?? 0) - 132)).toBeLessThan(1);
    expect(at(hearings, 28).heard).toBe('beat');
  });

  it('follows a slow ramp', () => {
    const { samples } = kickRamp(120, 126, { seconds: 40, rate: RATE });
    const hearings = listen(samples);
    for (const hearing of hearings.filter((each) => each.at > 10)) {
      expect(hearing.heard).toBe('beat');
    }
    // It runs a few seconds behind the real tempo, which is still going up.
    expect(Math.abs((last(hearings).bpm ?? 0) - 125.4)).toBeLessThan(1);
  });
});

describe('Tracker: sound without a beat', () => {
  it('hears no tempo in melody, or in noise', () => {
    for (const samples of [melody(60, RATE, -15, 3), whiteNoise(60, RATE, -50, 1)]) {
      const hearings = listen(samples);
      expect(hearings.every((hearing) => hearing.bpm === undefined)).toBe(true);
      expect(hearings.every((hearing) => hearing.heard === 'music')).toBe(true);
    }
  });

  it('keeps the tempo it had when a beat gives way to melody, and says music', () => {
    const hearings = listen(concat(kicks(126, 12, RATE, -20), melody(30, RATE, -12)));
    const lost = firstWhere(hearings, (hearing) => hearing.heard === 'music', 13);
    expect(lost).toBeDefined();
    expect(lost?.at).toBeLessThan(30);
    expect(last(hearings).heard).toBe('music');
    for (const hearing of hearings.filter((each) => each.at > 12)) {
      expect(Math.abs((hearing.bpm ?? 0) - 126)).toBeLessThan(1);
    }
  });

  it('does not take a quiet breakdown for silence', () => {
    const room = (seconds: number, seed: number) => whiteNoise(seconds, RATE, -55, seed);
    const track = concat(
      mix(kicks(126, 12, RATE, -20), room(12, 1)),
      mix(melody(12, RATE, -22), room(12, 2)),
    );
    const hearings = listen(track);
    expect(hearings.some((hearing) => hearing.heard === 'silent')).toBe(false);
  });
});

describe('Tracker: silence', () => {
  it('hears silence within the time it is given after the sound stops', () => {
    const hearings = listen(concat(kicks(126, 10, RATE, -20), silence(6, RATE)));
    const stopped = firstWhere(hearings, (hearing) => hearing.heard === 'silent') as Hearing;
    expect(stopped).toBeDefined();
    expect(stopped.at).toBeGreaterThan(10 + DEFAULT_AUDIO_SETTINGS.silenceAfter - 0.2);
    expect(stopped.at).toBeLessThan(10 + DEFAULT_AUDIO_SETTINGS.silenceAfter + 0.5);
    for (const hearing of hearings.filter((each) => each.at >= stopped.at)) {
      expect(hearing.heard).toBe('silent');
      expect(hearing.beatAt).toBeUndefined();
    }
  });

  it('waits as long as it is told to', () => {
    const hearings = listen(concat(kicks(126, 10, RATE, -20), silence(8, RATE)), {
      silenceAfter: 5,
    });
    const stopped = firstWhere(hearings, (hearing) => hearing.heard === 'silent') as Hearing;
    expect(stopped.at).toBeGreaterThan(14.8);
    expect(stopped.at).toBeLessThan(15.5);
  });

  it('hears a stop in a room with noise, where the sound is 30 dB over the noise', () => {
    const music = mix(
      kickTrack(126, { seconds: 10, rate: RATE, db: -12, hatsDb: -26 }),
      whiteNoise(10, RATE, -50, 1),
    );
    const hearings = listen(concat(music, whiteNoise(8, RATE, -50, 2)));
    expect(hearings.filter((each) => each.at < 10).some((each) => each.heard === 'silent')).toBe(
      false,
    );
    const stopped = firstWhere(hearings, (hearing) => hearing.heard === 'silent') as Hearing;
    expect(stopped.at).toBeLessThan(10 + DEFAULT_AUDIO_SETTINGS.silenceAfter + 1);
    expect(last(hearings).heard).toBe('silent');
  });

  it('hears the music come back, and finds the beat again at the tempo it had', () => {
    const hearings = listen(
      concat(kicks(126, 8, RATE, -20), silence(6, RATE), kicks(126, 14, RATE, -20)),
    );
    expect(hearings.some((hearing) => hearing.heard === 'silent')).toBe(true);
    const back = firstWhere(hearings, (hearing) => hearing.heard !== 'silent', 14) as Hearing;
    expect(back.at).toBeLessThan(16.5);
    const beat = firstWhere(hearings, (hearing) => hearing.heard === 'beat', 14) as Hearing;
    expect(beat.at).toBeLessThan(21);
    expect(Math.abs((last(hearings).bpm ?? 0) - 126)).toBeLessThan(1);
    expect(last(hearings).heard).toBe('beat');
  });

  it('hears sparse music come back, with silence between the kicks', () => {
    // Each kick is above the floor for about 0.4 s of its 0.6 s: shorter than the half
    // second of sound that wakes it, so only the kicks together can.
    const sparse = (seconds: number) => kickTrack(100, { seconds, rate: RATE, db: -30 });
    const hearings = listen(concat(sparse(8), silence(6, RATE), sparse(10)));
    expect(hearings.some((hearing) => hearing.heard === 'silent')).toBe(true);
    const back = firstWhere(hearings, (hearing) => hearing.heard !== 'silent', 14) as Hearing;
    expect(back).toBeDefined();
    expect(back.at).toBeLessThan(16.5);
    // And it never takes the gaps between the kicks for silence while the music plays.
    const playing = hearings.filter((each) => each.at < 8);
    expect(playing.some((each) => each.heard === 'silent')).toBe(false);
  });

  it('keeps the tempo through the silence', () => {
    const hearings = listen(concat(kicks(126, 8, RATE, -20), silence(8, RATE)));
    expect(Math.abs((last(hearings).bpm ?? 0) - 126)).toBeLessThan(1);
    expect(last(hearings).heard).toBe('silent');
  });

  it('is silent below the floor whatever came before', () => {
    const hearings = listen(whiteNoise(10, RATE, -85, 4));
    expect(last(hearings).heard).toBe('silent');
  });
});

describe('Tracker: housekeeping', () => {
  it('takes settings that change while it listens', () => {
    const extractor = new FeatureExtractor();
    const tracker = new Tracker({ ...DEFAULT_AUDIO_SETTINGS });
    const blocks = toBlocks(concat(kicks(126, 8, RATE, -20), silence(10, RATE)), RATE);
    const hearings: Hearing[] = [];
    for (const [i, block] of blocks.entries()) {
      if (i === 90) tracker.setSettings({ ...DEFAULT_AUDIO_SETTINGS, silenceAfter: 6 });
      hearings.push(...tracker.push(extractor.push(block)));
    }
    const stopped = firstWhere(hearings, (hearing) => hearing.heard === 'silent') as Hearing;
    expect(stopped.at).toBeGreaterThan(13.5);
  });

  it('forgets everything when it is reset', () => {
    const extractor = new FeatureExtractor();
    const tracker = new Tracker({ ...DEFAULT_AUDIO_SETTINGS });
    const track = kicks(126, 12, RATE, -20);
    let heard: Hearing[] = [];
    for (const block of toBlocks(track, RATE)) heard = tracker.push(extractor.push(block));
    expect(heard[heard.length - 1]?.bpm).toBeDefined();
    tracker.reset();
    extractor.reset();
    const again = toBlocks(track.subarray(0, RATE * 2), RATE).flatMap((block) =>
      tracker.push(extractor.push(block)),
    );
    expect(again.every((hearing) => hearing.bpm === undefined)).toBe(true);
  });

  it('starts over when frames do not follow on', () => {
    const extractor = new FeatureExtractor();
    const tracker = new Tracker({ ...DEFAULT_AUDIO_SETTINGS });
    const track = kicks(126, 12, RATE, -20);
    for (const block of toBlocks(track, RATE)) tracker.push(extractor.push(block));
    // The same sound again, but as if it came from much later in the feed.
    const later = toBlocks(track.subarray(0, RATE * 2), RATE, 0.1, { startIndex: RATE * 100 });
    const hearings = later.flatMap((block) => tracker.push(extractor.push(block)));
    expect(hearings.length).toBeGreaterThan(0);
    expect(hearings.every((hearing) => hearing.bpm === undefined)).toBe(true);
  });
});

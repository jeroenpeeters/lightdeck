import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchError } from '../../server/fixture.js';
import { Tempo } from '../../server/tempo.js';
import { BrowserMicSource } from './browserMic.js';
import { type AudioState, Follower, type HearerLike } from './follower.js';
import type { Hearing } from './hearing.js';
import { DEFAULT_AUDIO_SETTINGS } from './settings.js';
import type { AudioBlock } from './source.js';
import { toInt16 } from './wav.js';

/** Says what it is told to, whatever the sound. */
class ScriptedHearer implements HearerLike {
  next: Hearing[] = [];
  settings: unknown;
  resets = 0;
  setSettings(settings: unknown): void {
    this.settings = settings;
  }
  push(_block: AudioBlock): Hearing[] {
    const out = this.next;
    this.next = [];
    return out;
  }
  reset(): void {
    this.resets += 1;
  }
}

const hearing = (over: Partial<Hearing> = {}): Hearing => ({
  at: 0.1,
  heard: 'beat',
  bpm: 126,
  confidence: 0.9,
  beatAt: undefined,
  level: -20,
  ...over,
});

describe('Follower', () => {
  let clock: number;
  let tempo: Tempo;
  let mic: BrowserMicSource;
  let hearer: ScriptedHearer;
  let follower: Follower;
  let index: number;
  let feed: string;

  /** A block of 100 ms at 48 kHz that arrives `late` ms after the sound it ends with. */
  const sound = (late = 0) => {
    clock = 1000 + (index + 4800) / 48 + late;
    mic.push({ bytes: toInt16(new Float32Array(4800)), sampleRate: 48_000, index, feed });
    index += 4800;
  };
  /** Say something, then hear a block of sound. */
  const hear = (...said: Hearing[]) => {
    hearer.next = said;
    sound();
  };
  const audio = () => follower.getState();

  beforeEach(() => {
    clock = 1000;
    index = 0;
    feed = 'f1';
    tempo = new Tempo({ now: () => clock });
    mic = new BrowserMicSource({ now: () => clock });
    hearer = new ScriptedHearer();
    follower = new Follower({ tempo, source: mic, hearer });
  });

  describe('by hand', () => {
    it('shows what it hears and leaves the tempo alone', () => {
      hear(hearing({ heard: 'silent', bpm: 130 }));
      expect(audio()).toMatchObject({ heard: 'silent', bpm: 130, following: false });
      expect(tempo.getState()).toMatchObject({ bpm: 126, running: true, source: 'manual' });
      hear(hearing({ heard: 'beat', bpm: 140 }));
      expect(tempo.getState().bpm).toBe(126);
    });
  });

  describe('in auto', () => {
    beforeEach(() => {
      tempo.update({ source: 'audio' });
    });

    it('follows the bpm of a beat, to a tenth', () => {
      hear(hearing({ bpm: 128.04 }));
      expect(tempo.getState()).toMatchObject({ bpm: 128, running: true });
      expect(audio().following).toBe(true);
    });

    it('does not pass on a change smaller than a tenth', () => {
      const follow = vi.spyOn(tempo, 'follow');
      hear(hearing({ bpm: 126.04 }));
      expect(follow).toHaveBeenCalledWith({ running: true });
      expect(tempo.getState().bpm).toBe(126);
    });

    it('holds the bpm when there is music without a beat, and the effects keep running', () => {
      hear(hearing({ bpm: 130 }));
      hear(hearing({ heard: 'music', bpm: 130, confidence: 0.1 }));
      expect(tempo.getState()).toMatchObject({ bpm: 130, running: true });
      hear(hearing({ heard: 'music', bpm: 171 }));
      expect(tempo.getState()).toMatchObject({ bpm: 130, running: true });
    });

    it('stops the tempo when there is music without a beat, if it is set to', () => {
      follower.update({ onNoBeat: 'stop' });
      hear(hearing({ heard: 'music' }));
      expect(tempo.isRunning()).toBe(false);
      hear(hearing({ heard: 'beat' }));
      expect(tempo.isRunning()).toBe(true);
    });

    it('stops the tempo when the music stops, so that effects are idle, and starts it again', () => {
      hear(hearing({ bpm: 130 }));
      hear(hearing({ heard: 'silent', bpm: 130 }));
      expect(tempo.isRunning()).toBe(false);
      expect(tempo.getState().bpm).toBe(130);
      expect(audio().heard).toBe('silent');
      hear(hearing({ heard: 'music', bpm: 130 }));
      expect(tempo.isRunning()).toBe(true);
    });

    it('keeps the tempo running through silence when it is set to hold', () => {
      follower.update({ onSilence: 'hold' });
      hear(hearing({ heard: 'silent' }));
      expect(tempo.isRunning()).toBe(true);
    });

    it('does not take a lost feed for silence: the tempo runs on at its last bpm', () => {
      hear(hearing({ bpm: 132 }));
      hear(hearing({ heard: 'silent', bpm: 132 }));
      expect(tempo.isRunning()).toBe(false);
      clock += 5000;
      mic.check();
      expect(audio().source.status).toBe('lost');
      expect(audio().heard).toBe('none');
      expect(tempo.getState()).toMatchObject({ running: true, bpm: 132 });
    });

    it('is not lost into silence either when the tempo was running', () => {
      hear(hearing({ bpm: 132 }));
      clock += 5000;
      mic.check();
      expect(tempo.getState()).toMatchObject({ running: true, bpm: 132 });
    });

    it('says nothing when the sound comes back, until it hears something', () => {
      hear(hearing());
      clock += 5000;
      mic.check();
      sound();
      expect(audio().source.status).toBe('live');
      expect(audio().heard).toBe('none');
    });

    it('is following again right away when the operator takes it back from by hand', () => {
      hear(hearing({ bpm: 130 }));
      tempo.update({ source: 'manual' });
      hear(hearing({ bpm: 150 }));
      expect(tempo.getState().bpm).toBe(130);
      tempo.update({ source: 'audio' });
      hear(hearing({ bpm: 150 }));
      expect(tempo.getState().bpm).toBe(150);
    });
  });

  describe('the place of the beat', () => {
    beforeEach(() => {
      // Beat one is at 1000 on the clock of the tempo, 500 ms per beat.
      tempo.update({ bpm: 120, sync: true });
      tempo.update({ source: 'audio' });
    });

    it('puts a beat that was heard on the clock of the tempo, from when the sound arrived', () => {
      // The block ends at 100 ms in the feed and arrives at 1100: the feed lies 1000 ms ahead
      // on the clock of the tempo. A beat at 0.05 s of the feed is at 1050, a tenth of a beat late.
      follower.update({ phase: 'snap' });
      hear(hearing({ at: 0.1, bpm: 120, beatAt: 0.05 }));
      clock = 1050;
      expect(tempo.getBeat()).toBeCloseTo(0, 2);
    });

    it('moves only a part of the way when it is set to smooth', () => {
      hear(hearing({ at: 0.1, bpm: 120, beatAt: 0.05 }));
      clock = 1050;
      // The count was 0.1 beat ahead at the heard beat. A quarter of that is put right: 0.075 is left.
      expect(tempo.getBeat()).toBeCloseTo(0.075, 3);
    });

    it('trusts the quickest arrival, not a late one', () => {
      follower.update({ phase: 'snap' });
      sound();
      sound(40); // a block that came 40 ms late
      sound(25);
      // The beat at 0.25 s of the feed: the offset is the quickest, 1000.
      hearer.next = [hearing({ at: 0.3, bpm: 120, beatAt: 0.25 })];
      sound();
      clock = 1250;
      expect(Math.abs(tempo.getBeat() - Math.round(tempo.getBeat()))).toBeLessThan(0.01);
    });

    it('adds the latency that was set', () => {
      follower.update({ phase: 'snap', latencyMs: -50 });
      hear(hearing({ at: 0.1, bpm: 120, beatAt: 0.05 }));
      // The beat is put at 1000 instead of 1050: on the count already.
      clock = 1000;
      expect(tempo.getBeat()).toBeCloseTo(0, 2);
    });

    it('passes on each beat once, however often it is told', () => {
      const follow = vi.spyOn(tempo, 'follow');
      hear(hearing({ at: 0.1, beatAt: 0.05 }));
      hear(hearing({ at: 0.2, beatAt: 0.05 }));
      hear(hearing({ at: 0.6, beatAt: 0.55 }));
      const withBeat = follow.mock.calls.filter(([change]) => change.beatAt !== undefined);
      expect(withBeat).toHaveLength(2);
    });

    it('starts the offset over for a new feed', () => {
      follower.update({ phase: 'snap' });
      hear(hearing({ at: 0.1, beatAt: 0.05 }));
      // The page was reloaded: positions start at 0 again, and the arrival is much later.
      feed = 'f2';
      index = 0;
      clock = 5000;
      hearer.next = [hearing({ at: 0.1, bpm: 120, beatAt: 0.05 })];
      mic.push({ bytes: toInt16(new Float32Array(4800)), sampleRate: 48_000, index: 0, feed });
      // The new feed lies at 4900 on the clock, so its beat at 0.05 s is at 4950. With the
      // old offset it would have been at 1050 + 50 = 1100 and nowhere near.
      clock = 4950;
      expect(Math.abs(tempo.getBeat() - Math.round(tempo.getBeat()))).toBeLessThan(0.01);
    });
  });

  describe('its settings', () => {
    it('take a change, pass it to the hearer and tell the listeners', () => {
      const seen: AudioState[] = [];
      follower.on('audio', (state: AudioState) => seen.push(state));
      const next = follower.update({ silenceAfter: 5 });
      expect(next.silenceAfter).toBe(5);
      expect(hearer.settings).toMatchObject({ silenceAfter: 5 });
      expect(seen.at(-1)?.settings.silenceAfter).toBe(5);
    });

    it('refuse a wrong one and change nothing', () => {
      expect(() => follower.update({ silenceAfter: -1 })).toThrow(PatchError);
      expect(audio().settings).toEqual(DEFAULT_AUDIO_SETTINGS);
    });

    it('start from what they were given', () => {
      const own = new Follower({
        tempo,
        source: mic,
        hearer,
        settings: { onSilence: 'hold', latencyMs: 30 },
      });
      expect(own.getState().settings).toMatchObject({ onSilence: 'hold', latencyMs: 30 });
      own.close();
    });
  });

  describe('what it tells', () => {
    it('speaks when what is heard changes, and not for every block', () => {
      const seen: AudioState[] = [];
      follower.on('audio', (state: AudioState) => seen.push(state));
      hear(hearing({ bpm: 126.2 }));
      const after = seen.length;
      hear(hearing({ bpm: 126.3, confidence: 0.91 }));
      hear(hearing({ bpm: 126.1, confidence: 0.9 }));
      expect(seen.length).toBe(after);
      hear(hearing({ heard: 'music' }));
      expect(seen.length).toBe(after + 1);
      expect(seen.at(-1)?.heard).toBe('music');
    });

    it('tells that the tempo follows it when the operator switches to auto', () => {
      const seen: AudioState[] = [];
      follower.on('audio', (state: AudioState) => seen.push(state));
      tempo.update({ source: 'audio' });
      expect(seen.at(-1)?.following).toBe(true);
    });

    it('stops listening to the source when it is closed', () => {
      follower.close();
      hear(hearing({ heard: 'silent' }));
      expect(audio().heard).toBe('none');
    });
  });
});

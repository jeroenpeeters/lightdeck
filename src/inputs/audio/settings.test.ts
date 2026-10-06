import { describe, expect, it } from 'vitest';
import { PatchError } from '../../server/fixture.js';
import { DEFAULT_AUDIO_SETTINGS, readAudioSettings } from './settings.js';

describe('the listening settings', () => {
  it('start as Jeroen decided: silence stops the tempo, no beat holds it', () => {
    expect(DEFAULT_AUDIO_SETTINGS.onSilence).toBe('stop');
    expect(DEFAULT_AUDIO_SETTINGS.onNoBeat).toBe('hold');
  });

  it('take a partial change and leave the rest', () => {
    const next = readAudioSettings({ onSilence: 'hold', silenceAfter: 4 }, DEFAULT_AUDIO_SETTINGS);
    expect(next.onSilence).toBe('hold');
    expect(next.silenceAfter).toBe(4);
    expect(next.onNoBeat).toBe('hold');
    expect(next.bpmMin).toBe(DEFAULT_AUDIO_SETTINGS.bpmMin);
  });

  it('do not change what they were given', () => {
    const before = { ...DEFAULT_AUDIO_SETTINGS };
    readAudioSettings({ latencyMs: 40 }, before);
    expect(before).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('apply nothing when any part is wrong', () => {
    expect(() =>
      readAudioSettings({ silenceAfter: 4, onSilence: 'dim' }, DEFAULT_AUDIO_SETTINGS),
    ).toThrow(PatchError);
  });

  it('refuse a name they do not know, and say which', () => {
    expect(() => readAudioSettings({ colour: 'red' }, DEFAULT_AUDIO_SETTINGS)).toThrow(/colour/);
  });

  it('refuse text and numbers out of range', () => {
    expect(() => readAudioSettings({ silenceAfter: '2' }, DEFAULT_AUDIO_SETTINGS)).toThrow(
      /must be a number/,
    );
    expect(() => readAudioSettings({ silenceAfter: Number.NaN }, DEFAULT_AUDIO_SETTINGS)).toThrow(
      PatchError,
    );
    expect(() => readAudioSettings({ silenceDrop: 100 }, DEFAULT_AUDIO_SETTINGS)).toThrow(
      /between 6 and 60 dB/,
    );
    expect(() => readAudioSettings({ phase: 'jump' }, DEFAULT_AUDIO_SETTINGS)).toThrow(
      /smooth or snap/,
    );
  });

  it('keep the tempo range inside what the console allows, with room in it', () => {
    expect(() => readAudioSettings({ bpmMin: 40 }, DEFAULT_AUDIO_SETTINGS)).toThrow(PatchError);
    expect(() => readAudioSettings({ bpmMax: 250 }, DEFAULT_AUDIO_SETTINGS)).toThrow(PatchError);
    expect(() => readAudioSettings({ bpmMin: 170 }, DEFAULT_AUDIO_SETTINGS)).toThrow(/room/);
    expect(readAudioSettings({ bpmMin: 100, bpmMax: 140 }, DEFAULT_AUDIO_SETTINGS)).toMatchObject({
      bpmMin: 100,
      bpmMax: 140,
    });
  });

  it('refuse something that is not an object', () => {
    expect(() => readAudioSettings(null, DEFAULT_AUDIO_SETTINGS)).toThrow(PatchError);
    expect(() => readAudioSettings([], DEFAULT_AUDIO_SETTINGS)).toThrow(PatchError);
  });
});

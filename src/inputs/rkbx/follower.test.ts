import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tempo } from '../../server/tempo.js';
import { BEAT_ADDRESS, BPM_ADDRESS, RkbxFollower, type RkbxState } from './follower.js';
import { OscReceiver } from './receiver.js';

describe('RkbxFollower', () => {
  let clock: number;
  let tempo: Tempo;
  let receiver: OscReceiver;
  let follower: RkbxFollower;

  /** What rkbx_link sends, as the receiver would hand it over, at the moment `at`. */
  const say = (address: string, value: number, at = clock) =>
    receiver.emit('message', { address, args: [value] }, at);
  const beat = (at = clock) => say(BEAT_ADDRESS, 1, at);

  beforeEach(() => {
    clock = 1000;
    tempo = new Tempo({ now: () => clock });
    tempo.update({ bpm: 120 });
    receiver = new OscReceiver();
    follower = new RkbxFollower({ tempo, receiver });
  });
  afterEach(() => follower.close());

  it('starts waiting, and by hand', () => {
    expect(follower.getState()).toEqual({
      status: 'waiting',
      following: false,
      bpm: undefined,
      beats: false,
      port: undefined,
    });
  });

  it('keeps what rekordbox says but leaves the tempo alone while the source is by hand', () => {
    say(BPM_ADDRESS, 128.5);
    beat();
    expect(follower.getState()).toMatchObject({ status: 'live', bpm: 128.5, beats: true });
    expect(tempo.getState()).toMatchObject({ bpm: 120, running: true });
    expect(tempo.beatAt(clock)).toBe(0);
  });

  describe('the bpm', () => {
    beforeEach(() => tempo.update({ source: 'rekordbox' }));

    it('follows the bpm that rekordbox says, with the pitch in it', () => {
      say(BPM_ADDRESS, 128.52);
      expect(tempo.getState().bpm).toBe(128.52);
    });

    it('does not follow a change too small to matter, or a number that is no tempo', () => {
      say(BPM_ADDRESS, 120.02);
      expect(tempo.getState().bpm).toBe(120);
      say(BPM_ADDRESS, 0);
      say(BPM_ADDRESS, 900);
      say(BPM_ADDRESS, Number.NaN);
      expect(tempo.getState().bpm).toBe(120);
    });

    it('keeps the beat it is on when the bpm changes', () => {
      clock = 3000; // beat 4 at 120 bpm
      say(BPM_ADDRESS, 130);
      expect(tempo.beatAt(clock)).toBeCloseTo(4, 6);
    });
  });

  describe('the beats', () => {
    beforeEach(() => tempo.update({ source: 'rekordbox' }));

    it('puts the first beat right at once, and the ones after it a quarter of the way', () => {
      // 500 ms per beat; the origin is at 1000. A beat falls at 1700: the count says 1.4.
      clock = 1700;
      beat();
      expect(tempo.beatAt(1700)).toBeCloseTo(1, 6);
      // The next one falls 40 ms late (at 2240, the count says 2.08): a quarter of 40 ms.
      clock = 2240;
      beat();
      expect(tempo.beatAt(2240)).toBeCloseTo(2 + 0.08 - 0.02, 6);
    });

    it('does not take the release of a trigger, or a repeat, for a beat', () => {
      clock = 1700;
      beat();
      const origin = tempo.timeOfBeat(0);
      say(BEAT_ADDRESS, 0, 1800);
      beat(1750);
      expect(tempo.timeOfBeat(0)).toBe(origin);
    });

    it('says that beats are coming', () => {
      expect(follower.getState().beats).toBe(false);
      beat();
      expect(follower.getState().beats).toBe(true);
    });
  });

  describe('when the beats stop', () => {
    beforeEach(() => {
      tempo.update({ source: 'rekordbox' });
      beat(1000);
    });

    it('lets the effects idle after three seconds, and starts them with the next beat', () => {
      follower.check(3500);
      expect(tempo.getState().running).toBe(true);
      follower.check(4100);
      expect(tempo.getState().running).toBe(false);
      expect(follower.getState().beats).toBe(false);
      clock = 6000;
      beat(6000);
      expect(tempo.getState().running).toBe(true);
      expect(follower.getState().beats).toBe(true);
    });

    it('puts the beat right at once after a stop, as it does at the start', () => {
      follower.check(4100);
      // 500 ms per beat, origin about 1000: a beat at 6250 says 10.5 and rounds to the next, or
      // the one before; the first beat after a stop is taken whole.
      clock = 6130;
      beat(6130);
      expect(tempo.beatAt(6130) % 1).toBeCloseTo(0, 6);
    });

    it('does not idle the effects when the source is by hand', () => {
      tempo.update({ source: 'manual' });
      follower.check(9000);
      expect(tempo.getState().running).toBe(true);
    });

    it('is idle at once when rekordbox is chosen while the beats are not coming', () => {
      tempo.update({ source: 'manual' });
      follower.check(9000);
      tempo.update({ source: 'rekordbox' });
      expect(tempo.getState().running).toBe(false);
    });
  });

  it('never idles the effects for the bpm without beats: the trigger may not be turned on', () => {
    tempo.update({ source: 'rekordbox' });
    say(BPM_ADDRESS, 126);
    follower.check(60_000);
    expect(tempo.getState()).toMatchObject({ bpm: 126, running: true });
    expect(follower.getState()).toMatchObject({ status: 'live', beats: false });
  });

  it('ignores other addresses and arguments that are no numbers', () => {
    tempo.update({ source: 'rekordbox' });
    receiver.emit('message', { address: '/master/track/title', args: ['x'] }, clock);
    receiver.emit('message', { address: BPM_ADDRESS, args: ['fast'] }, clock);
    receiver.emit('message', { address: BPM_ADDRESS, args: [] }, clock);
    expect(follower.getState().status).toBe('waiting');
    expect(tempo.getState().bpm).toBe(120);
  });

  it('tells the listeners when what it shows changes, and only then', () => {
    const seen: RkbxState[] = [];
    follower.on('rkbx', (state: RkbxState) => seen.push(state));
    say(BPM_ADDRESS, 126);
    say(BPM_ADDRESS, 126.01); // the same, shown
    expect(seen).toHaveLength(1);
    tempo.update({ source: 'rekordbox' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ following: true });
    beat();
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ beats: true });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tempo } from '../../server/tempo.js';
import {
  ARTIST_ADDRESS,
  BEAT_ADDRESS,
  BPM_ADDRESS,
  PHRASE_ADDRESS,
  RkbxFollower,
  type RkbxState,
  readPhrase,
  TIME_ADDRESS,
  TITLE_ADDRESS,
  type TrackInfo,
} from './follower.js';
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
      breakdown: { enabled: false, phrase: undefined, active: false },
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

    it('lets the effects idle after two and a half beats, and starts them with the next beat', () => {
      // 120 bpm: a beat is 500 ms, so 1250 ms after the last beat (at 1000).
      follower.check(2000);
      expect(tempo.getState().running).toBe(true);
      follower.check(2300); // one beat missing is a gap of two: not yet. The third missing stops it
      expect(tempo.getState().running).toBe(false);
      expect(follower.getState().beats).toBe(false);
      clock = 6000;
      beat(6000);
      expect(tempo.getState().running).toBe(true);
      expect(follower.getState().beats).toBe(true);
    });

    it('puts the beat right at once after a stop, as it does at the start', () => {
      follower.check(2300);
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

  it('waits 2.5 beats at the fastest tempo too: 750 ms of 300 ms beats', () => {
    tempo.update({ source: 'rekordbox', bpm: 200 });
    beat(1000);
    follower.check(1650);
    expect(tempo.getState().running).toBe(true);
    follower.check(1800);
    expect(tempo.getState().running).toBe(false);
  });

  it('waits longer at a slow tempo: 2.5 beats of 1000 ms', () => {
    tempo.update({ source: 'rekordbox', bpm: 60 });
    beat(1000);
    follower.check(3400);
    expect(tempo.getState().running).toBe(true);
    follower.check(3600);
    expect(tempo.getState().running).toBe(false);
  });

  it('never idles the effects for the bpm without beats: the trigger may not be turned on', () => {
    tempo.update({ source: 'rekordbox' });
    say(BPM_ADDRESS, 126);
    follower.check(60_000);
    expect(tempo.getState()).toMatchObject({ bpm: 126, running: true });
    expect(follower.getState()).toMatchObject({ status: 'live', beats: false });
  });

  describe('the position in the track', () => {
    beforeEach(() => tempo.update({ source: 'rekordbox' }));

    /** The position at 60 messages a second, moving, from `from` to `to` ms on the clock. */
    const play = (from: number, to: number) => {
      for (let at = from; at <= to; at += 16) say(TIME_ADDRESS, (at - from) / 1000 + 10, at);
    };

    it('keeps the effects running while the position moves', () => {
      play(1000, 2000);
      follower.check(2100);
      expect(tempo.getState().running).toBe(true);
    });

    it('stops the effects when the position stands still for 0.3 s, and not before', () => {
      play(1000, 2000);
      follower.check(2250);
      expect(tempo.getState().running).toBe(true);
      follower.check(2350);
      expect(tempo.getState().running).toBe(false);
    });

    it('takes the same position again and again, or a flicker of it, for standing still', () => {
      play(1000, 1500); // ends at 10.496
      for (let at = 1516; at <= 2400; at += 16) say(TIME_ADDRESS, 10.496 + (at % 2) * 0.0001, at);
      expect(tempo.getState().running).toBe(false);
    });

    it('starts the effects again when the position moves, without waiting for a beat', () => {
      play(1000, 1500);
      follower.check(2000);
      expect(tempo.getState().running).toBe(false);
      play(3000, 3100);
      expect(tempo.getState().running).toBe(true);
    });

    it('puts the beat right at once on the first beat after a pause', () => {
      play(1000, 1500);
      follower.check(2000);
      play(3000, 3100);
      clock = 3130; // 120 bpm, origin at 1000: the count says 4.26
      beat(3130);
      expect(tempo.beatAt(3130) % 1).toBeCloseTo(0, 6);
    });

    it('works with no beat trigger at all, and the beats are then not there', () => {
      play(1000, 1500);
      follower.check(2000);
      expect(tempo.getState().running).toBe(false);
      expect(follower.getState()).toMatchObject({ status: 'live', beats: false });
    });

    it('does not stop the effects by hand, and stops them at once when rekordbox is chosen', () => {
      tempo.update({ source: 'manual' });
      play(1000, 1500);
      follower.check(2000);
      expect(tempo.getState().running).toBe(true);
      tempo.update({ source: 'rekordbox' });
      expect(tempo.getState().running).toBe(false);
    });

    it('stops for whichever goes first: a position that stands still, or beats that stop', () => {
      beat(1000);
      play(1000, 1100);
      // The position goes on moving, but no beat comes for 2.5 beats (1250 ms at 120 bpm).
      play(1116, 2400);
      follower.check(2300);
      expect(tempo.getState().running).toBe(false);
    });
  });

  describe('readPhrase', () => {
    it('reads the numbers of rkbx_link: 4 is the breakdown, whatever the mood', () => {
      expect(readPhrase(4)).toEqual({ name: 'Bridge / Down', breakdown: true });
      expect(readPhrase(4.0)?.breakdown).toBe(true);
      for (const n of [1, 2, 3, 5]) expect(readPhrase(n)?.breakdown).toBe(false);
    });

    it('reads the names: Down and Bridge are breakdowns, the rest are not', () => {
      for (const name of ['Down', 'down', 'Bridge', 'Down 1']) {
        expect(readPhrase(name)?.breakdown, name).toBe(true);
      }
      for (const name of [
        'Intro',
        'Intro 1',
        'Verse 3',
        'Up 2',
        'Chorus',
        'Outro 2',
        'Downtempo',
      ]) {
        expect(readPhrase(name)?.breakdown, name).toBe(false);
      }
      expect(readPhrase(' Down ')?.name).toBe('Down');
    });

    it('takes what is no phrase for none: 0, an empty name, a number past the table, a blob', () => {
      for (const value of [0, 6, -1, Number.NaN, '', '  ', true, null, new Uint8Array(2)]) {
        expect(readPhrase(value), String(value)).toBeUndefined();
      }
      expect(readPhrase(undefined)).toBeUndefined();
    });
  });

  describe('a breakdown', () => {
    const phrase = (value: number | string, at = clock) =>
      receiver.emit('message', { address: PHRASE_ADDRESS, args: [value] }, at);
    /** The music playing: beats at 120 bpm and the position moving, up to `to`. */
    const playing = (to: number, from = 1000) => {
      for (let at = from; at <= to; at += 16) {
        say(TIME_ADDRESS, at / 1000, at);
        if ((at - 1000) % 496 < 16) beat(at);
      }
    };

    beforeEach(() => tempo.update({ source: 'rekordbox' }));

    it('does nothing unless it is turned on: the phrase is shown, and the effects run', () => {
      playing(1500);
      phrase('Down', 1500);
      expect(follower.getState().breakdown).toEqual({
        enabled: false,
        phrase: 'Down',
        active: false,
      });
      expect(tempo.getState().running).toBe(true);
    });

    it('leaves the effects idle for a breakdown when on, and runs them again after it', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase('Chorus', 1500);
      expect(tempo.getState().running).toBe(true);
      phrase('Down', 1520);
      expect(tempo.getState().running).toBe(false);
      expect(follower.getState().breakdown).toMatchObject({ active: true, phrase: 'Down' });
      phrase('Up 1', 1600);
      expect(tempo.getState().running).toBe(true);
    });

    it('works with the numbers, and follows the beat under the breakdown', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase(4, 1500);
      expect(tempo.getState().running).toBe(false);
      // A beat comes under it, 30 ms late: the beats are pulled a quarter of the way, no snap.
      const before = tempo.beatAt(2000);
      clock = 2030;
      beat(2030);
      expect(tempo.beatAt(2000)).not.toBe(before);
      expect(tempo.getState().running).toBe(false);
    });

    it('does not put the beat right at once after it: the beats never stopped', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase(4, 1500);
      phrase(2, 1600);
      clock = 2000;
      const origin = tempo.timeOfBeat(0);
      beat(1996); // 4 ms off the grid at 120 bpm (origin 1000 + 2 beats)
      // A quarter of 4 ms is 1 ms; snapping would move all 4.
      expect(Math.abs(tempo.timeOfBeat(0) - origin)).toBeLessThanOrEqual(1.01);
    });

    it('keeps a phrase until another comes: rkbx_link sends it only when it changes', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase('Down', 1500);
      expect(tempo.getState().running).toBe(false);
      // The music goes on (position and beats) for ten seconds and no phrase comes again.
      playing(11500, 1516);
      follower.check(11500);
      expect(tempo.getState().running).toBe(false);
      expect(follower.getState().breakdown).toMatchObject({ active: true, phrase: 'Down' });
    });

    describe('the track changes', () => {
      const title = (value: string, at = clock) =>
        receiver.emit('message', { address: TITLE_ADDRESS, args: [value] }, at);

      it('lets go of the phrase of the track before, so nothing stays idle by itself', () => {
        follower.update({ breakdown: true });
        title('One', 1000);
        playing(1500);
        phrase('Down', 1500);
        expect(tempo.getState().running).toBe(false);
        // The music goes on into the next track, which has no phrase analysis: a new title and no phrase.
        playing(9000, 1516);
        title('Two', 9000);
        expect(tempo.getState().running).toBe(true);
        expect(follower.getState().breakdown).toMatchObject({ active: false, phrase: undefined });
      });

      it('keeps the phrase that comes with the new title, whichever comes first', () => {
        follower.update({ breakdown: true });
        title('One', 1000);
        playing(1500);
        phrase('Chorus', 1500);
        playing(9000, 1516);
        title('Two', 9000);
        phrase('Down', 9010);
        expect(follower.getState().breakdown).toMatchObject({ active: true, phrase: 'Down' });
        playing(20000, 9016);
        phrase('Down', 20000);
        title('Three', 20010);
        expect(follower.getState().breakdown).toMatchObject({ active: true, phrase: 'Down' });
      });

      it('leaves a phrase alone for the first title and for the same title again', () => {
        follower.update({ breakdown: true });
        playing(1500);
        phrase('Down', 1500);
        playing(9000, 1516);
        title('One', 9000);
        expect(follower.getState().breakdown.phrase).toBe('Down');
        title('One', 12000);
        expect(follower.getState().breakdown.phrase).toBe('Down');
      });
    });

    it('takes a track without a phrase as no breakdown', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase('Down', 1500);
      expect(tempo.getState().running).toBe(false);
      phrase(0, 1520);
      expect(tempo.getState().running).toBe(true);
    });

    it('can be turned off in the middle of one, and the effects run again at once', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase('Bridge', 1500);
      expect(tempo.getState().running).toBe(false);
      clock = 1510;
      follower.update({ breakdown: false });
      expect(tempo.getState().running).toBe(true);
    });

    it('stays idle for the music that stopped, whatever the phrase says, and by hand never idles', () => {
      follower.update({ breakdown: true });
      playing(1500);
      phrase('Down', 1500);
      phrase('Chorus', 1520);
      follower.check(2600); // the position stood still for more than 0.3 s
      expect(tempo.getState().running).toBe(false);
      tempo.update({ source: 'manual' });
      expect(tempo.getState().running).toBe(true);
      phrase('Down', 2700);
      expect(tempo.getState().running).toBe(true);
    });

    it('is idle at once when rekordbox is chosen in the middle of a breakdown', () => {
      tempo.update({ source: 'manual' });
      follower.update({ breakdown: true });
      playing(1500);
      phrase('Down', 1500);
      tempo.update({ source: 'rekordbox' });
      expect(tempo.getState().running).toBe(false);
    });

    it('refuses what is not a setting, and changes nothing', () => {
      expect(() => follower.update({ breakdown: 'yes' })).toThrow(/true or false/);
      expect(() => follower.update({ colour: 'red' })).toThrow();
      expect(follower.getState().breakdown.enabled).toBe(false);
    });

    it('tells the listeners when it is turned on, and when a phrase comes', () => {
      const seen: RkbxState[] = [];
      follower.on('rkbx', (state: RkbxState) => seen.push(state));
      follower.update({ breakdown: true });
      expect(seen.at(-1)?.breakdown.enabled).toBe(true);
      phrase('Down');
      expect(seen.at(-1)?.breakdown).toMatchObject({ phrase: 'Down', active: true });
    });
  });

  describe('the track', () => {
    const text = (address: string, value: string, at = clock) =>
      receiver.emit('message', { address, args: [value] }, at);
    const told: TrackInfo[] = [];

    beforeEach(() => {
      told.length = 0;
      follower.on('track', (track: TrackInfo) => told.push(track));
    });

    it('tells of a track once its title and artist have stopped changing, in either order', () => {
      text(ARTIST_ADDRESS, 'Charlotte de Witte');
      text(TITLE_ADDRESS, 'Doppler');
      follower.check(clock + 500);
      expect(told).toEqual([]);
      follower.check(clock + 900);
      expect(told).toEqual([{ title: 'Doppler', artist: 'Charlotte de Witte' }]);
      follower.check(clock + 5000);
      expect(told).toHaveLength(1);
    });

    it('waits for an artist that comes after the title', () => {
      text(TITLE_ADDRESS, 'Doppler');
      follower.check(clock + 500);
      text(ARTIST_ADDRESS, 'Charlotte de Witte', clock + 500);
      follower.check(clock + 1200);
      expect(told).toEqual([]);
      follower.check(clock + 1400);
      expect(told).toEqual([{ title: 'Doppler', artist: 'Charlotte de Witte' }]);
    });

    it('keeps the artist when the next track has the same one, which rkbx_link does not repeat', () => {
      text(ARTIST_ADDRESS, 'Amelie Lens');
      text(TITLE_ADDRESS, 'Hypnotized');
      follower.check(clock + 900);
      text(TITLE_ADDRESS, 'Exhale', clock + 2000);
      follower.check(clock + 3000);
      expect(told.at(-1)).toEqual({ title: 'Exhale', artist: 'Amelie Lens' });
      expect(follower.getTrack()).toEqual({ title: 'Exhale', artist: 'Amelie Lens' });
    });

    it('does not tell of a title that did not change, and tells of a track without an artist', () => {
      text(TITLE_ADDRESS, 'Untitled');
      follower.check(clock + 900);
      text(TITLE_ADDRESS, 'Untitled', clock + 1000);
      follower.check(clock + 3000);
      expect(told).toEqual([{ title: 'Untitled', artist: '' }]);
    });
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

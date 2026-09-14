import { describe, expect, it } from 'vitest';
import { VoicePool, withinHearing } from '../src/sound.js';

/**
 * Звук тестом не услышать — проверяется только то, что держит его в рамках:
 * голосов не больше пула, и дальний звук голоса не отнимает.
 */

/** Голос-пустышка: звучит, пока его не отпустили. */
interface FakeVoice {
  id: number;
  playing: boolean;
}

function pool(size: number) {
  let next = 0;
  const made: FakeVoice[] = [];
  const voices = new VoicePool<FakeVoice>(
    size,
    () => {
      const voice = { id: next++, playing: false };
      made.push(voice);
      return voice;
    },
    (voice) => !voice.playing,
  );
  return { voices, made };
}

describe('пул голосов', () => {
  it('новых голосов не заводит, сколько ни проси', () => {
    const { voices, made } = pool(3);
    for (let now = 0; now < 50; now++) voices.take(now).playing = true;
    expect(made).toHaveLength(3);
  });

  it('свободный голос отдаёт раньше занятого', () => {
    const { voices, made } = pool(3);
    voices.take(1).playing = true;
    voices.take(2).playing = true;
    made[2]!.playing = false;
    expect(voices.take(3)).toBe(made[2]);
  });

  it('все заняты — забирает самый старый', () => {
    const { voices } = pool(3);
    const first = voices.take(1);
    first.playing = true;
    voices.take(2).playing = true;
    voices.take(3).playing = true;
    expect(voices.take(4)).toBe(first);
  });
});

describe('слышимость', () => {
  it('дальше предела звук не слышен', () => {
    const listener = { x: 0, y: 0, z: 0 };
    expect(withinHearing(listener, { x: 10, y: 0, z: 0 }, 12)).toBe(true);
    expect(withinHearing(listener, { x: 13, y: 0, z: 0 }, 12)).toBe(false);
  });
});

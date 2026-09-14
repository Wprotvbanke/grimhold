import { describe, expect, it } from 'vitest';
import { TAVERN } from '@grimhold/shared';
import { musicSceneAt } from '../src/music.js';

const NOON = 0.5;
const MIDNIGHT = 0;

describe('музыка по сценарию', () => {
  it('в городе днём и ночью играет разное', () => {
    expect(musicSceneAt(0, 0, false, NOON)).toBe('day');
    expect(musicSceneAt(0, 0, false, MIDNIGHT)).toBe('night');
  });

  it('в зале таверны своя музыка в любой час', () => {
    expect(musicSceneAt(TAVERN.x, TAVERN.z, false, MIDNIGHT)).toBe('tavern');
  });

  it('в диких землях и в подземелье тишина', () => {
    expect(musicSceneAt(500, 500, false, NOON)).toBeNull();
    expect(musicSceneAt(0, 0, true, NOON)).toBeNull();
  });
});

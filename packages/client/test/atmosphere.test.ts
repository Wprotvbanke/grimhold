import { describe, expect, it } from 'vitest';
import { TOWN_SIZE, type SelfState } from '@grimhold/shared';
import { createAtmosphere, sceneryAt } from '../src/atmosphere.js';

/**
 * Звуки вылазки — это переходы. Проверяется то, что легко сломать: звучит
 * смена, а не состояние, и только та смена, которую игрок застал.
 */

function listen() {
  const heard: string[] = [];
  const atmosphere = createAtmosphere({
    play: (id) => heard.push(id),
    startLoop: (key) => heard.push(`start:${key}`),
    stopLoop: (key) => heard.push(`stop:${key}`),
    setAmbience: (id) => heard.push(`ambience:${id}`),
    setNearby: () => {},
  });
  return { atmosphere, heard };
}

function state(overrides: Partial<SelfState> = {}): SelfState {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    onGround: true,
    health: 100,
    maxHealth: 100,
    mana: 50,
    maxMana: 50,
    stamina: 100,
    maxStamina: 100,
    alive: true,
    blocking: false,
    invulnerable: 0,
    exhausted: 0,
    light: 0,
    flag: 'white',
    karma: 0,
    ...overrides,
  };
}

/** Точка заведомо за городскими стенами. */
const WILD = TOWN_SIZE;

describe('звуки вылазки', () => {
  it('гонг бьёт один раз, когда хозяин пал на глазах', () => {
    const { atmosphere, heard } = listen();
    atmosphere.self(state({ bossAlive: true }), false);
    for (let tick = 0; tick < 5; tick++) atmosphere.self(state({ bossAlive: false }), false);
    expect(heard.filter((id) => id === 'gong')).toHaveLength(1);
  });

  it('в зал с давно убитым хозяином гонг не звучит', () => {
    const { atmosphere, heard } = listen();
    atmosphere.moved();
    atmosphere.self(state({ bossAlive: false }), false);
    expect(heard).not.toContain('gong');
  });

  it('фон меняется на смене места, а не каждый кадр', () => {
    const { atmosphere, heard } = listen();
    for (let frame = 0; frame < 10; frame++) atmosphere.where(WILD, WILD, false);
    atmosphere.where(0, 0, true);
    expect(heard).toEqual(['ambience:ambWild', 'ambience:ambDungeon']);
  });

  it('город, дикие земли и подземелье различаются по месту', () => {
    expect(sceneryAt(0, 0, false)).toBe('town');
    expect(sceneryAt(WILD, WILD, false)).toBe('wild');
    // Подземелье — по миру, а не по координатам: они там свои.
    expect(sceneryAt(0, 0, true)).toBe('dungeon');
  });

  it('факел трещит, пока горит, и гаснет со смертью', () => {
    const { atmosphere, heard } = listen();
    atmosphere.self(state({ light: 200 }), true);
    atmosphere.self(state({ light: 199 }), true);
    atmosphere.died();
    expect(heard).toEqual(['start:torch', 'stop:torch']);
  });
});

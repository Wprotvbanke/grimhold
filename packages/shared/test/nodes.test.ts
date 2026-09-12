import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, NODES, findNode, generateNodes, type NodeId } from '../src/index.js';

/**
 * Ресурсные ноды выводятся генератором на обеих сторонах, и сервер ничего
 * о них не хранит. Значит проверять надо ровно две вещи: что раскладка
 * одинакова всегда и везде, и что нода находится по своему имени.
 * Разойдись одно из двух — игрок будет рубить воздух, а сервер отказывать.
 */

describe('ресурсные ноды', () => {
  it('раскладка одинакова при каждом вызове', () => {
    const first = generateNodes(2, -1);
    const second = generateNodes(2, -1);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('в городе нод нет', () => {
    expect(generateNodes(0, 0)).toHaveLength(0);
  });

  it('нода находится по имени и совпадает с раскладкой', () => {
    const nodes = generateNodes(-2, 3);
    const wanted = nodes[Math.floor(nodes.length / 2)]!;

    expect(findNode(wanted.id)).toEqual(wanted);
  });

  it('мусорное имя не находит ничего', () => {
    for (const id of ['', 'abc', '1.2', '1.2.999', 'x.y.z']) {
      expect(findNode(id), id).toBeNull();
    }
  });

  it('встречаются все шесть видов, и каждый стоит в своём чанке', () => {
    const seen = new Set<NodeId>();

    for (const node of generateNodes(1, 1)) {
      seen.add(node.nodeId);
      // Нода обязана лежать в границах своего чанка: иначе она попадёт
      // в столкновения одного чанка, а рисоваться будет в другом.
      expect(Math.abs(node.x - CHUNK_SIZE)).toBeLessThan(CHUNK_SIZE / 2);
      expect(Math.abs(node.z - CHUNK_SIZE)).toBeLessThan(CHUNK_SIZE / 2);
    }

    expect([...seen].sort()).toEqual(Object.keys(NODES).sort());
  });
});

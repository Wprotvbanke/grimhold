/**
 * Полевые работы для приёмочных скриптов: дойти, добыть, связать инструмент.
 *
 * Заведено, когда из стартового набора убрали топор. До этого три проверки
 * просто доставали его из рюкзака; теперь путь к инструментам такой же, как
 * у игрока, — и переписывать этот путь в каждом скрипте по-своему значило бы
 * получить три разных представления о том, как начинается игра.
 */
import {
  INPUT_DT,
  NODES,
  RECIPES,
  RESPAWN_DELAY,
  TICK_RATE,
  generateNodes,
  type ItemId,
  type NodeId,
  type RecipeId,
  type ResourceNode,
} from '@grimhold/shared';
import { TestClient, sleep } from './testClient.js';

let seq = 0;

/**
 * Шагает к точке, пока не подойдёт ближе `stop` метров или не выйдет время.
 *
 * Навигации в игре нет, и ходок упирается в стволы и валуны честно, как игрок.
 * Поэтому здесь простейший обход: если расстояние перестало сокращаться —
 * несколько шагов боком и снова вперёд. Без этого проверка падала не на
 * добыче, а на первом же дереве по дороге.
 */
export async function walkTo(
  client: TestClient,
  to: { x: number; z: number },
  stop: number,
): Promise<number> {
  let closest = Infinity;
  let stuck = 0;
  let sidestep = 0;

  for (let step = 0; step < 600; step++) {
    const self = client.latestSnapshot?.self;
    if (!self) break;

    const distance = Math.hypot(to.x - self.x, to.z - self.z);
    if (distance <= stop) return distance;

    if (distance < closest - 0.05) {
      closest = distance;
      stuck = 0;
    } else if (++stuck > 6 && sidestep <= 0) {
      // Сторону чередуем: если обход вправо не помог, следующий раз влево.
      sidestep = 14;
      stuck = 0;
    }

    // При forward = 1 движение идёт в (−sin yaw, −cos yaw) — отсюда обратное.
    const yaw = Math.atan2(-(to.x - self.x), -(to.z - self.z));
    const right = sidestep > 0 ? (Math.floor(step / 40) % 2 === 0 ? 1 : -1) : 0;
    if (sidestep > 0) sidestep--;

    for (let i = 0; i < 4; i++) {
      client.send({
        t: 'input',
        seq: seq++,
        forward: right === 0 ? 1 : 0.4,
        right,
        yaw,
        pitch: 0,
        jump: false,
        sprint: true,
        dt: INPUT_DT,
      });
    }
    await sleep(1000 / TICK_RATE);
  }

  const self = client.latestSnapshot?.self;
  return self ? Math.hypot(to.x - self.x, to.z - self.z) : Infinity;
}

/** Сколько этого добра в рюкзаке. */
export function carried(client: TestClient, defId: string): number {
  let total = 0;
  for (const item of client.inventory?.backpack.items ?? []) {
    if (item.defId === defId) total += item.count;
  }
  return total;
}

/**
 * Поднимает павшего и отвечает, поднимал ли.
 *
 * Пока добыча была мгновенной, проверки почти не рисковали. Теперь игрок
 * стоит у ноды секундами, и волк успевает подойти — это ровно та цена, ради
 * которой добыча и сделана работой. Проверке остаётся её пережить.
 */
export async function reviveIfDead(client: TestClient): Promise<boolean> {
  if (client.latestSnapshot?.self.alive !== false) return false;

  client.send({ t: 'respawn' });
  // Ранняя просьба не пропадает: сервер поднимет, как только выйдет срок.
  // Срок берём из общего правила — он растёт с каждой быстрой смертью.
  await sleep(RESPAWN_DELAY * 1000 + 1500);
  return true;
}

/** Ноды такого вида из ближних к городу чанков, от ближней к дальней. */
export function nodesNearTown(nodeId: NodeId): ResourceNode[] {
  const found: ResourceNode[] = [];
  for (const cx of [-1, 0, 1]) {
    for (const cz of [-1, 0, 1]) {
      for (const node of generateNodes(cx, cz)) {
        if (node.nodeId === nodeId) found.push(node);
      }
    }
  }
  return found.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
}

/**
 * То же, но без выработанных.
 *
 * Мир у проверок общий и живой: нода, которую вычерпал прошлый прогон,
 * восстанавливается минутами. Без этой поправки проверка падала не на
 * поломке, а на собственном следе.
 */
export function usableNodes(client: TestClient, nodeId: NodeId): ResourceNode[] {
  const spent = new Set(client.latestSnapshot?.depletedNodes ?? []);
  return nodesNearTown(nodeId).filter((node) => !spent.has(node.id));
}

export function nearestNode(client: TestClient, nodeId: NodeId): ResourceNode | null {
  return usableNodes(client, nodeId)[0] ?? null;
}

/**
 * Доходит до целой ноды такого вида и отдаёт её.
 *
 * Издалека узнать, пуста ли нода, нельзя: сервер шлёт выработанные только
 * поблизости. Поэтому проверяем не по списку, а придя на место — как игрок,
 * который видит пень, только подойдя к нему.
 */
export async function findLiveNode(
  client: TestClient,
  nodeId: NodeId,
  limit = 5,
): Promise<ResourceNode | null> {
  for (const node of nodesNearTown(nodeId).slice(0, limit)) {
    await walkTo(client, node, 2.4);
    await sleep(200);
    const spent = new Set(client.latestSnapshot?.depletedNodes ?? []);
    if (!spent.has(node.id)) return node;
  }
  return null;
}

/**
 * Добывает нужное количество, обходя ноды от ближней к дальней.
 *
 * Одна нода отдаёт свои заряды и пустеет, поэтому на большое количество
 * одной не хватит — как и игроку.
 */
export async function gather(
  client: TestClient,
  defId: ItemId,
  wanted: number,
  limit = 4,
): Promise<number> {
  const profile = Object.values(NODES).find((entry) => entry.itemId === defId);
  if (!profile) throw new Error(`нечем добыть ${defId}: нет такой ноды`);

  const start = carried(client, defId);
  const nodes = usableNodes(client, profile.id).slice(0, limit);

  for (const node of nodes) {
    if (carried(client, defId) - start >= wanted) break;
    await reviveIfDead(client);
    await walkTo(client, node, 2.4);

    // Подошли — теперь видно, выработана ли она.
    await sleep(200);
    if ((client.latestSnapshot?.depletedNodes ?? []).includes(node.id)) continue;

    for (let i = 0; i < profile.charges + 1; i++) {
      if (carried(client, defId) - start >= wanted) break;
      if (await reviveIfDead(client)) await walkTo(client, node, 2.4);
      client.send({ t: 'harvest', nodeId: node.id });
      // Добыча занимает время: ждём столько же, сколько ждёт игрок.
      await sleep(profile.time * 1000 + 400);
    }
  }

  return carried(client, defId) - start;
}

/** Делает вещь и дожидается конца работы: изделие появляется в конце. */
export async function craft(client: TestClient, recipeId: RecipeId): Promise<void> {
  client.send({ t: 'craft', recipeId });
  await sleep(RECIPES[recipeId].duration * 1000 + 600);
}

/**
 * Путь новичка целиком: набрать руками и связать инструмент.
 *
 * Сырьё считается по самому рецепту, а не переписано числами: разойдись они,
 * проверка падала бы не там, где сломано.
 */
export async function makeTool(client: TestClient, recipeId: RecipeId): Promise<boolean> {
  const recipe = RECIPES[recipeId];

  for (const input of recipe.inputs) {
    const missing = input.count - carried(client, input.itemId);
    if (missing > 0) await gather(client, input.itemId, missing);
    if (carried(client, input.itemId) < input.count) return false;
  }

  await craft(client, recipeId);
  return carried(client, recipe.output.itemId) > 0;
}

/** Берёт вещь из рюкзака в руку. */
export async function equip(client: TestClient, defId: ItemId): Promise<boolean> {
  const item = client.inventory?.backpack.items.find((entry) => entry.defId === defId);
  if (!item) return false;

  client.send({ t: 'equip', x: item.x, y: item.y });
  await sleep(400);
  return client.inventory?.equipment.mainHand?.defId === defId;
}

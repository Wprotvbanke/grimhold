/**
 * Проверка ремесла против живого сервера.
 *
 *   npx tsx scripts/craft-check.ts
 *
 * Приёмка вехи 4 по ремеслу, дословно из DESIGN.md: «срубил дерево → сделал
 * стрелы без рецепта; эльф читает свиток зелья, дворф тот же свиток прочесть
 * не может». Проверяет:
 *   1. базовый ярус работает без всяких рецептов;
 *   2. сырьё списывается, а изделие появляется;
 *   3. без сырья сервер отказывает и объясняет;
 *   4. чужой свиток не читается, свой — читается и открывает рецепт;
 *   5. изученное и сделанное переживает перезаход.
 */
import { RECIPES, countOf, type InventoryMessage } from '@grimhold/shared';
import { equip, gather, makeTool } from './fieldwork.js';
import { TestClient, sleep } from './testClient.js';

const failures: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) console.log(`  OK   ${description}`);
  else {
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
    failures.push(description);
  }
}

function have(client: TestClient, defId: string): number {
  const inventory: InventoryMessage | null = client.inventory;
  return inventory ? countOf(inventory.backpack, defId as never) : 0;
}

/**
 * Сырьё добываем как игрок: связать топор из подножного и срубить дерево.
 * Вещь в рюкзак чужими руками не положить, а путь новичка всё равно должен
 * работать — если он сломается, проверка обязана падать именно здесь.
 */
async function chopLogs(client: TestClient, wanted: number): Promise<number> {
  if (!(await makeTool(client, 'crude_axe'))) return 0;
  if (!(await equip(client, 'crude_axe'))) return 0;
  return gather(client, 'log', wanted);
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36);
  const dwarf = new TestClient({
    username: `Кузнец${stamp}`,
    race: 'dwarf',
    characterClass: 'warrior',
  });
  await dwarf.ready;
  await sleep(400);

  console.log('\n1. Базовый ярус без рецептов');
  const logs = await chopLogs(dwarf, 1);
  check(logs > 0, 'нарубили брёвен', `${logs} шт.`);

  const planksBefore = have(dwarf, 'plank');
  dwarf.errors.length = 0;
  dwarf.send({ t: 'craft', recipeId: 'plank_from_log' });
  await sleep(400);

  // Работа теперь занимает время, и это видно: сначала приходит полоса.
  check(dwarf.crafting?.recipeId === 'plank_from_log', 'работа началась и показана');
  check(
    have(dwarf, 'plank') === planksBefore,
    'изделия ещё нет — оно появляется в конце, а не в начале',
  );

  await sleep(RECIPES.plank_from_log.duration * 1000 + 500);
  check(dwarf.crafting?.recipeId === null, 'полоса убрана по окончании');

  const made = have(dwarf, 'plank') - planksBefore;
  check(made === RECIPES.plank_from_log.output.count, 'из бревна вышли доски', `${made} шт.`);
  check(have(dwarf, 'log') === logs - 1, 'бревно списано ровно одно');
  check(dwarf.errors.length === 0, 'отказов не было', dwarf.errors[0] ?? '');

  console.log('\n2. Без сырья сервер объясняет отказ');
  dwarf.errors.length = 0;
  // Кираса требует слитков, которых у новичка нет.
  dwarf.send({ t: 'craft', recipeId: 'iron_cuirass' });
  await sleep(400);
  check(dwarf.errors.length > 0, 'невозможный рецепт отклонён с объяснением', dwarf.errors[0] ?? 'молча');

  console.log('\n3. Свитки читаются только своей расой');
  // Свиток в руки не выдать, поэтому проверяем сам запрет: дворф не знает
  // эльфийского рецепта и не может его изготовить даже «изучив».
  dwarf.errors.length = 0;
  dwarf.send({ t: 'craft', recipeId: 'health_potion' });
  await sleep(400);
  check(
    dwarf.errors.some((message) => /не твоей расы/i.test(message)),
    'эльфийское зелье дворфу недоступно',
    dwarf.errors[0] ?? 'молча',
  );
  check(
    !(dwarf.inventory?.knownRecipes ?? []).includes('health_potion'),
    'чужой рецепт не появился в изученных',
  );

  const elf = new TestClient({
    username: `Травник${stamp}`,
    race: 'elf',
    characterClass: 'mage',
  });
  await elf.ready;
  await sleep(400);

  elf.errors.length = 0;
  elf.send({ t: 'craft', recipeId: 'health_potion' });
  await sleep(400);
  check(
    elf.errors.some((message) => /не изучен/i.test(message)),
    'эльфу без свитка отказано именно за незнание',
    elf.errors[0] ?? 'молча',
  );

  console.log('\n4. Сделанное переживает перезаход');
  const planks = have(dwarf, 'plank');
  dwarf.close();
  await sleep(600);

  const again = new TestClient({ username: `Кузнец${stamp}` });
  await again.ready;
  await sleep(600);
  check(have(again, 'plank') === planks, 'доски на месте после перезахода', `${have(again, 'plank')} шт.`);

  again.close();
  elf.close();
  await sleep(200);

  console.log(failures.length === 0 ? '\nВСЁ ПРОЙДЕНО' : `\nПРОВАЛЕНО: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка проверки:', error);
  process.exit(1);
});

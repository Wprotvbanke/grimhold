/**
 * Снимок одной модели настоящим браузером.
 *
 *   npx tsx scripts/model-shot.ts gnome Walk [файл.png] [поворот°] [секунда] [отдаление]
 *
 * Первым идёт **имя** модели из public/models, а не путь: Git Bash переписывает
 * аргумент, начинающийся со слэша, в путь Windows — и загрузчик уходит искать
 * файл на диске вместо сервера.
 *
 * Нужен затем же, зачем и снимок игры: как выглядит модель, знает только глаз.
 * Разница в том, что до модели в мире ещё надо дойти — поставить NPC, поймать
 * его в кадр, дождаться нужного клипа. Здесь она стоит перед камерой сразу.
 *
 * На этом поймались обе ошибки сборки гнома: развёртка вверх ногами (лицо
 * уехало на живот) и движение корня в клипе (модель уезжала из кадра).
 *
 * Работает против запущенного `npm run dev`.
 */
import puppeteer from 'puppeteer';

const NAME = process.argv[2] ?? 'gnome';
const SOURCE = `/models/${NAME.endsWith('.glb') ? NAME : `${NAME}.glb`}`;
const CLIP = process.argv[3] ?? '';
const OUTPUT = process.argv[4] ?? 'model.png';
const TURN = process.argv[5] ?? '0';
const AT = process.argv[6] ?? '3';
/** Отдаление камеры: поза может увести модель далеко за её габариты в покое. */
const ZOOM = process.argv[7] ?? '1';

const browser = await puppeteer.launch({
  headless: true,
  // Без этих флагов WebGL в headless не поднимается: нужен программный вывод.
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  page.on('pageerror', (error) => console.log('  [ошибка]', String(error).slice(0, 200)));
  // Что именно не догрузилось — иначе загрузчик three скажет только
  // «Failed to fetch», без адреса.
  page.on('requestfailed', (request) =>
    console.log('  [не загрузилось]', request.url(), request.failure()?.errorText ?? ''),
  );

  const address =
    `http://localhost:5173/model.html?src=${encodeURIComponent(SOURCE)}` +
    `&clip=${encodeURIComponent(CLIP)}&turn=${TURN}&at=${AT}&zoom=${ZOOM}`;
  await page.goto(address, { waitUntil: 'networkidle2', timeout: 60000 });

  // Ждём, пока страница доиграет клип до заданной секунды и замрёт.
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, {
    timeout: 60000,
  });

  const report = await page.evaluate(() =>
    JSON.stringify((window as unknown as { report: unknown }).report),
  );
  console.log(report);

  await page.screenshot({ path: OUTPUT });
  console.log(`снимок сохранён: ${OUTPUT}`);
} finally {
  await browser.close();
}

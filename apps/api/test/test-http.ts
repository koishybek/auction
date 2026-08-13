import type { INestApplication } from '@nestjs/common';

/**
 * Заставить приложение слушать порт один раз на весь файл тестов.
 *
 * Supertest, получив ещё не слушающий сервер, поднимает его на время запроса и
 * гасит после ответа. При последовательных запросах это незаметно, но наши
 * DoD-проверки бьют двумя десятками запросов одновременно — и тогда они
 * поднимают и гасят один и тот же сервер наперегонки. Часть соединений
 * получает ECONNRESET, часть доезжает уже после очистки базы в следующем тесте
 * и падает на «запись не найдена».
 *
 * На быстрой машине гонка почти не проявляется, на раннере CI — проявляется
 * стабильно. Именно так она и нашлась.
 *
 * Порт 0 — свободный выберет ОС: файлы e2e идут последовательно, но
 * фиксированный порт всё равно однажды окажется занят чужим процессом.
 */
export async function listenForSupertest(app: INestApplication): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = app.getHttpServer() as {
      listen(port: number, cb: () => void): unknown;
      once(event: string, cb: (error: Error) => void): unknown;
    };
    server.once('error', reject);
    server.listen(0, resolve);
  });
}

import { toTenge, tiyn } from '@auction/shared';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { STORAGE_PROVIDER, type StorageProvider } from '../integrations/storage/storage.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Официальный протокол торгов (T-044, FR-06, ОВ-6).
 *
 * Форма протокола ТЗ не приложена — её дают юристы заказчика (ОВ-6). Поэтому
 * здесь шаблон-заглушка с полным набором фактов: лот, победитель, цена, вся
 * лента ставок и серверное время каждой. Когда придёт настоящая форма,
 * поменяется вёрстка, а не источник данных.
 *
 * Документ — HTML, а не PDF, и это осознанно. PDF без встроенного шрифта не
 * умеет кириллицу, а протокол на латинице юридического смысла не имеет;
 * встраивать шрифт под неизвестную ещё форму — работа впустую. HTML печатается
 * в PDF любым браузером и остаётся проверяемым глазами. Решение записано в
 * плане как дополнение к ОВ-6.
 */
@Injectable()
export class ProtocolService {
  private readonly logger = new Logger(ProtocolService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Сформировать протокол, если торги закрыты и все ставки доехали в базу.
   *
   * Проверка полноты обязательна. Ставки попадают в PostgreSQL отдельным
   * процессом, и протокол, собранный на секунду раньше, потеряет последние
   * ставки — а это официальный документ, по которому разбирают спор. Лучше
   * позже, чем неполный.
   *
   * Возвращает id документа или `null`, если формировать пока рано.
   */
  async generateIfComplete(sessionId: string): Promise<string | null> {
    const session = await this.prisma.auctionSession.findUnique({
      where: { id: sessionId },
      include: { lot: true },
    });
    if (session === null || session.status !== 'FINISHED') {
      return null;
    }
    if (session.protocolDocId !== null) {
      // Уже сформирован: протокол один на сессию, и переписывать его нельзя.
      return session.protocolDocId;
    }

    const bids = await this.prisma.bid.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });

    // Полнота проверяется по цене: последняя записанная ставка обязана
    // совпасть с итоговой ценой лота. Не совпала — перенос ставок ещё не
    // закончился, и собирать документ рано.
    const finalPriceTiyn = session.lot.currentPriceTiyn ?? session.lot.startPriceTiyn;
    const lastBidTiyn = bids[bids.length - 1]?.amountTiyn ?? session.lot.startPriceTiyn;
    if (lastBidTiyn !== finalPriceTiyn) {
      this.logger.debug(`Сессия ${sessionId}: ставки ещё не все в базе, протокол отложен`);
      return null;
    }

    const winner = bids[bids.length - 1] ?? null;
    const html = renderProtocol({
      lot: {
        id: session.lot.id,
        type: session.lot.type,
        cadastreOrVin: session.lot.cadastreOrVin,
        startPriceTenge: Number(toTenge(tiyn(session.lot.startPriceTiyn))),
      },
      session: {
        id: session.id,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt ?? session.startedAt,
      },
      finalPriceTenge: Number(toTenge(tiyn(finalPriceTiyn))),
      winnerBlindId: winner?.blindCode ?? null,
      bids: bids.map((bid) => ({
        seq: bid.seq,
        blindCode: bid.blindCode,
        amountTenge: Number(toTenge(tiyn(bid.amountTiyn))),
        serverTs: bid.serverTs,
      })),
    });

    const body = Buffer.from(html, 'utf8');
    const key = `protocols/${session.lot.id}/${session.id}.html`;
    const stored = await this.storage.put({ key, body, contentType: 'text/html; charset=utf-8' });

    const document = await this.prisma.lotDocument.create({
      data: {
        lotId: session.lot.id,
        kind: 'PROTOCOL',
        fileKey: stored.key,
        fileName: `Протокол торгов ${session.lot.cadastreOrVin}.html`,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
      },
    });

    // Связь с сессией и победившей ставкой — тем же шагом: по протоколу
    // должно быть видно, какая именно ставка закрыла торги.
    await this.prisma.auctionSession.updateMany({
      where: { id: sessionId, protocolDocId: null },
      data: {
        protocolDocId: document.id,
        ...(winner === null ? {} : { winnerBidId: winner.id }),
      },
    });

    this.logger.log(
      `Сессия ${sessionId}: протокол сформирован, ставок ${String(bids.length)}, ` +
        `итог ${String(finalPriceTiyn / 100n)} ₸`,
    );
    return document.id;
  }

  /** Все закрытые сессии, у которых протокола ещё нет. */
  async pendingSessions(limit = 50): Promise<string[]> {
    const sessions = await this.prisma.auctionSession.findMany({
      where: { status: 'FINISHED', protocolDocId: null },
      select: { id: true },
      orderBy: { finishedAt: 'asc' },
      take: limit,
    });
    return sessions.map((session) => session.id);
  }

  /** Протокол лота для скачивания. */
  async forLot(lotId: string): Promise<{ id: string; fileName: string }> {
    const document = await this.prisma.lotDocument.findFirst({
      where: { lotId, kind: 'PROTOCOL' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true },
    });
    if (document === null) {
      throw new NotFoundException({ code: 'PROTOCOL_NOT_READY' });
    }
    return document;
  }
}

interface ProtocolData {
  readonly lot: {
    readonly id: string;
    readonly type: string;
    readonly cadastreOrVin: string;
    readonly startPriceTenge: number;
  };
  readonly session: { readonly id: string; readonly startedAt: Date; readonly finishedAt: Date };
  readonly finalPriceTenge: number;
  readonly winnerBlindId: string | null;
  readonly bids: readonly {
    readonly seq: number;
    readonly blindCode: string;
    readonly amountTenge: number;
    readonly serverTs: Date;
  }[];
}

/** Экранирование: в документ попадают данные из базы, а не из наших рук. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function money(tenge: number): string {
  return `${tenge.toLocaleString('ru-KZ')} ₸`;
}

/** Только серверное время, в ISO: часы клиента в документе не участвуют. */
function moment(value: Date): string {
  return value.toISOString();
}

function renderProtocol(data: ProtocolData): string {
  const rows = data.bids
    .map(
      (bid) =>
        `<tr><td>${String(bid.seq)}</td><td>${escapeHtml(bid.blindCode)}</td>` +
        `<td class="num">${money(bid.amountTenge)}</td><td>${moment(bid.serverTs)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Протокол торгов ${escapeHtml(data.lot.cadastreOrVin)}</title>
<style>
body { font-family: Georgia, serif; margin: 40px; color: #111; }
h1 { font-size: 20px; }
table { border-collapse: collapse; width: 100%; margin-top: 16px; }
th, td { border: 1px solid #999; padding: 6px 10px; font-size: 13px; text-align: left; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
dt { font-weight: bold; margin-top: 10px; }
.note { margin-top: 32px; font-size: 12px; color: #555; }
</style>
</head>
<body>
<h1>Официальный протокол торгов</h1>
<dl>
<dt>Лот</dt><dd>${escapeHtml(data.lot.type)} · ${escapeHtml(data.lot.cadastreOrVin)}</dd>
<dt>Идентификатор лота</dt><dd>${escapeHtml(data.lot.id)}</dd>
<dt>Торговая сессия</dt><dd>${escapeHtml(data.session.id)}</dd>
<dt>Начало торгов (серверное время)</dt><dd>${moment(data.session.startedAt)}</dd>
<dt>Завершение торгов (серверное время)</dt><dd>${moment(data.session.finishedAt)}</dd>
<dt>Стартовая цена</dt><dd>${money(data.lot.startPriceTenge)}</dd>
<dt>Итоговая цена</dt><dd>${money(data.finalPriceTenge)}</dd>
<dt>Победитель</dt><dd>${data.winnerBlindId === null ? 'ставок не поступило' : escapeHtml(data.winnerBlindId)}</dd>
<dt>Принято ставок</dt><dd>${String(data.bids.length)}</dd>
</dl>

<h2>Лента ставок</h2>
<table>
<thead><tr><th>№</th><th>Участник</th><th>Цена</th><th>Серверное время</th></tr></thead>
<tbody>
${rows === '' ? '<tr><td colspan="4">Ставок не поступило</td></tr>' : rows}
</tbody>
</table>

<p class="note">
Участники обозначены псевдонимами, уникальными в рамках лота: раскрытие личности
участников торгов не производится. Все отметки времени — серверные.
Форма документа — предварительная (ОВ-6): окончательный текст утверждается юристами.
</p>
</body>
</html>`;
}

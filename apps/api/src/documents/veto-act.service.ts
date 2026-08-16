import { toTenge, tiyn } from '@auction/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { STORAGE_PROVIDER, type StorageProvider } from '../integrations/storage/storage.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Акт реализации Права ВЕТО и Цифрового Карантина (T-045, FR-17, ОВ-6).
 *
 * Приложение №3 к ТЗ не приложено — форма за юристами заказчика. Здесь
 * шаблон-заглушка с фактами, которые в акте будут при любой форме: какой
 * объект, какие торги, какая цена отклонена, кем и до какого числа наложен
 * карантин.
 *
 * Формат — HTML по тем же причинам, что у протокола (дополнение к ОВ-6).
 */
@Injectable()
export class VetoActService {
  private readonly logger = new Logger(VetoActService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Сформировать акт по лоту, на который наложено ВЕТО.
   *
   * Идемпотентно: акт по лоту один. Повторное ВЕТО невозможно — из VETOED лот
   * никуда не переходит, — но защита от повторного вызова здесь не лишняя:
   * документ, переписанный задним числом, перестаёт быть доказательством.
   */
  async generate(lotId: string): Promise<string> {
    const existing = await this.prisma.lotDocument.findFirst({
      where: { lotId, kind: 'VETO_ACT' },
      select: { id: true },
    });
    if (existing !== null) {
      return existing.id;
    }

    const lot = await this.prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    const session = await this.prisma.auctionSession.findFirst({
      where: { lotId, status: 'FINISHED' },
      orderBy: { finishedAt: 'desc' },
      include: { winnerBid: { select: { blindCode: true, amountTiyn: true } } },
    });

    const html = renderVetoAct({
      lotId: lot.id,
      cadastreOrVin: lot.cadastreOrVin,
      type: lot.type,
      startPriceTenge: Number(toTenge(tiyn(lot.startPriceTiyn))),
      finalPriceTenge:
        lot.currentPriceTiyn === null ? null : Number(toTenge(tiyn(lot.currentPriceTiyn))),
      winnerBlindId: session?.winnerBid?.blindCode ?? null,
      finishedAt: session?.finishedAt ?? null,
      lockoutUntil: lot.lockoutUntil,
    });

    const body = Buffer.from(html, 'utf8');
    const stored = await this.storage.put({
      key: `veto-acts/${lot.id}.html`,
      body,
      contentType: 'text/html; charset=utf-8',
    });

    const document = await this.prisma.lotDocument.create({
      data: {
        lotId: lot.id,
        kind: 'VETO_ACT',
        fileKey: stored.key,
        fileName: `Акт реализации Права ВЕТО ${lot.cadastreOrVin}.html`,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
      },
    });

    this.logger.log(`Лот ${lot.id}: сформирован Акт ВЕТО`);
    return document.id;
  }
}

interface VetoActData {
  readonly lotId: string;
  readonly cadastreOrVin: string;
  readonly type: string;
  readonly startPriceTenge: number;
  readonly finalPriceTenge: number | null;
  readonly winnerBlindId: string | null;
  readonly finishedAt: Date | null;
  readonly lockoutUntil: Date | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function money(tenge: number | null): string {
  return tenge === null ? '—' : `${tenge.toLocaleString('ru-KZ')} ₸`;
}

function moment(value: Date | null): string {
  return value === null ? '—' : value.toISOString();
}

function renderVetoAct(data: VetoActData): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Акт реализации Права ВЕТО ${escapeHtml(data.cadastreOrVin)}</title>
<style>
body { font-family: Georgia, serif; margin: 40px; color: #111; }
h1 { font-size: 20px; }
dt { font-weight: bold; margin-top: 10px; }
.note { margin-top: 32px; font-size: 12px; color: #555; }
.sign { margin-top: 48px; font-size: 13px; }
</style>
</head>
<body>
<h1>Акт реализации Права ВЕТО и Цифрового Карантина</h1>
<dl>
<dt>Объект</dt><dd>${escapeHtml(data.type)} · ${escapeHtml(data.cadastreOrVin)}</dd>
<dt>Идентификатор лота</dt><dd>${escapeHtml(data.lotId)}</dd>
<dt>Торги завершены (серверное время)</dt><dd>${moment(data.finishedAt)}</dd>
<dt>Стартовая цена</dt><dd>${money(data.startPriceTenge)}</dd>
<dt>Цена, достигнутая на торгах</dt><dd>${money(data.finalPriceTenge)}</dd>
<dt>Победитель торгов</dt><dd>${data.winnerBlindId === null ? 'ставок не поступило' : escapeHtml(data.winnerBlindId)}</dd>
<dt>Решение продавца</dt><dd>Право ВЕТО реализовано: сделка отклонена</dd>
<dt>Цифровой Карантин действует до</dt><dd>${moment(data.lockoutUntil)}</dd>
</dl>

<p class="note">
Повторное выставление объекта на площадку до окончания срока Цифрового Карантина
не производится. Участники торгов обозначены псевдонимами, уникальными в рамках
лота. Все отметки времени — серверные. Форма документа — предварительная (ОВ-6),
окончательный текст (Приложение №3) утверждается юристами.
</p>

<p class="sign">Подпись продавца: ______________________</p>
</body>
</html>`;
}

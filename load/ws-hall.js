import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';

/**
 * Нагрузочный сценарий зала торгов (T-051, QA-01, NFR-03).
 *
 * Профиль по плану: масса зрителей на одном лоте плюс редкие ставки. Смысл не
 * в том, чтобы «положить» сервер, а в двух числах приёмки — задержка
 * обработки ставки и доля клиентов, получающих тики без пропусков.
 *
 * Целевые 50 000 соединений с одной машины не поднимаются: каждое соединение
 * стоит дескриптора и памяти на генераторе, и упрётся раньше он, а не сервер.
 * Масштаб задаётся снаружи (VUS), а сколько проверено фактически — записано в
 * load/README.md. Врать в отчёте о цифре, которую не достигали, нельзя.
 */

/**
 * Сцена из seed-lot.ts: лот в торгах и токены участников с задатками.
 *
 * SharedArray — не украшение: без неё каждый виртуальный пользователь держал
 * бы свою копию файла, и на десятках тысяч клиентов память съел бы генератор,
 * а не сервер.
 */
const seed = new SharedArray('seed', () => [JSON.parse(open('./.seed.json'))]);

const WS_URL = __ENV.WS_URL || 'ws://127.0.0.1:3210';
const LOT_ID = __ENV.LOT_ID || seed[0].lotId;
const TOKENS = seed[0].tokens;
/** Доля клиентов, которые пробуют ставить. Остальные только смотрят. */
const BIDDER_RATIO = Number(__ENV.BIDDER_RATIO || '0.02');
/** Сколько секунд держится соединение. */
const HOLD_SEC = Number(__ENV.HOLD_SEC || '30');

/** Задержка ответа сервера на ставку: от отправки до bid_accepted/bid_rejected. */
const bidLatency = new Trend('bid_latency_ms', true);
/** Доля клиентов, у которых не было ни одного пропуска в тиках таймера. */
const tickContinuity = new Rate('tick_continuity');
const ticksReceived = new Counter('ticks_received');
const snapshots = new Counter('snapshots_received');

export const options = {
  scenarios: {
    hall: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '20s', target: Number(__ENV.VUS || '200') },
        { duration: __ENV.HOLD || '30s', target: Number(__ENV.VUS || '200') },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // Числа приёмки из DoD. Порог, который не проверяют, — это пожелание.
    bid_latency_ms: ['p(99)<15'],
    tick_continuity: ['rate>0.999'],
  },
};

export default function hall() {
  if (!LOT_ID) {
    throw new Error('LOT_ID обязателен: сценарию нужен лот в идущих торгах');
  }

  const isBidder = TOKENS.length > 0 && Math.random() < BIDDER_RATIO;
  let lastSeq = -1;
  let gapSeen = false;
  let bidSentAt = 0;
  let sawSnapshot = false;

  // Ставящие предъявляются кукой при рукопожатии — тем же способом, что
  // браузер: токена в сообщении нет (T-039).
  const params = isBidder
    ? { headers: { Cookie: `auction_at=${TOKENS[__VU % TOKENS.length]}` } }
    : {};

  ws.connect(WS_URL, params, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ event: 'join_lot', lot_id: LOT_ID }));
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw);

      switch (message.event) {
        case 'ping':
          // Молчащий клиент считается деградировавшим и уводит лот в SLA
          // Freeze (ТЗ §2.2) — на нагрузке это исказило бы весь прогон.
          socket.send(JSON.stringify({ event: 'pong' }));
          break;

        case 'state_snapshot':
          sawSnapshot = true;
          snapshots.add(1);
          lastSeq = message.seq;
          if (isBidder) {
            bidSentAt = Date.now();
            socket.send(
              JSON.stringify({
                event: 'place_bid',
                lot_id: LOT_ID,
                amount_kzt: message.next_price_kzt,
              }),
            );
          }
          break;

        case 'timer_tick':
          ticksReceived.add(1);
          // Пропуск номера ставки означает потерянное событие: клиент видит
          // не ту цену, на которую ставит.
          if (lastSeq >= 0 && message.seq > lastSeq + 1) {
            gapSeen = true;
          }
          lastSeq = Math.max(lastSeq, message.seq);
          break;

        case 'bid_updated':
          if (lastSeq >= 0 && message.seq > lastSeq + 1) {
            gapSeen = true;
          }
          lastSeq = Math.max(lastSeq, message.seq);
          break;

        case 'bid_accepted':
        case 'bid_rejected':
          // Меряем именно серверную обработку: отказ по цене или частоте —
          // такой же полный проход через ядро, как принятая ставка.
          if (bidSentAt > 0) {
            bidLatency.add(Date.now() - bidSentAt);
            bidSentAt = 0;
          }
          break;

        default:
          break;
      }
    });

    socket.setTimeout(() => {
      socket.close();
    }, HOLD_SEC * 1000);

    socket.on('close', () => {
      tickContinuity.add(!gapSeen);
      check(sawSnapshot, { 'снимок состояния получен': (ok) => ok });
    });
  });
}

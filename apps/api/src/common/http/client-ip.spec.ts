import { describe, expect, it } from 'vitest';

import { clientIpFrom } from './client-ip';

/**
 * Адрес клиента за Cloudflare (T-050).
 *
 * На этом адресе держатся лимит ставок (FR-10) и антинакрутка просмотров
 * (FR-15). Поверить подделанному заголовку — значит отдать оба механизма тому,
 * кто их обходит.
 */
describe('T-050: адрес клиента', () => {
  const headers = { 'cf-connecting-ip': '203.0.113.5' };

  it('без доверия заголовок не читается вовсе', () => {
    // Пока origin открыт, CF-Connecting-IP пишет кто угодно.
    expect(clientIpFrom(headers, '10.0.0.7', false)).toBe('10.0.0.7');
  });

  it('с доверием берётся адрес от Cloudflare', () => {
    expect(clientIpFrom(headers, '10.0.0.7', true)).toBe('203.0.113.5');
  });

  it('запрос мимо Cloudflare падает на адрес сокета', () => {
    expect(clientIpFrom({}, '10.0.0.7', true)).toBe('10.0.0.7');
    expect(clientIpFrom({ 'cf-connecting-ip': '   ' }, '10.0.0.7', true)).toBe('10.0.0.7');
  });

  it('повторённый заголовок берётся первым значением', () => {
    // Дубли заголовка — классический способ протащить второе значение.
    expect(clientIpFrom({ 'cf-connecting-ip': ['198.51.100.1', '203.0.113.9'] }, null, true)).toBe(
      '198.51.100.1',
    );
  });

  it('адреса нет вовсе — так и говорим', () => {
    expect(clientIpFrom({}, null, true)).toBeNull();
  });
});

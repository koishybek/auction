import { Module } from '@nestjs/common';

import { AuctionModule } from '../auction/auction.module';
import { AuthModule } from '../auth/auth.module';
import { TimeModule } from '../time/time.module';

import { LotRoomsService } from './lot-rooms.service';
import { WsGatewayService } from './ws-gateway.service';

/**
 * Realtime-контур: комнаты лотов и WebSocket-сервер.
 *
 * Поднимается в своём процессе (`main.gateway.ts`). Причина не в чистоте
 * архитектуры: gateway держит десятки тысяч соединений и обязан
 * масштабироваться отдельно от API, у которого профиль нагрузки другой. Плюс
 * падение gateway не должно уносить приём заявок и админку.
 *
 * AuthModule нужен ради TokenService: `join_lot` с токеном проверяется той же
 * подписью, что и REST. Второй способ проверять токены — второй способ его
 * подделать.
 */
@Module({
  imports: [AuthModule, AuctionModule, TimeModule],
  providers: [LotRoomsService, WsGatewayService],
  exports: [LotRoomsService, WsGatewayService],
})
export class GatewayModule {}

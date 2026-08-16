import { Module } from '@nestjs/common';

import { CaptchaProviderModule } from '../integrations/captcha/captcha.module';
import { RedisModule } from '../redis/redis.module';

import { AntibotController } from './antibot.controller';
import { AntibotService } from './antibot.service';

/**
 * Поведенческий антибот (FR-11, ОВ-5).
 *
 * Санкция живёт в Redis рядом с состоянием торгов: она короткая, оперативная и
 * ничего не значит после лота — в PostgreSQL ей делать нечего.
 */
@Module({
  imports: [RedisModule, CaptchaProviderModule],
  controllers: [AntibotController],
  providers: [AntibotService],
  exports: [AntibotService],
})
export class AntibotModule {}

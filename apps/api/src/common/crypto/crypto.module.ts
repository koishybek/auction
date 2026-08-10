import { Global, Module } from '@nestjs/common';

import { PiiCryptoService } from './pii-crypto.service';

/**
 * Глобальный: шифрование ПДн понадобится в users, partners и documents.
 * Заводить его в каждом модуле — лишний повод где-нибудь забыть и записать
 * персональные данные открытым текстом.
 */
@Global()
@Module({
  providers: [PiiCryptoService],
  exports: [PiiCryptoService],
})
export class CryptoModule {}

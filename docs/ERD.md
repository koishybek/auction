# ERD — схема БД

> Файл сгенерирован из `apps/api/prisma/schema.prisma` командой `pnpm db:erd`.
> Руками не править: правки затрутся при следующей генерации.

Моделей: 16, перечислений: 14.

Деньги везде в **целых тиынах** (`BigInt` → `BIGINT`), суффикс `_tiyn`.
ПДн — только в зашифрованных колонках `*_enc`.

## Диаграмма

```mermaid
erDiagram
  users {
    String id PK
    UserRole_list roles
    UserStatus status
    DateTime_nullable egov_verified_at
    Bytes_nullable fio_enc
    Bytes_nullable iin_enc
    Bytes_nullable phone_enc
    Bytes_nullable email_enc
    String_nullable iin_blind_idx UK
    DateTime created_at
    DateTime updated_at
  }
  lots {
    String id PK
    LotType type
    String cadastre_or_vin
    LotStatus status
    String seller_id
    String_nullable partner_lead_id
    BigInt start_price_tiyn
    BigInt_nullable current_price_tiyn
    DateTime_nullable veto_deadline_at
    DateTime_nullable lockout_until
    DateTime created_at
    DateTime updated_at
  }
  auction_sessions {
    String id PK
    String lot_id
    SessionStatus status
    DateTime started_at
    DateTime deadline_at
    DateTime_nullable finished_at
    Int_nullable freeze_snapshot_ms
    String_nullable winner_bid_id UK
    String_nullable protocol_doc_id
  }
  bids {
    String id PK
    String lot_id
    String session_id
    String user_id
    BigInt amount_tiyn
    Int seq
    String blind_code
    DateTime server_ts
  }
  blind_ids {
    String id PK
    String lot_id
    String user_id
    String code
    DateTime created_at
  }
  deposits {
    String id PK
    String user_id
    String lot_id
    BigInt amount_tiyn
    DepositStatus status
    DateTime_nullable refund_deadline_at
    String_nullable bank_ref
    DateTime created_at
    DateTime updated_at
  }
  payments {
    String id PK
    String lot_id
    String winner_user_id
    BigInt amount_tiyn
    PaymentStatus status
    String_nullable bank_ref
    DateTime created_at
    DateTime updated_at
  }
  payout_splits {
    String id PK
    String payment_id
    PayoutKind kind
    BigInt amount_tiyn
    PayoutStatus status
    String_nullable bank_ref
    DateTime created_at
    DateTime updated_at
  }
  partner_leads {
    String id PK
    String partner_id
    Bytes owner_contact_enc
    String cadastre_or_vin
    LeadStatus status
    DateTime_nullable locked_until
    String_nullable lot_id
    DateTime created_at
    DateTime updated_at
  }
  ref_bonuses {
    String id PK
    String partner_id
    String lot_id
    BigInt amount_tiyn
    RefBonusStatus status
    DateTime created_at
    DateTime updated_at
  }
  lot_documents {
    String id PK
    String lot_id
    DocumentKind kind
    String file_key
    Int downloads_count
    DateTime created_at
  }
  open_house_slots {
    String id PK
    String lot_id
    DateTime slot_at
  }
  open_house_bookings {
    String id PK
    String slot_id
    String user_id
    DateTime created_at
  }
  registry_checks {
    String id PK
    String lot_id
    DateTime checked_at
    Boolean has_restriction
    Json payload_json
  }
  notifications {
    String id PK
    String user_id
    NotificationChannel channel
    String template
    NotificationStatus status
    DateTime_nullable sent_at
    DateTime created_at
  }
  audit_log {
    String id PK
    String_nullable actor
    String action
    String entity
    String_nullable entity_id
    Json payload_json
    DateTime server_ts
  }
  lots }|--|| users : "seller"
  lots }o--|| partner_leads : "partnerLead"
  auction_sessions }|--|| lots : "lot"
  auction_sessions }o--|| bids : "winnerBid"
  bids }|--|| lots : "lot"
  bids }|--|| auction_sessions : "session"
  bids }|--|| users : "user"
  blind_ids }|--|| lots : "lot"
  blind_ids }|--|| users : "user"
  deposits }|--|| users : "user"
  deposits }|--|| lots : "lot"
  payments }|--|| lots : "lot"
  payments }|--|| users : "winner"
  payout_splits }|--|| payments : "payment"
  partner_leads }|--|| users : "partner"
  partner_leads }o--|| lots : "lot"
  ref_bonuses }|--|| users : "partner"
  ref_bonuses }|--|| lots : "lot"
  lot_documents }|--|| lots : "lot"
  open_house_slots }|--|| lots : "lot"
  open_house_bookings }|--|| open_house_slots : "slot"
  open_house_bookings }|--|| users : "user"
  registry_checks }|--|| lots : "lot"
  notifications }|--|| users : "user"
```

## Перечисления

- **UserRole**: `INVESTOR`, `SELLER`, `PARTNER`, `ADMIN`
- **UserStatus**: `ACTIVE`, `BLOCKED`
- **LotType**: `REALTY`, `VEHICLE`
- **LotStatus**: `DRAFT`, `MODERATION`, `PHASE_I`, `PHASE_II`, `PHASE_III`, `FINISHED`, `CLOSED`, `PAUSED`, `VETOED`
- **SessionStatus**: `RUNNING`, `FROZEN`, `FINISHED`
- **DepositStatus**: `PENDING`, `HELD`, `ON_SPECIAL_ACCOUNT`, `RUNNERUP_HOLD`, `REFUND_PENDING`, `REFUNDED`, `FORFEITED`
- **PaymentStatus**: `PENDING`, `PAID`, `FAILED`
- **PayoutKind**: `FEE_5PCT`, `BANK_DEBT`, `SELLER_REST`
- **PayoutStatus**: `PENDING`, `SENT`, `CONFIRMED`, `FAILED`
- **LeadStatus**: `FREE_CHECKED`, `LOCKED`, `EXPIRED`, `CONVERTED`
- **RefBonusStatus**: `FORECAST`, `ACCRUED`, `PAID`
- **DocumentKind**: `DATA_ROOM`, `CERT_STO`, `PROTOCOL`, `VETO_ACT`
- **NotificationChannel**: `PUSH`, `SMS`
- **NotificationStatus**: `PENDING`, `SENT`, `FAILED`

## Таблицы

### `users`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `roles` | UserRole[] | нет |  |
| `status` | UserStatus | нет |  |
| `egov_verified_at` | DateTime | да |  |
| `fio_enc` | Bytes | да |  |
| `iin_enc` | Bytes | да |  |
| `phone_enc` | Bytes | да |  |
| `email_enc` | Bytes | да |  |
| `iin_blind_idx` | String (UNIQUE) | да |  |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([status])`

### `lots`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `type` | LotType | нет |  |
| `cadastre_or_vin` | String | нет |  |
| `status` | LotStatus | нет |  |
| `seller_id` | String | нет |  |
| `partner_lead_id` | String | да |  |
| `start_price_tiyn` | BigInt | нет |  |
| `current_price_tiyn` | BigInt | да |  |
| `veto_deadline_at` | DateTime | да |  |
| `lockout_until` | DateTime | да | Цифровой карантин после ВЕТО: до этого момента лот заново не выставить (FR-17). |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([status])`
- `@@index([type, status])`
- `@@index([cadastreOrVin])`

### `auction_sessions`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `status` | SessionStatus | нет |  |
| `started_at` | DateTime | нет |  |
| `deadline_at` | DateTime | нет | Авторитетный дедлайн торгов. TTL ключа в Redis — только страховка (T-027). |
| `finished_at` | DateTime | да |  |
| `freeze_snapshot_ms` | Int | да | Снимок остатка таймера на момент SLA Freeze, мс (FR-08). |
| `winner_bid_id` | String (UNIQUE) | да |  |
| `protocol_doc_id` | String | да |  |

Индексы и ограничения:

- `@@index([lotId, status])`
- `@@index([status, deadlineAt])`

### `bids`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `session_id` | String | нет |  |
| `user_id` | String | нет |  |
| `amount_tiyn` | BigInt | нет |  |
| `seq` | Int | нет | Номер ставки в сессии. Присваивается атомарно в Lua-скрипте (T-024). |
| `blind_code` | String | нет | Псевдоним участника в этом лоте — в ленте не должно быть реальных ID (FR-09). |
| `server_ts` | DateTime | нет | Только серверное время. Часы клиента не участвуют ни в чём (NFR-04). |

Индексы и ограничения:

- `@@unique([sessionId, seq])`
- `@@index([lotId, seq])`
- `@@index([userId])`

### `blind_ids`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `user_id` | String | нет |  |
| `code` | String | нет | Например «704» из «Инвестор #704». Уникален в рамках лота, между лотами меняется. |
| `created_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@unique([lotId, userId])`
- `@@unique([lotId, code])`

### `deposits`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `user_id` | String | нет |  |
| `lot_id` | String | нет |  |
| `amount_tiyn` | BigInt | нет |  |
| `status` | DepositStatus | нет |  |
| `refund_deadline_at` | DateTime | да | SLA 24 ч на авто-возврат проигравшим (FR-12). |
| `bank_ref` | String | да |  |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@unique([userId, lotId])`
- `@@index([status, refundDeadlineAt])`

### `payments`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `winner_user_id` | String | нет |  |
| `amount_tiyn` | BigInt | нет |  |
| `status` | PaymentStatus | нет |  |
| `bank_ref` | String | да |  |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([status])`

### `payout_splits`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `payment_id` | String | нет |  |
| `kind` | PayoutKind | нет |  |
| `amount_tiyn` | BigInt | нет |  |
| `status` | PayoutStatus | нет |  |
| `bank_ref` | String | да |  |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@unique([paymentId, kind])`

### `partner_leads`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `partner_id` | String | нет |  |
| `owner_contact_enc` | Bytes | нет | Контакты собственника — ПДн, только в зашифрованном виде. |
| `cadastre_or_vin` | String | нет |  |
| `status` | LeadStatus | нет |  |
| `locked_until` | DateTime | да | Закрепление за партнёром на 90 дней (FR-18). |
| `lot_id` | String | да |  |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([cadastreOrVin, status])`
- `@@index([status, lockedUntil])`

### `ref_bonuses`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `partner_id` | String | нет |  |
| `lot_id` | String | нет |  |
| `amount_tiyn` | BigInt | нет |  |
| `status` | RefBonusStatus | нет |  |
| `created_at` | DateTime | нет |  |
| `updated_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@unique([partnerId, lotId])`

### `lot_documents`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `kind` | DocumentKind | нет |  |
| `file_key` | String | нет |  |
| `downloads_count` | Int | нет |  |
| `created_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([lotId, kind])`

### `open_house_slots`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `slot_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@unique([lotId, slotAt])`

### `open_house_bookings`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `slot_id` | String | нет |  |
| `user_id` | String | нет |  |
| `created_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@unique([slotId, userId])`

### `registry_checks`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `lot_id` | String | нет |  |
| `checked_at` | DateTime | нет |  |
| `has_restriction` | Boolean | нет | Ответ КИСИП/ЕРД: true → лот уходит в PAUSED (INT-02). |
| `payload_json` | Json | нет |  |

Индексы и ограничения:

- `@@index([lotId, checkedAt])`

### `notifications`

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `user_id` | String | нет |  |
| `channel` | NotificationChannel | нет |  |
| `template` | String | нет |  |
| `status` | NotificationStatus | нет |  |
| `sent_at` | DateTime | да |  |
| `created_at` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([userId, createdAt])`
- `@@index([status])`

### `audit_log`

Append-only журнал действий. UPDATE и DELETE запрещены триггером.

| Колонка | Тип | Null | Комментарий |
| --- | --- | --- | --- |
| `id` | String (PK) | нет |  |
| `actor` | String | да |  |
| `action` | String | нет |  |
| `entity` | String | нет |  |
| `entity_id` | String | да |  |
| `payload_json` | Json | нет |  |
| `server_ts` | DateTime | нет |  |

Индексы и ограничения:

- `@@index([entity, entityId])`
- `@@index([serverTs])`

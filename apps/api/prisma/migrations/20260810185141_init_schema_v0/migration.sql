-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('INVESTOR', 'SELLER', 'PARTNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "LotType" AS ENUM ('REALTY', 'VEHICLE');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('DRAFT', 'MODERATION', 'PHASE_I', 'PHASE_II', 'PHASE_III', 'FINISHED', 'CLOSED', 'PAUSED', 'VETOED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('RUNNING', 'FROZEN', 'FINISHED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'HELD', 'ON_SPECIAL_ACCOUNT', 'RUNNERUP_HOLD', 'REFUND_PENDING', 'REFUNDED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('FEE_5PCT', 'BANK_DEBT', 'SELLER_REST');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('FREE_CHECKED', 'LOCKED', 'EXPIRED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "RefBonusStatus" AS ENUM ('FORECAST', 'ACCRUED', 'PAID');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('DATA_ROOM', 'CERT_STO', 'PROTOCOL', 'VETO_ACT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "roles" "UserRole"[],
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "egov_verified_at" TIMESTAMPTZ(3),
    "fio_enc" BYTEA,
    "iin_enc" BYTEA,
    "phone_enc" BYTEA,
    "email_enc" BYTEA,
    "iin_blind_idx" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lots" (
    "id" UUID NOT NULL,
    "type" "LotType" NOT NULL,
    "cadastre_or_vin" TEXT NOT NULL,
    "status" "LotStatus" NOT NULL DEFAULT 'DRAFT',
    "seller_id" UUID NOT NULL,
    "partner_lead_id" UUID,
    "start_price_tiyn" BIGINT NOT NULL,
    "current_price_tiyn" BIGINT,
    "veto_deadline_at" TIMESTAMPTZ(3),
    "lockout_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_sessions" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "freeze_snapshot_ms" INTEGER,
    "winner_bid_id" UUID,
    "protocol_doc_id" UUID,

    CONSTRAINT "auction_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bids" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount_tiyn" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL,
    "blind_code" TEXT NOT NULL,
    "server_ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blind_ids" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blind_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "amount_tiyn" BIGINT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "refund_deadline_at" TIMESTAMPTZ(3),
    "bank_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "winner_user_id" UUID NOT NULL,
    "amount_tiyn" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "bank_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_splits" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "kind" "PayoutKind" NOT NULL,
    "amount_tiyn" BIGINT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "bank_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payout_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_leads" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "owner_contact_enc" BYTEA NOT NULL,
    "cadastre_or_vin" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'FREE_CHECKED',
    "locked_until" TIMESTAMPTZ(3),
    "lot_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ref_bonuses" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "amount_tiyn" BIGINT NOT NULL,
    "status" "RefBonusStatus" NOT NULL DEFAULT 'FORECAST',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ref_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_documents" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "file_key" TEXT NOT NULL,
    "downloads_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_house_slots" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "slot_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "open_house_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_house_bookings" (
    "id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "open_house_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_checks" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "has_restriction" BOOLEAN NOT NULL,
    "payload_json" JSONB NOT NULL,

    CONSTRAINT "registry_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "payload_json" JSONB NOT NULL,
    "server_ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_iin_blind_idx_key" ON "users"("iin_blind_idx");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "lots_status_idx" ON "lots"("status");

-- CreateIndex
CREATE INDEX "lots_type_status_idx" ON "lots"("type", "status");

-- CreateIndex
CREATE INDEX "lots_cadastre_or_vin_idx" ON "lots"("cadastre_or_vin");

-- CreateIndex
CREATE UNIQUE INDEX "auction_sessions_winner_bid_id_key" ON "auction_sessions"("winner_bid_id");

-- CreateIndex
CREATE INDEX "auction_sessions_lot_id_status_idx" ON "auction_sessions"("lot_id", "status");

-- CreateIndex
CREATE INDEX "auction_sessions_status_deadline_at_idx" ON "auction_sessions"("status", "deadline_at");

-- CreateIndex
CREATE INDEX "bids_lot_id_seq_idx" ON "bids"("lot_id", "seq");

-- CreateIndex
CREATE INDEX "bids_user_id_idx" ON "bids"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bids_session_id_seq_key" ON "bids"("session_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "blind_ids_lot_id_user_id_key" ON "blind_ids"("lot_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "blind_ids_lot_id_code_key" ON "blind_ids"("lot_id", "code");

-- CreateIndex
CREATE INDEX "deposits_status_refund_deadline_at_idx" ON "deposits"("status", "refund_deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_user_id_lot_id_key" ON "deposits"("user_id", "lot_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_splits_payment_id_kind_key" ON "payout_splits"("payment_id", "kind");

-- CreateIndex
CREATE INDEX "partner_leads_cadastre_or_vin_status_idx" ON "partner_leads"("cadastre_or_vin", "status");

-- CreateIndex
CREATE INDEX "partner_leads_status_locked_until_idx" ON "partner_leads"("status", "locked_until");

-- CreateIndex
CREATE UNIQUE INDEX "ref_bonuses_partner_id_lot_id_key" ON "ref_bonuses"("partner_id", "lot_id");

-- CreateIndex
CREATE INDEX "lot_documents_lot_id_kind_idx" ON "lot_documents"("lot_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "open_house_slots_lot_id_slot_at_key" ON "open_house_slots"("lot_id", "slot_at");

-- CreateIndex
CREATE UNIQUE INDEX "open_house_bookings_slot_id_user_id_key" ON "open_house_bookings"("slot_id", "user_id");

-- CreateIndex
CREATE INDEX "registry_checks_lot_id_checked_at_idx" ON "registry_checks"("lot_id", "checked_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_server_ts_idx" ON "audit_log"("server_ts");

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_partner_lead_id_fkey" FOREIGN KEY ("partner_lead_id") REFERENCES "partner_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_sessions" ADD CONSTRAINT "auction_sessions_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_sessions" ADD CONSTRAINT "auction_sessions_winner_bid_id_fkey" FOREIGN KEY ("winner_bid_id") REFERENCES "bids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auction_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bids" ADD CONSTRAINT "bids_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blind_ids" ADD CONSTRAINT "blind_ids_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blind_ids" ADD CONSTRAINT "blind_ids_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_winner_user_id_fkey" FOREIGN KEY ("winner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_splits" ADD CONSTRAINT "payout_splits_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_leads" ADD CONSTRAINT "partner_leads_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_leads" ADD CONSTRAINT "partner_leads_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ref_bonuses" ADD CONSTRAINT "ref_bonuses_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ref_bonuses" ADD CONSTRAINT "ref_bonuses_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_documents" ADD CONSTRAINT "lot_documents_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_house_slots" ADD CONSTRAINT "open_house_slots_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_house_bookings" ADD CONSTRAINT "open_house_bookings_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "open_house_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_house_bookings" ADD CONSTRAINT "open_house_bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_checks" ADD CONSTRAINT "registry_checks_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

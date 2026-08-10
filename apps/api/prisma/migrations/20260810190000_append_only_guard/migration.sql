-- Append-only для журналов ставок и аудита.
--
-- План (§6) и CLAUDE.md требуют, чтобы bids и audit_log были неизменяемыми:
-- это доказательная база при споре о деньгах. Правило, которое держится только
-- на дисциплине разработчика, рано или поздно нарушат — поэтому запрет стоит
-- в самой БД и действует на любой путь записи, включая ручной psql.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Таблица % — append-only: % запрещён (журнал ставок и аудита неизменяем)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bids_append_only
  BEFORE UPDATE OR DELETE ON "bids"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

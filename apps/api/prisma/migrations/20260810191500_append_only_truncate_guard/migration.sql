-- Затыкаем дыру в защите append-only.
--
-- Построчные триггеры BEFORE UPDATE/DELETE не срабатывают на TRUNCATE: он работает
-- на уровне таблицы. То есть журнал ставок и аудита можно было стереть одной
-- командой, обойдя всю защиту. Добавляем триггер уровня оператора.
--
-- Пересоздание схемы (DROP TABLE при migrate reset) триггерами не блокируется —
-- сброс dev-базы по-прежнему работает.

CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Таблица % — append-only: TRUNCATE запрещён (журнал ставок и аудита неизменяем)',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bids_no_truncate
  BEFORE TRUNCATE ON "bids"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

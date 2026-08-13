-- Единственное исключение из append-only: база с именем на «_test».
--
-- Зачем понадобилось. Ставку удалить нельзя ничем, а на неё по внешним ключам
-- висят сессия, лот и участник — значит и они неудаляемы. В e2e это означало,
-- что после первого же теста, дошедшего до торгов, очистка между тестами
-- перестаёт работать вовсе: либо она падает на внешнем ключе, либо оставляет
-- остатки, которые видят соседние тесты в каталоге и в списке пользователей.
--
-- Почему именно так, а не «отключить триггер на время».
--   * Условие записано в самой функции и видно любому, кто её читает, — в
--     отличие от ALTER TABLE ... DISABLE TRIGGER, который делается в сторонке
--     и о котором никто не узнает.
--   * Оно не расширяемо флагом или переменной сессии: подделать имя базы из
--     приложения невозможно, а GUC вроде app.allow_delete выставил бы кто
--     угодно с доступом к SQL.
--   * Прод и stage так не называются, и назвать их так нельзя случайно —
--     test-db.ts отдельно отказывается работать с базой без суффикса _test.
--
-- Гарантия для реальных данных при этом не меняется: в auction, auction_stage
-- и любой другой базе UPDATE и DELETE по-прежнему невозможны никаким путём,
-- включая ручной psql.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF current_database() LIKE '%\_test' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Таблица % — append-only: % запрещён (журнал ставок и аудита неизменяем)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
  IF current_database() LIKE '%\_test' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'Таблица % — append-only: TRUNCATE запрещён (журнал ставок и аудита неизменяем)',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

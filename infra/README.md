# Инфраструктура

## Helm-чарт (T-009)

`helm/auction` — api, web, workers, ingress и Job миграций.

```bash
helm lint helm/auction -f helm/auction/values-stage.yaml
helm template auction helm/auction -f helm/auction/values-stage.yaml --namespace auction-stage
helm upgrade --install auction helm/auction -f helm/auction/values-stage.yaml \
  --namespace auction-stage --create-namespace
```

### Секреты чарт не хранит

В git не попадает ни одного значения. Secret создаётся заранее, чарт только ссылается
на него по имени (`secrets.existingSecret`):

```bash
kubectl -n auction-stage create secret generic auction-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=DIRECT_URL='postgresql://...' \
  --from-literal=REDIS_URL='rediss://...' \
  --from-literal=PII_ENCRYPTION_KEY='...' \
  --from-literal=PII_BLIND_INDEX_KEY='...'
```

### Решения, заложенные в чарт

| Решение                                                     | Почему                                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Миграции — отдельная Job на хуке `pre-install,pre-upgrade`  | Иначе несколько реплик полезут мигрировать одновременно и будут ждать advisory-лок до таймаута готовности                                      |
| Liveness на `/api/health`, readiness на `/api/health/ready` | Liveness не должен зависеть от БД: падение PostgreSQL иначе заставит kubelet перезапускать исправные поды прямо во время торгов                |
| Sticky-сессии **выключены**                                 | Gateway stateless, состояние торгов в Redis, события через pub/sub. Привязка к поду только мешала бы балансировке 50 000 подключений (NFR-03)  |
| `proxy-read-timeout` 3600 с                                 | WebSocket торгов живёт десятками минут, дефолтные 60 секунд у NGINX рвали бы соединение посреди аукциона                                       |
| Весь REST под префиксом `/api`                              | Ingress отдаёт `/api` в API, `/` — в web. Без общего префикса пришлось бы переписывать путь регулярками, и маршруты dev и прода разъехались бы |
| `terminationGracePeriodSeconds: 60`                         | Под должен доиграть открытые запросы и закрыть WS, а не оборвать их                                                                            |
| `workers.enabled: false`                                    | Приложения `apps/workers` ещё нет — оно появится в T-020 и T-027                                                                               |

## Время: chrony (T-010)

`chrony/chrony.conf` — конфиг для **нод**, `chrony/check-drift.sh` — проверка расхождения.

```bash
./chrony/check-drift.sh node1 node2 node3   # по ssh
./chrony/check-drift.sh --local             # текущая машина
./chrony/check-drift.sh --self-test         # проверить сам скрипт, без нод
```

### chrony ставится на ноды, а не в образы

Формулировка задачи T-010 говорит «chrony в базовых образах/нодах». **В образах — нельзя,
и это не придирка.** У контейнера нет собственных часов: он читает часы ядра хоста.
chrony внутри образа без `CAP_SYS_TIME` не сможет ничего поправить, а с этой привилегией
начнёт драться с хостовым демоном за одни и те же часы, ухудшая точность.

Правильно: chrony на каждой ноде кластера, поды просто читают уже синхронизированное время.

### Почему `makestep` ограничен тремя синхронизациями

Резкий перевод часов разрешён только в первые секунды после старта ноды. Дальше время
подтягивается плавно изменением частоты. Скачок часов назад на работающей ноде посреди
торгов означал бы спорное завершение аукциона — а по нему считаются дедлайны и деньги.

Дополнительная страховка на стороне приложения: интервалы считаются по монотонному
времени (`TimeService.monotonicMs`), которое не уменьшается даже при переводе стенных часов.

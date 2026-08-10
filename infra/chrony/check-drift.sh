#!/usr/bin/env bash
# Проверка расхождения часов между нодами (NFR-04: ≤1 мс).
#
# Использование:
#   ./check-drift.sh node1 node2 node3     — опросить ноды по ssh
#   ./check-drift.sh --local               — проверить текущую машину
#   ./check-drift.sh --self-test           — проверить разбор вывода на образцах
#
# Возвращает 0, если все ноды в допуске, иначе 1.

set -uo pipefail

THRESHOLD_MS="${DRIFT_THRESHOLD_MS:-1.0}"

# Из вывода `chronyc tracking` нам нужны две строки:
#   System time     : 0.000000234 seconds fast of NTP time
#   Leap status     : Normal
# Первая даёт расхождение, вторая — что синхронизация вообще состоялась.
parse_offset_ms() {
  awk '
    /^System time/ {
      for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+$/) { print $i * 1000; found = 1; exit }
    }
    END { if (!found) print "NaN" }
  '
}

parse_leap() {
  awk -F': *' '/^Leap status/ { gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; found = 1 }
                END { if (!found) print "unknown" }'
}

check_output() {
  local label="$1" output="$2"
  local offset leap
  offset="$(printf '%s\n' "$output" | parse_offset_ms)"
  leap="$(printf '%s\n' "$output" | parse_leap)"

  if [ "$offset" = "NaN" ]; then
    printf '[ FAIL ] %-22s не удалось прочитать вывод chronyc tracking\n' "$label"
    return 1
  fi
  if [ "$leap" != "Normal" ]; then
    printf '[ FAIL ] %-22s Leap status = %s (синхронизация не установлена)\n' "$label" "$leap"
    return 1
  fi

  # bc может отсутствовать, поэтому сравниваем через awk.
  if awk -v o="$offset" -v t="$THRESHOLD_MS" 'BEGIN { exit (o < 0 ? -o : o) <= t ? 0 : 1 }'; then
    printf '[  OK  ] %-22s расхождение %.3f мс (допуск %s мс)\n' "$label" "$offset" "$THRESHOLD_MS"
    return 0
  fi
  printf '[ FAIL ] %-22s расхождение %.3f мс превышает допуск %s мс\n' "$label" "$offset" "$THRESHOLD_MS"
  return 1
}

self_test() {
  echo "Самопроверка разбора вывода chronyc (сеть и ноды не нужны)"
  echo
  local ok=0

  local good="Reference ID    : C0A80001 (ntp1.example)
Stratum         : 3
System time     : 0.000000234 seconds fast of NTP time
Last offset     : +0.000000123 seconds
RMS offset      : 0.000000456 seconds
Leap status     : Normal"

  local bad="Reference ID    : C0A80001 (ntp1.example)
System time     : 0.004500000 seconds slow of NTP time
Leap status     : Normal"

  local unsynced="Reference ID    : 00000000 ()
System time     : 0.000000100 seconds fast of NTP time
Leap status     : Not synchronised"

  local garbage="chronyc: команда не найдена"

  echo "-- ожидаем OK (0.000234 мс) --"
  check_output "образец: в допуске" "$good" || ok=1
  echo "-- ожидаем FAIL (4.5 мс) --"
  check_output "образец: вне допуска" "$bad" && ok=1
  echo "-- ожидаем FAIL (нет синхронизации) --"
  check_output "образец: не синхронизирован" "$unsynced" && ok=1
  echo "-- ожидаем FAIL (мусор на входе) --"
  check_output "образец: мусор" "$garbage" && ok=1

  echo
  if [ "$ok" -eq 0 ]; then
    echo "Самопроверка пройдена: разбор и пороги работают."
  else
    echo "Самопроверка ПРОВАЛЕНА."
  fi
  return "$ok"
}

main() {
  if [ "$#" -eq 0 ]; then
    echo "Укажите ноды, либо --local, либо --self-test" >&2
    return 2
  fi

  case "$1" in
    --self-test) self_test; return $? ;;
    --local)
      if ! command -v chronyc >/dev/null 2>&1; then
        echo "chronyc не установлен на этой машине" >&2
        return 2
      fi
      check_output "localhost" "$(chronyc tracking 2>&1)"
      return $?
      ;;
  esac

  local failed=0
  for node in "$@"; do
    output="$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$node" 'chronyc tracking' 2>&1)"
    check_output "$node" "$output" || failed=1
  done

  echo
  if [ "$failed" -eq 0 ]; then
    echo "Все ноды в допуске ${THRESHOLD_MS} мс."
  else
    echo "Есть ноды вне допуска — торги запускать нельзя (NFR-04)."
  fi
  return "$failed"
}

main "$@"

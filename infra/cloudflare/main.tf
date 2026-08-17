/**
 * Периметр Cloudflare (T-050, NFR-05).
 *
 * ВАЖНО: конфигурация НЕ ПРИМЕНЯЛАСЬ. Аккаунта и зоны у проекта пока нет,
 * поэтому она не прошла ни `terraform plan`, ни тем более `apply`. Это
 * заготовка, которую нужно проверить на реальной зоне, а не проверенный факт.
 *
 * Почему кодом, а не кликами в панели: правила периметра — часть защиты денег,
 * и «кто-то поменял в UI полгода назад» здесь такой же плохой ответ, как в
 * миграциях БД. Изменение периметра должно быть видно в диффе.
 */

terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
  }
}

variable "zone_id" {
  type        = string
  description = "Идентификатор зоны Cloudflare"
}

variable "account_id" {
  type        = string
  description = "Идентификатор аккаунта Cloudflare"
}

variable "domain" {
  type        = string
  description = "Домен площадки, например auction.kz"
}

/**
 * Базовые настройки зоны.
 *
 * `ssl = strict` обязателен: при `flexible` Cloudflare ходит к origin по HTTP,
 * и участок «периметр → сервер» остаётся открытым. Для площадки, где ходят
 * ИИН и деньги, это неприемлемо.
 */
resource "cloudflare_zone_settings_override" "auction" {
  zone_id = var.zone_id

  settings {
    ssl                      = "strict"
    min_tls_version          = "1.2"
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    tls_1_3                  = "on"

    # WebSocket — основной транспорт торгов (ТЗ §1.1). Выключенный тумблер
    # здесь означает неработающий аукцион, а не деградацию.
    websockets = "on"

    # Торги идут секундами: кэш ответов API сломал бы цену на кнопке.
    browser_cache_ttl = 0
    development_mode  = "off"

    security_level = "medium"
    brotli         = "on"
  }
}

/**
 * Ставки и деньги мимо кэша.
 *
 * Отдельным правилом, а не только заголовками приложения: заголовок можно
 * забыть на одной ручке, а правило периметра закрывает весь префикс.
 */
resource "cloudflare_ruleset" "cache_bypass_api" {
  zone_id = var.zone_id
  name    = "API мимо кэша"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules {
    expression  = "(starts_with(http.request.uri.path, \"/api/\"))"
    action      = "set_cache_settings"
    description = "REST не кэшируется: цена и остаток таймера живут секунды"

    action_parameters {
      cache = false
    }
  }
}

/**
 * WAF: то, что закрывается на периметре дешевле, чем в приложении.
 *
 * Приложение всё равно проверяет всё само — правила ниже не заменяют его
 * проверок, а снимают с него мусорный трафик.
 */
resource "cloudflare_ruleset" "waf" {
  zone_id = var.zone_id
  name    = "WAF площадки"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  # Служебные ручки-заглушки не должны быть доступны снаружи никогда.
  # В production они отвечают 404 и в коде, но дыра, закрытая дважды, —
  # это дыра, закрытая один раз с запасом.
  rules {
    expression = <<-EOT
      (http.request.uri.path contains "/dev-login")
      or (http.request.uri.path contains "/dev-approve")
      or (http.request.uri.path contains "/dev-pay")
      or (http.request.uri.path contains "/dev-webhook")
    EOT
    action      = "block"
    description = "Заглушки разработки закрыты на периметре"
  }

  # Документация API наружу не нужна: она подсказывает структуру запросов.
  rules {
    expression  = "(starts_with(http.request.uri.path, \"/api/docs\"))"
    action      = "block"
    description = "OpenAPI закрыт снаружи"
  }
}

/**
 * Ограничение частоты на входе.
 *
 * Не заменяет лимит ставок в приложении (FR-10): тот считает по сессии и
 * адресу внутри торгов и знает про 500 мс. Здесь — грубая отсечка перебора
 * входов и создания лотов, чтобы такой трафик не доходил до PostgreSQL.
 */
resource "cloudflare_ruleset" "rate_limit" {
  zone_id = var.zone_id
  name    = "Ограничение частоты"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    expression  = "(starts_with(http.request.uri.path, \"/api/auth/\"))"
    action      = "block"
    description = "Перебор входов: 30 запросов в минуту с адреса"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 30
      mitigation_timeout  = 600
    }
  }

  rules {
    expression  = "(http.request.method eq \"POST\" and starts_with(http.request.uri.path, \"/api/lots\"))"
    action      = "managed_challenge"
    description = "Массовое создание лотов: 20 запросов в минуту"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 20
      mitigation_timeout  = 300
    }
  }
}

/**
 * Turnstile для эскалации антибота (FR-11, T-049).
 *
 * Ключ виджета отдаётся в web, секрет — в API через TURNSTILE_SECRET_KEY.
 * В git не попадает ни один из них.
 */
resource "cloudflare_turnstile_widget" "auction" {
  account_id = var.account_id
  name       = "Аукцион: подтверждение участника"
  domains    = [var.domain]
  mode       = "managed"
}

output "turnstile_site_key" {
  value       = cloudflare_turnstile_widget.auction.id
  description = "Ключ виджета для web (публичный)"
}

output "turnstile_secret_key" {
  value       = cloudflare_turnstile_widget.auction.secret
  sensitive   = true
  description = "Секрет для API: кладётся в TURNSTILE_SECRET_KEY, в git не попадает"
}

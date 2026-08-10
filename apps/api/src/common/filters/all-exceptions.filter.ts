import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';

/** Порог «наша вина». Обычное число, а не член enum: status приходит как number. */
const SERVER_ERROR_FROM = 500;

interface ErrorBody {
  readonly statusCode: number;
  readonly message: string | readonly string[];
  readonly path: string;
  readonly requestId: string | undefined;
  readonly timestamp: string;
  /** Машиночитаемый код: по нему клиент решает, что делать (войти заново, показать капчу…). */
  readonly code?: string;
}

/**
 * Единая форма ответа на ошибку + гарантия, что наружу не уедет стек, SQL или
 * строка подключения. Клиент видит статус и сообщение, подробности — только в логе.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: string }>();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const code = this.codeFor(exception);
    const body: ErrorBody = {
      statusCode: status,
      message: this.messageFor(exception, status),
      path: request.url,
      requestId: request.id,
      timestamp: new Date().toISOString(),
      ...(code === undefined ? {} : { code }),
    };

    // 5xx — наша вина, нужен стек. 4xx — вина запроса, стек только шумит.
    if (status >= SERVER_ERROR_FROM) {
      this.logger.error({ err: exception, requestId: request.id }, 'Необработанная ошибка запроса');
    } else {
      this.logger.warn({ statusCode: status, requestId: request.id }, 'Запрос отклонён');
    }

    httpAdapter.reply(response, body, status);
  }

  /**
   * Достаёт машиночитаемый код из HttpException, брошенного как
   * `new ForbiddenException({ code: '...' })`.
   *
   * Без этого код терялся: Nest кладёт объект в response, а наружу по умолчанию
   * уходит только текст вроде «Forbidden Exception» — клиент не может отличить
   * «войди заново» от «ты заблокирован».
   */
  private codeFor(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const payload = exception.getResponse();
    if (typeof payload !== 'object' || payload === null) return undefined;
    const code = (payload as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  private messageFor(exception: unknown, status: number): string | readonly string[] {
    /**
     * Разворачиваем ошибку валидации в список «поле: что не так».
     * Сам по себе ZodValidationException отдаёт наружу только «Validation failed»,
     * по которому клиент не поймёт, что именно чинить. Тексты Zod описывают
     * ограничения полей и внутренностей сервера не раскрывают.
     */
    if (exception instanceof ZodValidationException) {
      // getZodError() типизирован как unknown: nestjs-zod поддерживает и Zod 3, и Zod 4.
      const zodError: unknown = exception.getZodError();
      if (zodError instanceof z.ZodError) {
        return zodError.issues.map((issue) => {
          const path = issue.path.map(String).join('.');
          return path === '' ? issue.message : `${path}: ${issue.message}`;
        });
      }
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        return payload;
      }
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
      if (Array.isArray(message) && message.every((item) => typeof item === 'string')) {
        return message;
      }
      return exception.message;
    }

    // Ничего из внутренностей неизвестной ошибки наружу не отдаём.
    return status >= SERVER_ERROR_FROM ? 'Внутренняя ошибка сервера' : 'Ошибка запроса';
  }
}

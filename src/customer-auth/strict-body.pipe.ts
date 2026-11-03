import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { Type } from '@nestjs/common';

/**
 * Body pipe that REJECTS (400) unknown properties, unlike the app-wide pipe
 * which silently strips them. The handler parameter must be typed
 * `Readonly<Dto>` so Nest's global pipe sees plain `Object` metadata and
 * leaves the body untouched; `expectedType` then validates against the DTO.
 */
export function strictBody(dto: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    expectedType: dto,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

/**
 * Story 19.4a: the body must be a JSON object. An array / string / number is
 * 400 (it would otherwise validate as "no fields" and answer 200 with no
 * effect); an empty body is read as `{}`. Place it BEFORE `strictBody(...)`.
 */
export const requireObjectBody: PipeTransform<unknown, object> = {
  transform(value: unknown): object {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('The request body must be a JSON object.');
    }
    return value;
  },
};

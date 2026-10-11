import { ValidationPipe } from '@nestjs/common';
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

import { ApiProperty } from '@nestjs/swagger';
import {
  IsISO8601,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Story 9.4 AC3: cross-field check that `to` is not before `from`. A plain
 * per-field `@IsISO8601()` on each of `from`/`to` independently cannot
 * express "these two together must be ordered" — `class-validator`'s
 * `@Validate(...)` + a `ValidatorConstraint` is the documented way to reach
 * a sibling field (`args.object`) from inside a single property's
 * decorator, so this stays a `class-validator` rejection (stable 400 via
 * the shared `ValidationPipe`, NFR-4) rather than a hand-rolled check
 * inside the controller/service.
 */
@ValidatorConstraint({ name: 'isOnOrAfterFrom', async: false })
class IsOnOrAfterFromConstraint implements ValidatorConstraintInterface {
  validate(to: unknown, args: ValidationArguments): boolean {
    const { from } = args.object as ReconciliationQueryDto;
    if (typeof from !== 'string' || typeof to !== 'string') {
      // Malformed types are already rejected by @IsISO8601 on each field;
      // this constraint only judges ordering, never re-litigates format.
      return true;
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return true; // let @IsISO8601 report the real format error
    }
    return fromDate.getTime() <= toDate.getTime();
  }

  defaultMessage(): string {
    return '"to" must not be before "from"';
  }
}

/**
 * Story 9.4 (FR-28, NFR-4): query params for
 * `GET /api/v1/admin/orders/reconciliation`. Both `from`/`to` accept a
 * bare ISO-8601 date (`2026-09-01`) or a full timestamp
 * (`2026-09-01T00:00:00Z`) — `AdminOrdersService.getReconciliation` treats
 * a bare `to` date as inclusive of that entire day (see its own doc
 * comment), so a caller filtering "the month of September" doesn't have to
 * reason about UTC midnight boundaries.
 */
export class ReconciliationQueryDto {
  @ApiProperty({
    example: '2026-09-01',
    description: 'Start of the period (inclusive), ISO-8601 date or date-time.',
  })
  @IsISO8601()
  from: string;

  @ApiProperty({
    example: '2026-09-30',
    description:
      'End of the period (inclusive), ISO-8601 date or date-time. A bare date (no time component) is treated as the end of that day.',
  })
  @IsISO8601()
  @Validate(IsOnOrAfterFromConstraint)
  to: string;
}

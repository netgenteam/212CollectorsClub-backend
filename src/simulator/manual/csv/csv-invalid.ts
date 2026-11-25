import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../../common/api-exception.js';
import { CSV_MAX_REPORTED_ERRORS, type CsvRowError } from './parse-csv.js';

/** 422 `SIMULATOR_CSV_INVALID` with `details {errors (<=100), totalErrors, truncated}` (AC6). */
export function csvInvalid(errors: CsvRowError[]): ApiException {
  return new ApiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SIMULATOR_CSV_INVALID',
    'The CSV has errors; nothing was imported.',
    {
      errors: errors.slice(0, CSV_MAX_REPORTED_ERRORS),
      totalErrors: errors.length,
      truncated: errors.length > CSV_MAX_REPORTED_ERRORS,
    },
  );
}

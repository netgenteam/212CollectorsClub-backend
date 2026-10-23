import { HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ApiException } from '../common/api-exception.js';
import {
  TITLE_LINES_MAX_SEGMENTS,
  SegmentDto,
} from './dto/blocks/common.dto.js';
import {
  LANDING_BLOCK_DTOS,
  LANDING_BLOCK_MAX_BYTES,
  type LandingBlock,
} from './landing-blocks.constants.js';

export interface LandingBlockValidationError {
  path: string;
  messages: string[];
}

const VALIDATOR_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
} as const;

/** Flattens class-validator's error tree into `{ path: 'a.0.b', messages[] }`. */
function flatten(
  errors: ValidationError[],
  prefix: string,
  out: LandingBlockValidationError[],
): void {
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) {
      out.push({ path, messages: Object.values(e.constraints) });
    }
    if (e.children?.length) {
      flatten(e.children, path, out);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * class-validator cannot descend into `Segment[][]`, so every `titleLines`
 * found in the payload (hero panels, vitrina, simulator) is checked here:
 * each line is an array of 1..4 segments and each segment is a valid
 * `SegmentDto`. The outer array (1..4 lines) was already checked by the DTO
 * decorators; non-array values are skipped (already reported there).
 */
async function collectTitleLineErrors(
  node: unknown,
  path: string,
  out: LandingBlockValidationError[],
): Promise<void> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      await collectTitleLineErrors(node[i], join(path, String(i)), out);
    }
    return;
  }
  if (!isPlainObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    const childPath = join(path, key);
    if (key === 'titleLines' && Array.isArray(value)) {
      for (let l = 0; l < value.length; l++) {
        const linePath = join(childPath, String(l));
        const line: unknown = value[l];
        if (!Array.isArray(line)) {
          out.push({
            path: linePath,
            messages: ['line must be an array of segments'],
          });
          continue;
        }
        if (line.length < 1 || line.length > TITLE_LINES_MAX_SEGMENTS) {
          out.push({
            path: linePath,
            messages: [
              `a line must contain between 1 and ${TITLE_LINES_MAX_SEGMENTS} segments`,
            ],
          });
        }
        for (let s = 0; s < line.length; s++) {
          const segPath = join(linePath, String(s));
          const seg: unknown = line[s];
          if (!isPlainObject(seg)) {
            out.push({
              path: segPath,
              messages: ['segment must be an object'],
            });
            continue;
          }
          const segErrors = await validate(
            plainToInstance(SegmentDto, seg),
            VALIDATOR_OPTIONS,
          );
          flatten(segErrors, segPath, out);
        }
      }
    } else {
      await collectTitleLineErrors(value, childPath, out);
    }
  }
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function invalid(errors: LandingBlockValidationError[]): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'LANDING_BLOCK_INVALID',
    'The block value does not match its schema.',
    { errors },
  );
}

/**
 * Story 16.1 (AD-60): validates a `PUT blocks/:block` body against the
 * block's DTO (whitelist + forbidNonWhitelisted, 20 KB cap). Resolves with
 * the plain value to persist; throws 400 `LANDING_BLOCK_INVALID` with
 * `details.errors` otherwise.
 */
export async function validateLandingBlock(
  block: LandingBlock,
  body: unknown,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(body)) {
    throw invalid([{ path: '', messages: ['body must be a JSON object'] }]);
  }
  const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (size > LANDING_BLOCK_MAX_BYTES) {
    throw invalid([
      {
        path: '',
        messages: [
          `payload is ${size} bytes; the maximum is ${LANDING_BLOCK_MAX_BYTES} bytes`,
        ],
      },
    ]);
  }

  const instance = plainToInstance(LANDING_BLOCK_DTOS[block], body);
  const errors: LandingBlockValidationError[] = [];
  flatten(await validate(instance, VALIDATOR_OPTIONS), '', errors);
  await collectTitleLineErrors(body, '', errors);
  if (errors.length > 0) {
    throw invalid(errors);
  }
  return body;
}

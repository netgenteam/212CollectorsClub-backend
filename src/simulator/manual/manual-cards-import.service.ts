import { HttpStatus, Injectable } from '@nestjs/common';
import { numberKeyOf } from './card-number.js';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { csvInvalid } from './csv/csv-invalid.js';
import {
  csvMaxBytes,
  parseCsv,
  withExistingDuplicates,
} from './csv/parse-csv.js';
import { ManualCardsService, maxCardsPerSet } from './manual-cards.service.js';

type Admin = { id: string } | undefined;

export interface CardsImportResult {
  dryRun: boolean;
  rows: number;
  imported: number;
}

/**
 * Story 22.7 (AD-107, A101, A113): all-or-nothing CSV import of manual cards. The whole file is
 * validated in memory first (no network, imageUrl is never fetched); a single `createMany` runs in
 * the set-locked transaction of {@link ManualCardsService.importRows}.
 */
@Injectable()
export class ManualCardsImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: ManualCardsService,
  ) {}

  async import(
    setId: string,
    file: Pick<Express.Multer.File, 'buffer'> | undefined,
    dryRun: boolean,
    admin: Admin,
  ): Promise<CardsImportResult> {
    const set = await this.prisma.simulatorSet.findUnique({
      where: { id: setId },
      select: { id: true },
    });
    if (!set)
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'SIMULATOR_SET_NOT_FOUND',
        'Simulator set not found.',
      );
    if (!file?.buffer)
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'SIMULATOR_CSV_REQUIRED',
        'A "file" field with the CSV is required.',
      );
    const buf = file.buffer;
    const max = csvMaxBytes();
    if (buf.length > max)
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'SIMULATOR_CSV_TOO_LARGE',
        `The CSV exceeds the maximum of ${max} bytes.`,
        { maxBytes: max },
      );
    if (buf.includes(0))
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_FILE_TYPE',
        'The file is binary; a UTF-8 CSV is required.',
      );

    let parsed = parseCsv(buf);
    if (parsed.numbers.length > 0) {
      // informational read (unlocked) so ONE pass reports clashes with the set too;
      // the authoritative check repeats under the set lock when importing
      const existing = await this.prisma.simulatorCard.findMany({
        where: {
          setId,
          numberKey: { in: parsed.numbers.map((n) => numberKeyOf(n.number)) },
        },
        select: { numberKey: true },
      });
      parsed = withExistingDuplicates(
        parsed,
        new Set(existing.flatMap((c) => (c.numberKey ? [c.numberKey] : []))),
      );
    }
    if (parsed.errors.length > 0) throw csvInvalid(parsed.errors);

    if (dryRun) {
      const current = await this.prisma.simulatorCard.count({
        where: { setId },
      });
      const cap = maxCardsPerSet();
      if (current + parsed.rows.length > cap)
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'SIMULATOR_SET_CARD_LIMIT',
          `A set holds at most ${cap} cards.`,
          { max: cap, current, incoming: parsed.rows.length },
        );
      return { dryRun: true, rows: parsed.rows.length, imported: 0 };
    }
    const imported = await this.cards.importRows(setId, parsed.rows, admin);
    return { dryRun: false, rows: parsed.rows.length, imported };
  }
}

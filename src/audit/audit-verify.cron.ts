import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApiException } from '../common/api-exception.js';
import { MailerService } from '../common/mailer/mailer.service.js';
import { AuditReadService } from './audit-read.service.js';
import { AuditVerifyService } from './audit-verify.service.js';
import type { VerifyResponse } from './audit-verify.service.js';

export interface ScheduledVerifyResult {
  status: 'OK' | 'BROKEN' | 'BUSY' | 'FAILED';
  slices: number;
  rows: number;
  brokenSeq?: number;
  anchorEmailSent: boolean;
}

/** Never run more slices than this in one cron run (200.000 rows each). */
const MAX_SLICES = 50;

/**
 * Story 20.1 (AC10, A100): weekly verification of the chain
 * (`AUDIT_VERIFY_CRON`, default `0 5 * * 0` UTC). It shares the verification
 * advisory lock with `POST /admin/audit/verify`. A BROKEN result is logged as an
 * error and stays visible through `GET /admin/audit/verifications`
 * (`chainBroken`). When `AUDIT_ANCHOR_EMAIL` is set the chain head (seq + hash)
 * is mailed out as an external anchor; a mail failure never breaks the job.
 * NOTE: like the FX cron, the expression is read from the process environment
 * when the class is decorated (export it to the process, not only the .env file).
 */
@Injectable()
export class AuditVerifyCron {
  private readonly logger = new Logger(AuditVerifyCron.name);

  constructor(
    private readonly verifier: AuditVerifyService,
    private readonly reader: AuditReadService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  /** `AUDIT_VERIFY_ENABLED=false` disables it; default on (off under NODE_ENV=test). */
  isEnabled(): boolean {
    const v = String(this.config.get('AUDIT_VERIFY_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return process.env.NODE_ENV !== 'test';
  }

  /**
   * `full` (default) re-hashes the whole chain every run: an incremental run
   * trusts the rows before its anchor, so a content-only edit of an OLD row would
   * go unnoticed for good. Set `AUDIT_VERIFY_CRON_MODE=incremental` only when the
   * chain is so big (millions of rows) that a weekly full pass is too slow.
   */
  mode(): 'full' | 'incremental' {
    return String(this.config.get('AUDIT_VERIFY_CRON_MODE') ?? '')
      .trim()
      .toLowerCase() === 'incremental'
      ? 'incremental'
      : 'full';
  }

  @Cron(process.env.AUDIT_VERIFY_CRON || '0 5 * * 0', {
    name: 'audit-verify',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await this.runScheduled();
    } catch (err) {
      this.logger.error(`audit verification job failed: ${String(err)}`);
    }
  }

  async runScheduled(): Promise<ScheduledVerifyResult> {
    let slices = 0;
    let rows = 0;
    let fromSeq: number | undefined;
    let last: VerifyResponse | undefined;
    try {
      do {
        last = await this.verifier.run({
          mode: this.mode(),
          fromSeq,
          source: 'CRON',
          actor: { actorType: 'SYSTEM', actorId: null },
        });
        slices += 1;
        rows += last.rows;
        fromSeq = last.nextFromSeq;
      } while (last.ok && !last.done && slices < MAX_SLICES);
    } catch (err) {
      if (
        err instanceof ApiException &&
        (err.getResponse() as { errorCode?: string }).errorCode ===
          'AUDIT_VERIFY_IN_PROGRESS'
      ) {
        this.logger.warn('audit verification skipped: another one is running');
        return { status: 'BUSY', slices, rows, anchorEmailSent: false };
      }
      this.logger.error(`audit verification failed to run: ${String(err)}`);
      return { status: 'FAILED', slices, rows, anchorEmailSent: false };
    }
    if (!last.ok) {
      this.logger.error(
        `AUDIT CHAIN BROKEN at seq ${last.brokenAt?.seq} (${last.brokenAt?.reason}); see GET /admin/audit/verifications`,
      );
    }
    const anchorEmailSent = await this.sendAnchor(last.ok);
    return {
      status: last.ok ? 'OK' : 'BROKEN',
      slices,
      rows,
      ...(last.brokenAt ? { brokenSeq: last.brokenAt.seq } : {}),
      anchorEmailSent,
    };
  }

  private async sendAnchor(ok: boolean): Promise<boolean> {
    const to = String(this.config.get('AUDIT_ANCHOR_EMAIL') ?? '').trim();
    if (!to) return false;
    try {
      const head = await this.reader.head();
      await this.mailer.sendMail({
        to,
        subject: `[212 Collectors Club] Audit chain anchor: seq ${head.seq}${ok ? '' : ' (VERIFICATION FAILED)'}`,
        text:
          `Audit chain head\nseq: ${head.seq}\nhash: ${head.hash}\nrows: ${head.count}\n` +
          `at: ${head.at ?? '-'}\nlast verification: ${ok ? 'OK' : 'BROKEN'}\n\n` +
          `Keep this message outside the database: it is the external anchor of the chain.`,
      });
      return true;
    } catch (err) {
      this.logger.error(`audit anchor email failed: ${String(err)}`);
      return false;
    }
  }
}

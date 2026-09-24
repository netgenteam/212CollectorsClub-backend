import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ContactService } from './contact.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailerService } from '../common/mailer/mailer.service.js';
import type { SubmitContactInquiryDto } from './dto/submit-contact-inquiry.dto.js';

describe('ContactService', () => {
  let service: ContactService;
  let prisma: {
    contactInquiry: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    product: { findUnique: ReturnType<typeof vi.fn> };
  };
  let mailer: { sendMail: ReturnType<typeof vi.fn> };
  let configService: { getOrThrow: ReturnType<typeof vi.fn> };

  function buildDto(
    overrides: Partial<SubmitContactInquiryDto> = {},
  ): SubmitContactInquiryDto {
    return {
      name: 'Maria Perez',
      email: 'maria@example.com',
      message: 'Is this card still in stock?',
      ...overrides,
    };
  }

  beforeEach(async () => {
    prisma = {
      contactInquiry: { create: vi.fn(), update: vi.fn() },
      product: { findUnique: vi.fn() },
    };
    mailer = { sendMail: vi.fn() };
    configService = {
      getOrThrow: vi.fn().mockReturnValue('admin@212collectorsclub.test'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailerService, useValue: mailer },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<ContactService>(ContactService);
  });

  it('persists the ContactInquiry BEFORE attempting the email — create is called, then sendMail, then update(SENT)', async () => {
    prisma.contactInquiry.create.mockResolvedValue({
      id: 'inquiry-1',
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    });
    mailer.sendMail.mockResolvedValue(undefined);
    prisma.contactInquiry.update.mockResolvedValue({});

    const result = await service.submitInquiry(buildDto());

    // vitest records each mock's global invocation order — asserting on it
    // directly (rather than a hand-rolled side-effect array) proves the
    // real call sequence without any risk of the assertion itself
    // masking a race.
    const createOrder =
      prisma.contactInquiry.create.mock.invocationCallOrder[0];
    const sendOrder = mailer.sendMail.mock.invocationCallOrder[0];
    const updateOrder =
      prisma.contactInquiry.update.mock.invocationCallOrder[0];
    if (!(createOrder < sendOrder && sendOrder < updateOrder)) {
      throw new Error(
        `Expected create < sendMail < update, got orders: ${JSON.stringify({
          createOrder,
          sendOrder,
          updateOrder,
        })}`,
      );
    }
    expect(result).toEqual({
      id: 'inquiry-1',
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    });
    expect(prisma.contactInquiry.create).toHaveBeenCalledWith({
      data: {
        name: 'Maria Perez',
        email: 'maria@example.com',
        message: 'Is this card still in stock?',
        productId: null,
      },
    });
    expect(mailer.sendMail).toHaveBeenCalledWith({
      to: 'admin@212collectorsclub.test',
      subject: 'New contact inquiry from Maria Perez',
      text: expect.stringContaining('Is this card still in stock?') as string,
    });
    expect(prisma.contactInquiry.update).toHaveBeenCalledWith({
      where: { id: 'inquiry-1' },
      data: { emailStatus: 'SENT' },
    });
  });

  it('resolves productId to null (never rejects/throws) when the given productId does not match any Product', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    prisma.contactInquiry.create.mockResolvedValue({
      id: 'inquiry-2',
      createdAt: new Date(),
    });
    mailer.sendMail.mockResolvedValue(undefined);

    await service.submitInquiry(
      buildDto({ productId: '11111111-1111-1111-1111-111111111111' }),
    );

    expect(prisma.contactInquiry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: null }) as unknown,
    });
  });

  it('carries a resolved productId through to the persisted row when the Product exists', async () => {
    prisma.product.findUnique.mockResolvedValue({
      id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
    });
    prisma.contactInquiry.create.mockResolvedValue({
      id: 'inquiry-3',
      createdAt: new Date(),
    });
    mailer.sendMail.mockResolvedValue(undefined);

    await service.submitInquiry(
      buildDto({ productId: 'f65915f5-2931-4e50-af95-630b1fd7b950' }),
    );

    expect(prisma.contactInquiry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'f65915f5-2931-4e50-af95-630b1fd7b950',
      }) as unknown,
    });
  });

  it('still persists (and resolves 201-worthy success) even when the email transport throws — failure is caught, never rethrown, and the row is marked FAILED', async () => {
    prisma.contactInquiry.create.mockResolvedValue({
      id: 'inquiry-4',
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    });
    mailer.sendMail.mockRejectedValue(new Error('SMTP connection refused'));
    prisma.contactInquiry.update.mockResolvedValue({});

    await expect(service.submitInquiry(buildDto())).resolves.toEqual({
      id: 'inquiry-4',
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    });

    expect(prisma.contactInquiry.create).toHaveBeenCalledTimes(1);
    expect(prisma.contactInquiry.update).toHaveBeenCalledWith({
      where: { id: 'inquiry-4' },
      data: {
        emailStatus: 'FAILED',
        emailErrorMessage: 'SMTP connection refused',
      },
    });
  });

  it('never throws even when recording the FAILED outcome itself also fails (both the send and the follow-up update error)', async () => {
    prisma.contactInquiry.create.mockResolvedValue({
      id: 'inquiry-5',
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    });
    mailer.sendMail.mockRejectedValue(new Error('SMTP down'));
    prisma.contactInquiry.update.mockRejectedValue(new Error('DB unavailable'));

    await expect(service.submitInquiry(buildDto())).resolves.toEqual({
      id: 'inquiry-5',
      createdAt: new Date('2026-09-24T00:00:00.000Z'),
    });
  });
});

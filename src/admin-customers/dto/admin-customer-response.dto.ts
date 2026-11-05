import { ApiProperty } from '@nestjs/swagger';
import { CustomerAddressResponseDto } from '../../customer-addresses/dto/customer-address-response.dto.js';

export class AdminCustomerListItemDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({
    description:
      'The placeholder deleted+<uuid>@anonymized.invalid once anonymized.',
  })
  email: string;
  @ApiProperty() name: string;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  anonymizedAt: string | null;
  @ApiProperty({ description: 'All the Orders of the account (kept forever).' })
  ordersCount: number;
  @ApiProperty({
    description:
      'Orders in PAYMENT_PROCESSING, PENDING_VERIFICATION or PAID: they block the anonymization.',
  })
  activeOrdersCount: number;
}

export class AdminCustomerListMetaDto {
  @ApiProperty() limit: number;
  @ApiProperty() hasNextPage: boolean;
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class AdminCustomerListResponseDto {
  @ApiProperty({ type: [AdminCustomerListItemDto] })
  data: AdminCustomerListItemDto[];
  @ApiProperty({ type: AdminCustomerListMetaDto })
  meta: AdminCustomerListMetaDto;
}

export class AdminCustomerOrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'paid' }) status: string;
  @ApiProperty() paymentRail: string;
  @ApiProperty() totalUsd: number;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AnonymizationActiveOrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'pending_verification' }) status: string;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AnonymizationWillDeleteDto {
  @ApiProperty() addresses: number;
  @ApiProperty() sessions: number;
  @ApiProperty() credentials: number;
  @ApiProperty({ description: 'Pending verification / password-reset tokens.' })
  verificationTokens: number;
  @ApiProperty() carts: number;
  @ApiProperty() wishlists: number;
  @ApiProperty({
    description:
      'Rows of the usage log (IP, user agent, routes; kept 7 days) of this account. Deleted too, including the ones still in the memory of the server.',
  })
  usageLogs: number;
}

export class AnonymizationWillKeepDto {
  @ApiProperty({
    description:
      'ALL the orders (fiscal obligation), with the encrypted cedula, payments and proofs of payment.',
  })
  orders: number;
  @ApiProperty({ description: 'Consent evidence (append-only).' })
  consentRecords: number;
  @ApiProperty({
    description:
      'Contact-form messages written with the same email. NOT deleted by the anonymization (a formal claim may be among them): the 12-month retention of Story 20.8 covers them.',
  })
  contactInquiries: number;
  @ApiProperty({
    description:
      'Orders of this account (any status, kept) with a pending refund (Stripe `refund_pending_*`): the money is still owed after the anonymization.',
  })
  ordersWithRefundPending: number;
}

export class AnonymizationPreviewDto {
  @ApiProperty({
    description:
      'false when the account is already anonymized or has active orders (the POST would answer 200 alreadyAnonymized / 409).',
  })
  canAnonymize: boolean;
  @ApiProperty({
    description:
      'Orders blocking the anonymization: `count` is the real number, `items` the oldest 20.',
  })
  activeOrders: { count: number; items: AnonymizationActiveOrderDto[] };
  @ApiProperty({ type: AnonymizationWillDeleteDto })
  willDelete: AnonymizationWillDeleteDto;
  @ApiProperty({ type: AnonymizationWillKeepDto })
  willKeep: AnonymizationWillKeepDto;
  @ApiProperty({
    type: [String],
    description:
      'Codes of the permanent warnings the modal shows BEFORE any field: NOT_RECOMMENDED_ONLY_ON_EXPLICIT_REQUEST_OF_THE_OWNER, IRREVERSIBLE, ORDERS_AND_FISCAL_ID_KEPT, REFUND_PENDING_ON_KEPT_ORDERS (only when an order of the account has a pending refund), CONTACT_MESSAGES_KEPT_UNTIL_RETENTION (only when contact messages exist for the email), BROWSER_LOCAL_STORAGE_NOT_ERASED, BACKUPS_KEEP_DATA_UNTIL_ROTATION.',
  })
  notices: string[];
}

export class AdminCustomerDetailDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  anonymizedAt: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  anonymizedById: string | null;
  @ApiProperty({
    type: [CustomerAddressResponseDto],
    description: 'Cedula ALWAYS masked (V-****5678).',
  })
  addresses: CustomerAddressResponseDto[];
  @ApiProperty({
    type: [AdminCustomerOrderDto],
    description: 'The 10 most recent.',
  })
  recentOrders: AdminCustomerOrderDto[];
  @ApiProperty({ type: AnonymizationPreviewDto })
  anonymization: AnonymizationPreviewDto;
}

import { ApiProperty } from '@nestjs/swagger';
import { DELIVERY_MODES } from './create-customer-address.dto.js';

export class CustomerAddressAgencyDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() code: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty() allowsOfficePickup: boolean;
  @ApiProperty() allowsHomeDelivery: boolean;
}

export class CustomerAddressResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: String, nullable: true }) label: string | null;
  @ApiProperty() recipientName: string;
  @ApiProperty() recipientPhone: string;
  @ApiProperty({ example: 'V-12345678' }) recipientIdDoc: string;
  @ApiProperty({ enum: DELIVERY_MODES }) deliveryMode: string;
  @ApiProperty({ type: CustomerAddressAgencyDto })
  agency: CustomerAddressAgencyDto;
  @ApiProperty({ type: String, nullable: true }) agencyBranchName:
    string | null;
  @ApiProperty({ type: String, nullable: true }) agencyBranchCode:
    string | null;
  @ApiProperty() state: string;
  @ApiProperty() municipality: string;
  @ApiProperty({ type: String, nullable: true }) parish: string | null;
  @ApiProperty({ type: String, nullable: true }) addressLine1: string | null;
  @ApiProperty({ type: String, nullable: true }) addressLine2: string | null;
  @ApiProperty({ type: String, nullable: true }) referencePoint: string | null;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ format: 'date-time' }) updatedAt: string;
}

export class CustomerAddressListResponseDto {
  @ApiProperty({ type: [CustomerAddressResponseDto] })
  data: CustomerAddressResponseDto[];
}

import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ShippingAgenciesService } from './shipping-agencies.service.js';
import { ShippingAgencyPublicListResponseDto } from './dto/shipping-agency.dto.js';

/** Story 17.1 (AD-71, FR-82): public active-agency catalog. */
@ApiTags('shipping')
@Controller('shipping')
export class ShippingController {
  constructor(private readonly agencies: ShippingAgenciesService) {}

  @Get('agencies')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Active shipping agencies',
    description:
      'Only isActive agencies, ordered by sortOrder then name. Never exposes trackingUrlTemplate.',
  })
  @ApiResponse({
    status: 200,
    type: ShippingAgencyPublicListResponseDto,
  })
  async list(): Promise<ShippingAgencyPublicListResponseDto> {
    return { data: await this.agencies.listPublic() };
  }
}

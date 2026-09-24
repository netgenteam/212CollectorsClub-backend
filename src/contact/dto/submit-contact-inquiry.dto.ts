import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Story 6.1 (FR-18): body of `POST /api/v1/contact`. Every field below is
 * checked by the global `ValidationPipe` (NFR-3) before this ever reaches
 * ContactController/ContactService — a missing name/email/message, or a
 * malformed email, is rejected with a stable field-level 400 body, never a
 * generic failure (this story's own AC). `productId`, when present, must
 * be a syntactically valid UUID; whether it resolves to a real, still-
 * existing Product is a business decision made in ContactService, not a
 * validation concern here (see that class's doc comment).
 */
export class SubmitContactInquiryDto {
  @ApiProperty({
    example: 'Maria Perez',
    description: 'Full name of the person submitting the inquiry.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({
    example: 'maria@example.com',
    description: "The submitter's email address — where the store can reply.",
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'Is the Charizard VMAX still in stock in near-mint condition?',
    description: 'The inquiry message body.',
    maxLength: 5000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  message: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: 'f65915f5-2931-4e50-af95-630b1fd7b950',
    description:
      'The Product the submitter was viewing when they sent this inquiry, if any.',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}

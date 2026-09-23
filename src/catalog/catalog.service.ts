import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 2.1 (FR-5): returns every Category. The AC says "active"
   * Categories, but the `Category` model (Story 1.4) has no `isActive` /
   * soft-delete field yet, and this story's Technical Notes explicitly rule
   * out schema changes — so today every row is implicitly "active" and this
   * is a straight `findMany`. Add an `isActive` filter here once that field
   * exists on the model (likely Story 8.1, admin CRUD Categories).
   */
  async listCategories(): Promise<CategoryResponseDto[]> {
    return this.prisma.category.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
  }
}

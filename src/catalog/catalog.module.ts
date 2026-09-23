import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

// PrismaService is provided by the global PrismaModule (see
// src/prisma/prisma.module.ts) — no need to re-import it here.
@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}

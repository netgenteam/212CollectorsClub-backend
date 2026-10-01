import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { WishlistController } from './wishlist.controller.js';
import { WishlistCookieService } from './wishlist-cookie.service.js';
import { WishlistService } from './wishlist.service.js';

// PrismaService comes from the global PrismaModule. AD-22: own cookie
// service; CartCookieService is neither imported nor modified.
@Module({
  imports: [CatalogModule],
  controllers: [WishlistController],
  providers: [WishlistService, WishlistCookieService],
})
export class WishlistModule {}

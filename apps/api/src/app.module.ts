import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController, LoginThrottlerGuard } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MeController } from './auth/me.controller';
import { CategoriesController } from './catalog/categories.controller';
import { IngredientsController } from './catalog/ingredients.controller';
import { LocationCatalogController } from './catalog/location-catalog.controller';
import { ProductsController } from './catalog/products.controller';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { HealthController } from './health/health.controller';
import { LocationsController } from './locations/locations.controller';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';
import { OrdersController } from './orders/orders.controller';
import { CashRegistersController } from './pos/cash-registers.controller';
import { FloorsController } from './pos/floors.controller';
import { TablesController } from './pos/tables.controller';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET }),
    // 10 login attempts per minute per email (see LoginThrottlerGuard).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [
    HealthController,
    AuthController,
    MeController,
    LocationsController,
    CategoriesController,
    ProductsController,
    IngredientsController,
    LocationCatalogController,
    CashRegistersController,
    FloorsController,
    TablesController,
    OrdersController,
  ],
  providers: [
    PrismaService,
    AuthService,
    LoginThrottlerGuard,
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Public routes resolve the tenant differently (storefront slug, webhook signature).
    consumer
      .apply(TenantMiddleware)
      .exclude('health', 'auth/{*path}', 'public/{*path}', 'webhooks/{*path}')
      .forRoutes('{*path}');
  }
}

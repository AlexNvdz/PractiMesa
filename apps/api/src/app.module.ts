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
import { LiveEventsService } from './live/live-events.service';
import { LiveController } from './live/live.controller';
import { LocationsController } from './locations/locations.controller';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';
import { FactusService } from './invoicing/factus.service';
import { InvoicingController } from './invoicing/invoicing.controller';
import { InvoicingService } from './invoicing/invoicing.service';
import { KitchenController } from './orders/kitchen.controller';
import { OrdersController } from './orders/orders.controller';
import { FactusPayWebhookController } from './payments/factus-pay-webhook.controller';
import { FactusPayService } from './payments/factus-pay.service';
import { IntegrationsController } from './payments/integrations.controller';
import { CashRegistersController } from './pos/cash-registers.controller';
import { FloorsController } from './pos/floors.controller';
import { TablesController } from './pos/tables.controller';
import { PlatformController } from './platform/platform.controller';
import { PlatformGuard } from './platform/platform.guard';
import { PrismaService } from './prisma/prisma.service';
import { UsersController } from './users/users.controller';

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
    KitchenController,
    IntegrationsController,
    FactusPayWebhookController,
    InvoicingController,
    LiveController,
    PlatformController,
    UsersController,
  ],
  providers: [
    PrismaService,
    AuthService,
    FactusPayService,
    FactusService,
    InvoicingService,
    LiveEventsService,
    LoginThrottlerGuard,
    PlatformGuard,
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
  exports: [PrismaService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Public routes resolve the tenant differently (storefront handle, webhook key); platform routes have no tenant.
    consumer
      .apply(TenantMiddleware)
      .exclude('health', 'auth/{*path}', 'public/{*path}', 'webhooks/{*path}', 'platform/{*path}')
      .forRoutes('{*path}');
  }
}

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN ?? '12h') as `${number}h` },
    }),
  ],
  controllers: [HealthController],
  providers: [PrismaService],
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

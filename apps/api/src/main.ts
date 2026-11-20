import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && (!secret || secret === 'change-me')) {
    throw new Error('JWT_SECRET must be set in production');
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean) });
  await app.listen(Number(process.env.PORT ?? 4000));
}
void bootstrap();

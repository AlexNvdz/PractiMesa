import { Controller, Get, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { requireLocation } from '../common/tenant/tenant-context';
import { LiveEventsService } from './live-events.service';

/** Keeps proxies (Railway, Vercel) from closing an idle stream. */
const PING_MS = 25_000;

@Controller('events')
export class LiveController {
  constructor(
    private readonly live: LiveEventsService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Server-sent events of the request location (any role): `order` and `table`, with the id of the row
   * that changed. Events are not replayed, so the terminal loads everything on each (re)connect and then
   * refetches what each event names. The stream ends when the access token that opened it expires; the
   * client reconnects with a fresh one, so a revoked user stops receiving within the token lifetime.
   */
  @Get()
  stream(@Req() req: Request, @Res() res: Response) {
    const tenant = req.tenant!;
    const locationId = requireLocation(tenant);
    // TenantMiddleware already verified this token.
    const { exp } = this.jwt.decode<{ exp: number }>(req.headers.authorization!.slice('Bearer '.length));

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    const expiry = setTimeout(() => stop(), exp * 1000 - Date.now());
    const unsubscribe = this.live.subscribe((event) => {
      // Feed interrupted: ending the stream makes the client reconnect and resync.
      if (!event) return stop();
      if (event.organization_id !== tenant.organizationId || event.location_id !== locationId) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify({ id: event.id })}\n\n`);
    });
    const stop = () => {
      unsubscribe();
      clearInterval(ping);
      clearTimeout(expiry);
      res.end();
    };
    res.on('close', stop);
  }
}

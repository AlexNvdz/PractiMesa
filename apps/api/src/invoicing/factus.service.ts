import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { deleteCredentials, readCredentials, writeCredentials } from '../payments/credentials';
import { PrismaService } from '../prisma/prisma.service';

export interface FactusAccount {
  client_id: string;
  client_secret: string;
  /** Email of the Factus user. */
  username: string;
  password: string;
  /** Required by Factus only when the account has several active ranges. */
  numbering_range_id?: number;
}

interface Token {
  access: string;
  refresh?: string;
  expiresAt: number;
}

const baseUrl = () => process.env.FACTUS_API_URL ?? 'https://api-sandbox.factus.com.co';

/**
 * Factus e-invoicing client. Each business invoices with its own account (sealed in organization_credentials);
 * without one, the shared sandbox account of the environment. OAuth2 password grant, renewed with the refresh
 * token before `expires_in` runs out (the docs disagree on its length, so it is read from each response).
 */
@Injectable()
export class FactusService {
  private readonly tokens = new Map<string, Promise<Token>>();

  constructor(private readonly prisma: PrismaService) {}

  /** Account of the environment, if configured (staging demo). Leave it unset in production. */
  sharedAccount(): FactusAccount | null {
    const env = process.env;
    if (!env.FACTUS_CLIENT_ID || !env.FACTUS_CLIENT_SECRET || !env.FACTUS_USERNAME || !env.FACTUS_PASSWORD) return null;
    return {
      client_id: env.FACTUS_CLIENT_ID,
      client_secret: env.FACTUS_CLIENT_SECRET,
      username: env.FACTUS_USERNAME,
      password: env.FACTUS_PASSWORD,
      numbering_range_id: Number(env.FACTUS_NUMBERING_RANGE_ID) || undefined,
    };
  }

  ownAccount(organizationId: string) {
    return readCredentials<FactusAccount>(this.prisma, organizationId, 'FACTUS');
  }

  async accountFor(organizationId: string): Promise<FactusAccount> {
    const account = (await this.ownAccount(organizationId)) ?? this.sharedAccount();
    if (!account) throw new ServiceUnavailableException('Factus no está configurado para este negocio');
    return account;
  }

  /** Logs in with the credentials (proves them) and stores them sealed. */
  async saveAccount(organizationId: string, account: FactusAccount) {
    const key = this.tokenKey(account);
    this.tokens.delete(key);
    try {
      await this.remember(key, this.grant(account, { grant_type: 'password', username: account.username, password: account.password }));
    } catch {
      throw new BadRequestException('Factus rechazó esas credenciales');
    }
    await writeCredentials(this.prisma, organizationId, 'FACTUS', account);
  }

  removeAccount(organizationId: string) {
    return deleteCredentials(this.prisma, organizationId, 'FACTUS');
  }

  /** Creates and validates the invoice; the same reference_code again returns the existing one. */
  validateBill(account: FactusAccount, body: object) {
    return this.request(account, '/v2/bills/validate', { method: 'POST', body: JSON.stringify(body) });
  }

  /** Deletes an invoice Factus registered but the DIAN has not validated, so it can be sent again. */
  deleteBill(account: FactusAccount, reference: string) {
    return this.request(account, `/v2/bills/destroy/reference/${encodeURIComponent(reference)}`, { method: 'DELETE' });
  }

  private tokenKey(account: FactusAccount) {
    return `${baseUrl()}|${account.client_id}|${account.username}`;
  }

  private async grant(account: FactusAccount, params: Record<string, string>): Promise<Token> {
    const res = await fetch(`${baseUrl()}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ client_id: account.client_id, client_secret: account.client_secret, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) throw new Error(`Factus rechazó la autenticación (${res.status})`);
    return { access: body.access_token, refresh: body.refresh_token, expiresAt: Date.now() + (body.expires_in ?? 600) * 1000 };
  }

  private remember(key: string, token: Promise<Token>) {
    this.tokens.set(key, token);
    token.catch(() => {
      if (this.tokens.get(key) === token) this.tokens.delete(key);
    });
    return token;
  }

  /** Valid access token: cached, refreshed a minute before it expires, or a new login. */
  private async token(account: FactusAccount, forceLogin = false): Promise<string> {
    const key = this.tokenKey(account);
    const cached = forceLogin ? undefined : await this.tokens.get(key)?.catch(() => undefined);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.access;
    const login = () => this.grant(account, { grant_type: 'password', username: account.username, password: account.password });
    const next = cached?.refresh
      ? this.grant(account, { grant_type: 'refresh_token', refresh_token: cached.refresh }).catch(login)
      : login();
    return (await this.remember(key, next)).access;
  }

  private async request(account: FactusAccount, path: string, init: RequestInit) {
    const send = async (token: string) =>
      fetch(`${baseUrl()}${path}`, {
        ...init,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
    const res = await send(await this.token(account));
    return res.status === 401 ? send(await this.token(account, true)) : res;
  }
}

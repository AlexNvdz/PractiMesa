import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { deleteCredentials, hasCredentials, readCredentials, writeCredentials } from './credentials';

export interface PayAccount {
  email: string;
  password: string;
  /** Secret the business sets in its Factus Pay panel; arrives as ?key= on the webhook. */
  webhookKey: string;
}

export interface Collection {
  reference_code: string;
  amount: number | string;
  status: string;
  /** data:image/png;base64,... */
  qr: string | null;
  breb_key: string | null;
}

const baseUrl = () => process.env.FACTUS_PAY_API_URL ?? 'https://pay-api-sandbox.factus.com.co';
const json = (res: Response) => res.json().catch(() => ({})) as Promise<{ token?: string; data?: Collection; message?: string }>;

/**
 * Factus Pay client. Each business uses its own account (sealed in organization_credentials); without one,
 * the shared account of the environment (sandbox demo). POST /auth revokes the account's previous token,
 * so tokens are cached per account and renewed only after a 401.
 */
@Injectable()
export class FactusPayService {
  private readonly tokens = new Map<string, Promise<string>>();

  constructor(private readonly prisma: PrismaService) {}

  /** Account of the environment, if configured (staging demo). Leave it unset in production. */
  sharedAccount(): PayAccount | null {
    const { FACTUS_PAY_EMAIL: email, FACTUS_PAY_PASSWORD: password, FACTUS_PAY_WEBHOOK_KEY: webhookKey } = process.env;
    return email && password && webhookKey ? { email, password, webhookKey } : null;
  }

  ownAccount(organizationId: string) {
    return readCredentials<PayAccount>(this.prisma, organizationId, 'FACTUS_PAY');
  }

  hasOwnAccount(organizationId: string) {
    return hasCredentials(this.prisma, organizationId, 'FACTUS_PAY');
  }

  async accountFor(organizationId: string): Promise<PayAccount> {
    const account = (await this.ownAccount(organizationId)) ?? this.sharedAccount();
    if (!account) throw new ServiceUnavailableException('Factus Pay no está configurado para este negocio');
    return account;
  }

  /** Logs in with the credentials (proves them) and stores them sealed. */
  async saveAccount(organizationId: string, account: PayAccount) {
    const key = this.tokenKey(account);
    this.tokens.delete(key);
    try {
      await this.remember(key, this.login(account));
    } catch {
      throw new BadRequestException('Factus Pay rechazó ese correo y contraseña');
    }
    await writeCredentials(this.prisma, organizationId, 'FACTUS_PAY', account);
  }

  removeAccount(organizationId: string) {
    return deleteCredentials(this.prisma, organizationId, 'FACTUS_PAY');
  }

  /** Idempotent on reference_code: asking again returns the existing collection. `expiration` in seconds. */
  async createCollection(account: PayAccount, reference_code: string, amount: number, expiration: number) {
    const res = await this.request(account, '/v1/collections', {
      method: 'POST',
      body: JSON.stringify({ reference_code, amount, expiration }),
    });
    const body = await json(res);
    if (!res.ok || !body.data) throw new BadGatewayException(`Factus Pay no generó el QR (${body.message ?? res.status})`);
    return body.data;
  }

  /** null when Factus Pay does not know the reference. */
  async getCollection(account: PayAccount, reference: string) {
    const res = await this.request(account, `/v1/collections/${encodeURIComponent(reference)}`);
    if (res.status === 404) return null;
    const body = await json(res);
    if (!res.ok || !body.data) throw new BadGatewayException(`Factus Pay no respondió la consulta (${body.message ?? res.status})`);
    return body.data;
  }

  private tokenKey(account: PayAccount) {
    return `${baseUrl()}|${account.email}`;
  }

  private async login(account: PayAccount) {
    const res = await fetch(`${baseUrl()}/auth`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    const body = await json(res);
    if (!res.ok || !body.token) throw new BadGatewayException(`Factus Pay rechazó la autenticación (${res.status})`);
    return body.token;
  }

  /** Caches a login; a failed one is forgotten so the next call retries. */
  private remember(key: string, login: Promise<string>) {
    this.tokens.set(key, login);
    login.catch(() => {
      if (this.tokens.get(key) === login) this.tokens.delete(key);
    });
    return login;
  }

  private async request(account: PayAccount, path: string, init: RequestInit = {}) {
    const key = this.tokenKey(account);
    const send = async (token: Promise<string>) =>
      fetch(`${baseUrl()}${path}`, {
        ...init,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${await token}` },
      });
    const first = this.tokens.get(key) ?? this.remember(key, this.login(account));
    const res = await send(first);
    if (res.status !== 401) return res;
    // Drop only the token this call used: a concurrent call may already have logged in again.
    if (this.tokens.get(key) === first) this.tokens.delete(key);
    return send(this.tokens.get(key) ?? this.remember(key, this.login(account)));
  }
}

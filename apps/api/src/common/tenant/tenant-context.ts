export type PlanTier = 'SINGLE' | 'MULTI';
export type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'WAITER' | 'KITCHEN';

export interface TenantContext {
  userId: string;
  role: Role;
  organizationId: string;
  planTier: PlanTier;
  maxLocations: number;
  /** Resolved location for this request; undefined on org-level requests in MULTI orgs. */
  locationId?: string;
  /** Active locations this user may operate. */
  locationIds: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: TenantContext;
  }
}

import { prisma } from '../prisma';
import { Request } from 'express';

/**
 * Journalise une action dans AuditLog (connexions, échecs, mutations).
 * Ne lève jamais d'erreur (best-effort) pour ne pas casser le flux principal.
 */
export async function auditLog(params: {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  details?: unknown;
  req?: Request;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        entity: params.entity ?? null,
        entityId: params.entityId ?? null,
        details: params.details ? (params.details as object) : undefined,
        ip: params.req?.ip ?? null,
        userAgent: params.req?.headers['user-agent'] ?? null,
      },
    });
  } catch (e) {
    // On ignore silencieusement : l'audit ne doit pas faire échouer la requête.
    console.warn('[auditLog] échec (ignoré):', (e as Error).message);
  }
}

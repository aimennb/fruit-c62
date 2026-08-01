import { Request, Response } from 'express';
import type { PrismaClient, Prisma } from '@prisma/client';

/** Renvoie une réponse 501 (non implémenté en Phase A) homogène. */
export function notImplemented(res: Response): void {
  res.status(501).json({
    error: 'Non implémenté',
    message: 'Module métier à livrer en Phase B/C/D. Le schéma DB est cependant complet.',
  });
}

/** Sérialise un Decimal Prisma en string (JSON safe). */
export function dec(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v.toString();
}

/** Paramètres de liste/pagination/recherche communs (q, tri, page/take, filtres). */
export interface ListQuery {
  page: number;
  take: number;
  skip: number;
  q?: string;
  sortBy?: string;
  sortDir: 'asc' | 'desc';
  active?: boolean;
  categoryId?: string;
}

/** Parse les query params de liste (page/take/q/sortBy/sortDir/active/categoryId). */
export function parseListQuery(req: Request): ListQuery {
  const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
  const takeRaw = parseInt((req.query.take as string) ?? '20', 10);
  const take = Math.min(200, Math.max(1, takeRaw || 20));
  const q =
    typeof req.query.q === 'string' && req.query.q.trim().length > 0
      ? req.query.q.trim()
      : undefined;
  const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined;
  const sortDir: 'asc' | 'desc' = req.query.sortDir === 'desc' ? 'desc' : 'asc';
  const active: boolean | undefined =
    req.query.active === undefined ? undefined : req.query.active === 'true';
  const categoryId =
    typeof req.query.categoryId === 'string' && req.query.categoryId.trim().length > 0
      ? req.query.categoryId.trim()
      : undefined;
  return { page, take, skip: (page - 1) * take, q, sortBy, sortDir, active, categoryId };
}

/** Enveloppe une page de résultats (métadonnées de pagination). */
export function paginate<T>(items: T[], total: number, page: number, take: number) {
  return {
    items,
    total,
    page,
    take,
    totalPages: take > 0 ? Math.ceil(total / take) : 0,
  };
}

/** Parse un champ montant (string|number) en Decimal Prisma, ou undefined si absent. */
export function moneyField(v: unknown): import('@prisma/client').Prisma.Decimal | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return new (require('@prisma/client').Prisma).Decimal(v as any);
}

// =====================================================================
// CRÉDIT CLIENT — util partagé (réutilisable par le module Ventes 1/3).
// =====================================================================

export interface CreditCheckResult {
  /** true si le client peut encore encaisser `amount` sans dépasser sa limite. */
  ok: boolean;
  /** Limite de crédit (Decimal string). */
  limit: string;
  /** Solde actuel (= dette client courante, Decimal string). */
  current: string;
  /** Solde après ajout de `amount` (Decimal string). */
  after: string;
  /** Disponible = limit - current (Decimal string). */
  available: string;
  /** true si after > limit (dépassement). */
  exceeded: boolean;
}

/**
 * Vérifie si un client peut prendre en charge un montant supplémentaire `amount`
 * sans dépasser sa limite de crédit. Utilise Customer.balance comme solde courant
 * (dette cliente). balance DOIT avoir été tenu à jour par les encaissements/paiements.
 *
 * @param prisma client Prisma (ou transaction client)
 * @param customerId id du client
 * @param amount montant additionnel (Decimal/string/number) à vérifier
 * @param txClient optionnel : client transactionnel pour être cohérent dans une $transaction
 */
export async function checkCreditLimit(
  prisma: PrismaClient | Prisma.TransactionClient,
  customerId: string,
  amount: Prisma.Decimal.Value | string | number,
  txClient?: Prisma.TransactionClient,
): Promise<CreditCheckResult> {
  const D = (v: any) => new (require('@prisma/client').Prisma).Decimal(v as any);
  const client = (txClient ?? prisma) as any;
  const customer = await client.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    const e: any = new Error('Client introuvable');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const limit = D(customer.creditLimit ?? 0);
  const current = D(customer.balance ?? 0);
  const add = D(amount);
  const after = current.plus(add);
  const available = limit.minus(current);
  const exceeded = after.greaterThan(limit);
  return {
    ok: !exceeded,
    limit: limit.toString(),
    current: current.toString(),
    after: after.toString(),
    available: available.toString(),
    exceeded,
  };
}

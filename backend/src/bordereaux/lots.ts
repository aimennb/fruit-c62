// =====================================================================
// Helper partagé : résolution des lots d'un bordereau fournisseur.
// Multi-calibres : un bordereau agrège N lots (StockLot.bordereauId).
// Rétro-compat : les anciens bordereaux mono-calibre référencent le lot
// via bordereau.lotId (backfillé aussi dans StockLot.bordereauId).
// =====================================================================
import { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient | any;

/** Retourne la liste (dédupliquée) des ids de lots rattachés au bordereau. */
export async function getBordereauLotIds(db: Db, bordereau: { id: string; lotId?: string | null }): Promise<string[]> {
  const lots = await db.stockLot.findMany({
    where: { bordereauId: bordereau.id, deletedAt: null },
    select: { id: true },
  });
  const ids = new Set<string>(lots.map((l: { id: string }) => l.id));
  if (bordereau.lotId) ids.add(bordereau.lotId);
  return Array.from(ids);
}

/** Retourne les lots complets du bordereau (pour affichage calibres/lots). */
export async function getBordereauLots(db: Db, bordereau: { id: string; lotId?: string | null }) {
  const ids = await getBordereauLotIds(db, bordereau);
  if (ids.length === 0) return [];
  return db.stockLot.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: 'asc' },
  });
}

/** Trouve le bordereau d'un lot : via lot.bordereauId sinon via bordereau.lotId (rétro-compat). */
export async function findBordereauForLot(db: Db, lot: { id: string; bordereauId?: string | null }) {
  if (lot.bordereauId) {
    const b = await db.supplierBordereau.findFirst({ where: { id: lot.bordereauId, deletedAt: null } });
    if (b) return b;
  }
  return db.supplierBordereau.findFirst({ where: { lotId: lot.id, deletedAt: null } });
}

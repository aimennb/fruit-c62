// =====================================================================
// Types & helpers de sérialisation pour les bulletins d'achat.
// Règle d'or : l'argent et les poids sont TOUJOURS en Decimal (Prisma),
// jamais en float. On sérialise en string pour le JSON (sûr).
// =====================================================================
import { Prisma } from '@prisma/client';
import type { PurchaseBulletin, PurchaseBulletinItem } from '@prisma/client';

/** Sérialise un Decimal (ou null) en string. */
export function dec(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v.toString();
}

/** Type d'une ligne de bulletin telle que renvoyée au client (Decimal -> string). */
export interface BulletinItemDTO {
  id: string;
  productId: string;
  productName: string;
  marque: string | null;
  nbrColis: string;
  poidsBrut: string;
  tare: string;
  poidsNet: string;
  prixUnitaire: string;
  montant: string;
}

export interface BulletinDTO {
  id: string;
  reference: string;
  purchaseId: string | null;
  date: string;
  status: string;
  deliveredTo: string | null;
  marque: string | null;
  emballage: string | null;
  consigne: string | null;
  carrier: string | null;
  notes: string | null;
  totalWeight: string;
  totalAmount: string;
  items: BulletinItemDTO[];
}

/** Replie une ligne (avec sa relation product) en DTO. */
export function serializeItem(it: PurchaseBulletinItem & { product?: { id: string; name: string } }): BulletinItemDTO {
  return {
    id: it.id,
    productId: it.productId,
    productName: it.product?.name ?? '',
    marque: it.marque,
    nbrColis: dec(it.nbrColis)!,
    poidsBrut: dec(it.poidsBrut)!,
    tare: dec(it.tare)!,
    poidsNet: dec(it.poidsNet)!,
    prixUnitaire: dec(it.prixUnitaire)!,
    montant: dec(it.montant)!,
  };
}

/** Replie un bulletin (avec ses items + produits) en DTO. */
export function serializeBulletin(b: PurchaseBulletin & { items: (PurchaseBulletinItem & { product?: any })[] }): BulletinDTO {
  return {
    id: b.id,
    reference: b.reference,
    purchaseId: b.purchaseId,
    date: b.date.toISOString(),
    status: b.status,
    deliveredTo: b.deliveredTo,
    marque: b.marque,
    emballage: b.emballage,
    consigne: b.consigne,
    carrier: b.carrier,
    notes: b.notes,
    totalWeight: dec(b.totalWeight)!,
    totalAmount: dec(b.totalAmount)!,
    items: (b.items ?? []).map(serializeItem),
  };
}

/** Helper pour des calculs Decimal réutilisables. */
export const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

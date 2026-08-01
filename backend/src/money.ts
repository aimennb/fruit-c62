// =====================================================================
// Utilitaires monétaires — L'argent est TOUJOURS manipulé en Decimal.
// JAMAIS de float pour les calculs DA. On centralise ici les helpers.
// =====================================================================
import { Prisma } from '@prisma/client';

export type DecimalLike = Prisma.Decimal | number | string;

/** Additionne une liste de valeurs monétaires (Decimal). */
export function moneyAdd(values: DecimalLike[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (acc, v) => acc.plus(new Prisma.Decimal(v)),
    new Prisma.Decimal(0),
  );
}

/** Multiplie quantité * prix unitaire -> total arrondi à 2 décimales (banker-safe). */
export function moneyMul(quantity: DecimalLike, unitPrice: DecimalLike): Prisma.Decimal {
  return new Prisma.Decimal(quantity).times(new Prisma.Decimal(unitPrice)).toDecimalPlaces(2);
}

/** Soustrait b de a. */
export function moneySub(a: DecimalLike, b: DecimalLike): Prisma.Decimal {
  return new Prisma.Decimal(a).minus(new Prisma.Decimal(b));
}

/** Arrondit une valeur à 2 décimales (centimes DA). */
export function round2(v: DecimalLike): Prisma.Decimal {
  return new Prisma.Decimal(v).toDecimalPlaces(2);
}

/** Convertit un Decimal Prisma en number pour la sérialisation JSON (API uniquement). */
export function toNumber(v: DecimalLike): number {
  return new Prisma.Decimal(v).toNumber();
}

/** Formate un montant en DA pour l'affichage. */
export function formatDA(v: DecimalLike): string {
  return `${new Prisma.Decimal(v).toFixed(2)} DA`;
}

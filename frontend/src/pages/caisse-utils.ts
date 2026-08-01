// Utilitaires communs au module Caisse (formatage DA, dates, couleurs).

/** Formate un montant Decimal (string) en DA. */
export function fmtDA(v: string | number | null | undefined): string {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '0,00 DA'
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DA`
}

/** Date du jour au format YYYY-MM-DD. */
export function aujourdhui(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Heure courante HH:MM. */
export function heureCourante(): string {
  const n = new Date()
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`
}

/** Affiche une date YYYY-MM-DD en JJ/MM/AAAA. */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—'
  const d = String(v).slice(0, 10).split('-')
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(v)
}

/** Libellé + couleur du statut d'une journée de caisse. */
export function statutBadge(status: string): { label: string; color: string } {
  switch (status) {
    case 'cloturee':
      return { label: 'Clôturée', color: 'blue' }
    case 'à_vérifier':
      return { label: 'À vérifier', color: 'amber' }
    case 'reouverte':
      return { label: 'Réouverte', color: 'amber' }
    default:
      return { label: 'Ouverte', color: 'green' }
  }
}

/** Catégories de dépense proposées à la saisie. */
export const CATEGORIES_DEPENSE = [
  'Transport',
  'Carburant',
  'Salaires',
  'Loyer',
  'Fournitures',
  'Entretien',
  'Électricité / Eau',
  'Téléphone / Internet',
  'Taxes / Droit de marché',
  'Divers',
]

/** Modes de paiement (alignés sur l'enum PaymentMethod du backend). */
export const MODES_PAIEMENT = [
  { value: 'CASH', label: 'Espèces' },
  { value: 'BANK_TRANSFER', label: 'Virement' },
  { value: 'CHECK', label: 'Chèque' },
  { value: 'CARD', label: 'Carte' },
]

import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSupplierBordereaux } from '../api'
import { PageHeader, ErrorBox, Button, Table, Spinner, EmptyState, Badge, Input } from '../components/ui'
import { useLang } from '../i18n'
import { useBarcodeSearch } from '../hooks/useBarcodeSearch'

interface BordereauRow {
  id: string
  reference: string
  supplierId: string
  productId: string
  colisRecus: string
  colisVendus: string
  colisRestant: string
  statut: string
  calibre?: string | null
  totalBrutVentes: string
  montantFinalDu?: string
  droitMarche?: string
  transport?: string
  supplier?: { id: string; name: string }
  product?: { id: string; name: string }
}

/** Fond de ligne selon le statut de paiement : vert = payé, orange = partiel. */
function rowBg(s: string): string {
  if (s === 'paye') return 'bg-[#d4edda] hover:bg-[#c3e6cb]'
  if (s === 'partiellement_paye') return 'bg-[#fff3cd] hover:bg-[#ffeeba]'
  return 'hover:bg-gray-50'
}

function statutColor(s: string): string {
  switch (s) {
    case 'ouvert':
      return 'green'
    case 'pret_a_cloturer':
      return 'amber'
    case 'cloture':
      return 'blue'
    case 'paye':
      return 'green'
    case 'partiellement_paye':
      return 'amber'
    case 'annule':
      return 'red'
    default:
      return 'gray'
  }
}

export default function Bordereaux() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [items, setItems] = useState<BordereauRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // Scanner code-barres USB : EAN13 saisi dans la barre → redirection détail.
  useBarcodeSearch(q, { onNotFound: (m) => setError(m) })
  const [statutFiltre, setStatutFiltre] = useState<string>('tous')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getSupplierBordereaux()
      setItems((r.items ?? []) as BordereauRow[])
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const headers = ar
    ? ['المرجع', 'المورد', 'المنتج', 'الطرود المستلمة', 'المباعة', 'المتبقية', 'الحالة', 'إجمالي المبيعات', 'المبلغ النهائي', '']
    : ['Référence', 'Fournisseur', 'Produit', 'Colis reçus', 'Vendus', 'Restants', 'Statut', 'Total brut', 'Montant dû', '']

  const filtered = items.filter((b) => {
    const t = q.trim().toLowerCase()
    if (statutFiltre !== 'tous' && b.statut !== statutFiltre) return false
    if (!t) return true
    return (
      (b.reference ?? '').toLowerCase().includes(t) ||
      (b.supplier?.name ?? '').toLowerCase().includes(t) ||
      (b.product?.name ?? '').toLowerCase().includes(t)
    )
  })

  const filtresStatut = [
    { val: 'tous', fr: 'Tous', ar: 'الكل' },
    { val: 'ouvert', fr: 'Ouvert', ar: 'مفتوح' },
    { val: 'pret_a_cloturer', fr: 'Pré-à-clôturer', ar: 'جاهز للإغلاق' },
    { val: 'cloture', fr: 'Clôturé', ar: 'مغلق' },
  ]

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={ar ? 'برديات الموردين' : 'Bordereaux fournisseurs'}
        subtitle={ar ? 'قائمة جميع البرديات' : 'Liste de tous les bordereaux'}
      />

      {error && <ErrorBox message={error} />}

      {loading ? (
        <Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} />
      ) : items.length === 0 ? (
        <EmptyState message={ar ? 'لا توجد برديات' : 'Aucun bordereau'} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {filtresStatut.map((f) => (
              <Button
                key={f.val}
                variant={statutFiltre === f.val ? 'primary' : 'secondary'}
                onClick={() => setStatutFiltre(f.val)}
              >
                {ar ? f.ar : f.fr}
              </Button>
            ))}
          </div>

          <Input
            placeholder={ar ? 'بحث بالمرجع أو الإسم' : 'Recherche (référence, fournisseur, produit)...'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-md"
          />
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-500">{ar ? 'لا توجد نتائج' : 'Aucun résultat'}</p>
          ) : (
            <Table headers={headers}>
              {filtered.map((b) => (
                <tr key={b.id} className={rowBg(b.statut)}>
              <td className="px-4 py-3 font-semibold text-gray-800 whitespace-nowrap">{b.reference}</td>
              <td className="px-4 py-3 whitespace-nowrap">{b.supplier?.name ?? '—'}</td>
              <td className="px-4 py-3 whitespace-nowrap">{(b.product?.name ?? '—') + (b.calibre ? ' / ' + b.calibre : '')}</td>
              <td className="px-4 py-3 text-center">{Number(b.colisRecus)}</td>
              <td className="px-4 py-3 text-center">{Number(b.colisVendus)}</td>
              <td className="px-4 py-3 text-center">{Number(b.colisRestant)}</td>
              <td className="px-4 py-3 whitespace-nowrap">
                <Badge color={statutColor(b.statut)}>{b.statut}</Badge>
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">{Number(b.totalBrutVentes).toFixed(2)} DA</td>
              <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-fruite-green">{Number(b.montantFinalDu ?? 0).toFixed(2)} DA</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2 justify-end">
                  <Button variant="secondary" className="px-3" onClick={() => navigate(`/bordereaux/${b.id}`)}>
                    {ar ? 'عرض' : 'Voir'}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
            </Table>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getSuppliers,
  getReceptions,
  getSupplierBordereaux,
  type SupplierReception,
} from '../api'
import { request } from '../api'
import {
  PageHeader,
  ErrorBox,
  Button,
  Table,
  Spinner,
  Badge,
} from '../components/ui'
import { useLang } from '../i18n'

interface NamedItem {
  id: string
  name: string
  nameAr?: string | null
}

interface BordereauRow {
  id: string
  reference: string
  supplierId: string
  productId: string
  colisRecus: string
  colisVendus: string
  colisRestant: string
  statut: string
  totalBrutVentes: string
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

export default function SupplierDetail() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const id = params.get('id') ?? ''

  const [supplierName, setSupplierName] = useState('')
  const [supplierPhone, setSupplierPhone] = useState<string | null>(null)
  const [supplierBalance, setSupplierBalance] = useState<string | number | null>(null)

  const [receptions, setReceptions] = useState<SupplierReception[]>([])
  const [bordereaux, setBordereaux] = useState<BordereauRow[]>([])
  const [products, setProducts] = useState<Map<string, string>>(new Map())

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) {
      setError(ar ? 'معرف المورد مفقود' : 'Identifiant fournisseur manquant')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [sup, rec, bord, prod] = await Promise.all([
        getSuppliers(),
        getReceptions(),
        getSupplierBordereaux(),
        request<{ items: NamedItem[] }>('/api/products?take=500').catch(() => ({ items: [] })),
      ])
      const found = (sup.items ?? []).find((s) => s.id === id)
      setSupplierName(found?.name ?? (ar ? 'مورد غير معروف' : 'Fournisseur inconnu'))
      setSupplierPhone(found?.phone ?? null)
      setSupplierBalance(found?.balance ?? null)

      setReceptions((rec.items ?? []).filter((r) => r.supplierId === id))
      setBordereaux((bord.items ?? []) as BordereauRow[])
      setProducts(new Map((prod.items ?? []).map((p) => [p.id, p.name])))
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [id, ar])

  useEffect(() => {
    void load()
  }, [load])

  // Bordereaux filtrés par ce fournisseur
  const filteredBordereaux = bordereaux.filter((b) => b.supplier?.id === id)

  const receptionHeaders = ar
    ? ['المرجع', 'التاريخ', 'المنتج', 'الطرود', 'وزن الغلاف', 'البردية', 'ملاحظات']
    : ['Référence', 'Date', 'Produit', 'Nb colis', 'Poids emb.', 'Bordereau', 'Observations']

  const bordereauHeaders = ar
    ? ['المرجع', 'المنتج', 'الطرود المستلمة', 'المباعة', 'المتبقية', 'الحالة', 'إجمالي المبيعات']
    : ['Référence', 'Produit', 'Colis reçus', 'Vendus', 'Restants', 'Statut', 'Total brut']

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={supplierName}
        subtitle={ar ? 'تفاصيل المورد' : 'Détail fournisseur'}
        actions={
          <Button variant="secondary" onClick={() => navigate('/fournisseurs')}>
            {ar ? 'رجوع' : 'Retour'}
          </Button>
        }
      />

      {/* En-tête infos fournisseur */}
      <div className="flex flex-wrap gap-4 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm">
        {supplierPhone && (
          <span className="text-gray-600">
            <span className="text-gray-400">{ar ? 'الهاتف' : 'Tél.'} : </span>
            <span className="font-medium text-gray-800">{supplierPhone}</span>
          </span>
        )}
        {supplierBalance != null && supplierBalance !== '' && (
          <span className="text-gray-600">
            <span className="text-gray-400">{ar ? 'الرصيد' : 'Solde'} : </span>
            <span className="font-semibold text-fruite-green">{supplierBalance}</span>
          </span>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      {loading ? (
        <Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} />
      ) : (
        <>
          {/* Section Bons de réception */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-800">
              {ar ? 'وصولات الاستلام' : 'Bons de réception'}
            </h2>
            {receptions.length === 0 ? (
              <p className="text-sm text-gray-500">
                {ar ? 'لا توجد وصولات استلام' : 'Aucun bon de réception'}
              </p>
            ) : (
              <Table headers={receptionHeaders}>
                {receptions.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-semibold text-gray-800 whitespace-nowrap">{r.reference}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600">
                      {new Date(r.date).toLocaleDateString('fr-FR')}
                      {r.heure ? ` ${r.heure}` : ''}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{products.get(r.productId) ?? '—'}</td>
                    <td className="px-4 py-3 text-center">{Number(r.nbrColis)}</td>
                    <td className="px-4 py-3 text-center">{Number(r.poidsEmballageVide)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.bordereau?.reference ?? '—'}
                      {r.bordereau?.statut && (
                        <span className="ms-2">
                          <Badge color={r.bordereau.statut === 'ouvert' ? 'green' : 'gray'}>
                            {r.bordereau.statut}
                          </Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-[160px] truncate text-gray-500" title={r.observations ?? ''}>
                      {r.observations ?? '—'}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </section>

          {/* Section Bordereaux */}
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-800">
              {ar ? 'برديات' : 'Bordereaux'}
            </h2>
            {filteredBordereaux.length === 0 ? (
              <p className="text-sm text-gray-500">
                {ar ? 'لا توجد برديات' : 'Aucun bordereau'}
              </p>
            ) : (
              <Table headers={bordereauHeaders}>
                {filteredBordereaux.map((b) => (
                  <tr key={b.id} className={`${rowBg(b.statut)} cursor-pointer`} onClick={() => navigate(`/bordereaux/${b.id}`)}>
                    <td className="px-4 py-3 font-semibold text-gray-800 whitespace-nowrap">{b.reference}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{b.product?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-center">{Number(b.colisRecus)}</td>
                    <td className="px-4 py-3 text-center">{Number(b.colisVendus)}</td>
                    <td className="px-4 py-3 text-center">{Number(b.colisRestant)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge color={statutColor(b.statut)}>{b.statut}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {Number(b.totalBrutVentes).toFixed(2)} DA
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  )
}

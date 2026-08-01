import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { getReception, openReceptionPdf, request, type SupplierReceptionDetail } from '../api'
import { PageHeader, ErrorBox, Button, Spinner, EmptyState, Badge } from '../components/ui'
import { useLang } from '../i18n'

interface NamedItem {
  id: string
  name: string
}

export default function ReceptionDetail() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const [rec, setRec] = useState<SupplierReceptionDetail | null>(null)
  const [suppliers, setSuppliers] = useState<Map<string, string>>(new Map())
  const [products, setProducts] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    Promise.all([
      getReception(id),
      request<{ items: NamedItem[] }>('/api/suppliers?take=500').catch(() => ({ items: [] as NamedItem[] })),
      request<{ items: NamedItem[] }>('/api/products?take=500').catch(() => ({ items: [] as NamedItem[] })),
    ])
      .then(([r, sup, prod]) => {
        setRec(r)
        setSuppliers(new Map((sup.items ?? []).map((s) => [s.id, s.name])))
        setProducts(new Map((prod.items ?? []).map((p) => [p.id, p.name])))
      })
      .catch((e: any) => setError(e?.message ?? 'Erreur de chargement'))
      .finally(() => setLoading(false))
  }, [id])

  async function printPdf() {
    if (!id) return
    try {
      await openReceptionPdf(id)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur PDF')
    }
  }

  if (loading) return <div className="p-6"><Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} /></div>
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>
  if (!rec) return <div className="p-6"><EmptyState message={ar ? 'وصل غير موجود' : 'Réception introuvable'} /></div>

  const b = rec.bordereau
  const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : `${Number(v)} DA`)

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title={`${ar ? 'وصل الاستلام' : 'Bon de réception'} ${rec.reference}`}
        subtitle={`${new Date(rec.date).toLocaleDateString('fr-FR')}${rec.heure ? ' ' + rec.heure : ''}`}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={printPdf}>{ar ? 'طباعة A5' : 'Imprimer A5'}</Button>
            <Button variant="ghost" onClick={() => navigate('/receptions')}>
              {ar ? 'العودة للقائمة' : '← Retour à la liste'}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs uppercase text-slate-400">{ar ? 'المورد' : 'Fournisseur'}</p>
          <p className="text-lg font-semibold text-slate-800">{suppliers.get(rec.supplierId) ?? '—'}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs uppercase text-slate-400">{ar ? 'المنتج' : 'Produit'}</p>
          <p className="text-lg font-semibold text-slate-800">{products.get(rec.productId) ?? '—'}</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">{ar ? 'أسطر المعايير' : 'Lignes calibre'}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="py-2 pr-4">{ar ? 'المعيار' : 'Calibre'}</th>
              <th className="py-2 pr-4">{ar ? 'عدد الطرود' : 'Nb colis'}</th>
              <th className="py-2 pr-4">{ar ? 'وزن الغلاف الفارغ (كغ)' : 'Poids emb. vide (kg)'}</th>
              <th className="py-2">{ar ? 'رقم الحصة' : 'N° lot'}</th>
            </tr>
          </thead>
          <tbody>
            {(rec.items && rec.items.length > 0 ? rec.items : [{ id: 'main', calibre: null, nbrColis: rec.nbrColis, poidsEmballageVide: rec.poidsEmballageVide, lotId: rec.lotId }]).map((it) => (
              <tr key={it.id} className="border-b last:border-0">
                <td className="py-2 pr-4">{it.calibre ?? '—'}</td>
                <td className="py-2 pr-4">{Number(it.nbrColis)}</td>
                <td className="py-2 pr-4">{Number(it.poidsEmballageVide)}</td>
                <td className="py-2">{rec.lot && it.lotId === rec.lot.id ? rec.lot.lotNumber : it.lotId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">{ar ? 'المصاريف والسلفة' : 'Frais & avance'}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs uppercase text-slate-400">{ar ? 'السلفة (دج)' : 'Avance (DA)'}</p>
            <p className="font-semibold">{rec.avanceOui ? fmt(rec.avanceMontant) : ar ? 'بدون سلفة' : 'Aucune'}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-400">{ar ? 'حق السوق (دج)' : 'Droit de marché (DA)'}</p>
            <p className="font-semibold">{fmt(rec.droitMarche)}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-slate-400">{ar ? 'النقل (دج)' : 'Transport (DA)'}</p>
            <p className="font-semibold">{fmt(rec.transport)}</p>
          </div>
        </div>
      </div>

      {b && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">{ar ? 'البردية المرتبطة' : 'Bordereau lié'}</h3>
          <div className="mb-3 flex items-center gap-3">
            {rec.bordereauId ? (
              <Link to={`/bordereaux/${rec.bordereauId}`} className="text-fruite-green font-semibold hover:underline">
                {b.reference}
              </Link>
            ) : (
              <span className="font-semibold">{b.reference}</span>
            )}
            {b.statut && <Badge color={b.statut === 'ouvert' ? 'green' : 'gray'}>{b.statut}</Badge>}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs uppercase text-slate-400">{ar ? 'الطرود المستلمة' : 'Colis reçus'}</p>
              <p className="font-semibold">{b.colisRecus != null ? Number(b.colisRecus) : '—'}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">{ar ? 'إجمالي المبيعات' : 'Total brut ventes'}</p>
              <p className="font-semibold">{fmt(b.totalBrutVentes)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">{ar ? 'العمولة' : 'Commission'}</p>
              <p className="font-semibold">
                {b.commissionValue != null ? `${Number(b.commissionValue)}${b.commissionType === 'pourcentage' ? ' %' : ' DA'}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">{ar ? 'السلف المخصصة' : 'Avances affectées'}</p>
              <p className="font-semibold">{fmt(b.avancesAffectees)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">{ar ? 'حق السوق + النقل' : 'Droit marché + transport'}</p>
              <p className="font-semibold">
                {fmt(Number(b.droitMarche ?? 0) + Number(b.transport ?? 0))}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-slate-400">{ar ? 'المبلغ النهائي المستحق' : 'Montant final dû'}</p>
              <p className="font-semibold">{fmt(b.montantFinalDu)}</p>
            </div>
          </div>
        </div>
      )}

      {rec.observations && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{ar ? 'ملاحظات' : 'Observations'}</h3>
          <p className="text-sm text-slate-600 whitespace-pre-wrap">{rec.observations}</p>
        </div>
      )}
    </div>
  )
}

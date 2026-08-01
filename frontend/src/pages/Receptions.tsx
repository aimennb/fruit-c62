import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getReceptions,
  getReception,
  updateReception,
  openReceptionPdf,
  type SupplierReception,
} from '../api'
import { request } from '../api'
import {
  PageHeader,
  ErrorBox,
  Button,
  Input,
  Field,
  Modal,
  Table,
  Spinner,
  EmptyState,
  Badge,
} from '../components/ui'
import { useLang } from '../i18n'
import { useBarcodeSearch } from '../hooks/useBarcodeSearch'

interface NamedItem {
  id: string
  name: string
  nameAr?: string | null
}

export default function Receptions() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [items, setItems] = useState<SupplierReception[]>([])
  const [suppliers, setSuppliers] = useState<Map<string, string>>(new Map())
  const [products, setProducts] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // Scanner code-barres USB : EAN13 saisi dans la barre → redirection détail.
  useBarcodeSearch(q, { onNotFound: (m) => setError(m) })

  // Modal édition COMPLÈTE (lignes calibre + frais + avance)
  interface LigneCalibre { calibre: string; nbrColis: string; poidsEmb: string }
  const [editing, setEditing] = useState<SupplierReception | null>(null)
  const [lignes, setLignes] = useState<LigneCalibre[]>([{ calibre: '', nbrColis: '', poidsEmb: '0' }])
  const [avanceMontant, setAvanceMontant] = useState('')
  const [droitMarche, setDroitMarche] = useState('')
  const [transport, setTransport] = useState('')
  const [observations, setObservations] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)

  const setLigne = (i: number, patch: Partial<LigneCalibre>) =>
    setLignes((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLigne = () => setLignes((prev) => [...prev, { calibre: '', nbrColis: '', poidsEmb: '0' }])
  const removeLigne = (i: number) => setLignes((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, sup, prod] = await Promise.all([
        getReceptions(),
        request<{ items: NamedItem[] }>('/api/suppliers?take=500').catch(() => ({ items: [] })),
        request<{ items: NamedItem[] }>('/api/products?take=500').catch(() => ({ items: [] })),
      ])
      setItems(r.items ?? [])
      setSuppliers(new Map((sup.items ?? []).map((s) => [s.id, s.name])))
      setProducts(new Map((prod.items ?? []).map((p) => [p.id, p.name])))
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function openEdit(r: SupplierReception) {
    setEditing(r)
    setError(null)
    setAvanceMontant(String(Number(r.avanceMontant)))
    setDroitMarche(String(Number(r.droitMarche ?? 0)))
    setTransport(String(Number(r.transport ?? 0)))
    setObservations(r.observations ?? '')
    setLignes([{ calibre: '', nbrColis: String(Number(r.nbrColis)), poidsEmb: String(Number(r.poidsEmballageVide)) }])
    setLoadingEdit(true)
    try {
      const d = await getReception(r.id)
      setAvanceMontant(String(Number(d.avanceMontant)))
      setDroitMarche(String(Number(d.droitMarche ?? 0)))
      setTransport(String(Number(d.transport ?? 0)))
      setObservations(d.observations ?? '')
      if (d.items && d.items.length > 0) {
        setLignes(
          d.items.map((it) => ({
            calibre: it.calibre ?? '',
            nbrColis: String(Number(it.nbrColis)),
            poidsEmb: String(Number(it.poidsEmballageVide ?? 0)),
          })),
        )
      }
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement de la réception')
    } finally {
      setLoadingEdit(false)
    }
  }

  async function saveEdit() {
    if (!editing) return
    if (lignes.some((l) => !l.nbrColis || Number(l.nbrColis) <= 0)) {
      setError(ar ? 'عدد الطرود يجب أن يكون > 0 في كل سطر' : 'Chaque ligne calibre doit avoir un nombre de colis > 0.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await updateReception(editing.id, {
        items: lignes.map((l) => ({
          calibre: l.calibre.trim() || undefined,
          nbrColis: Number(l.nbrColis),
          poidsEmballageVide: Number(l.poidsEmb || 0),
        })),
        avanceOui: Number(avanceMontant || 0) > 0,
        avanceMontant: Number(avanceMontant || 0),
        droitMarche: Number(droitMarche || 0),
        transport: Number(transport || 0),
        observations: observations || null,
      })
      setEditing(null)
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Erreur lors de la mise à jour')
    } finally {
      setSaving(false)
    }
  }

  async function printPdf(id: string) {
    try {
      await openReceptionPdf(id)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur PDF')
    }
  }

  const headers = ar
    ? ['المرجع', 'التاريخ', 'المورد', 'المنتج', 'الطرود', 'وزن الغلاف', 'السلفة', 'البردية', 'ملاحظات', '']
    : ['Référence', 'Date', 'Fournisseur', 'Produit', 'Nb colis', 'Poids emb.', 'Avance', 'Bordereau', 'Observations', '']

  const filtered = items.filter((r) => {
    const t = q.trim().toLowerCase()
    if (!t) return true
    const sup = (suppliers.get(r.supplierId) ?? '').toLowerCase()
    const bord = (r.bordereau?.reference ?? '').toLowerCase()
    return (r.reference ?? '').toLowerCase().includes(t) || sup.includes(t) || bord.includes(t)
  })

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={ar ? 'وصولات الاستلام' : 'Bons de réception'}
        subtitle={ar ? 'قائمة جميع وصولات الاستلام' : 'Liste de tous les bons de réception'}
        actions={
          <Button onClick={() => navigate('/receptions/new')}>
            {ar ? '+ وصل جديد' : '+ Nouvelle réception'}
          </Button>
        }
      />

      {error && <ErrorBox message={error} />}

      <Input
        placeholder={lang === 'ar' ? 'بحث بالمرجع أو المورد' : 'Recherche (référence, fournisseur)...'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {loading ? (
        <Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} />
      ) : items.length === 0 ? (
        <EmptyState message={ar ? 'لا توجد وصولات استلام' : 'Aucun bon de réception'} />
      ) : filtered.length === 0 ? (
        <EmptyState message={ar ? 'لا توجد نتائج' : 'Aucun résultat'} />
      ) : (
        <Table headers={headers}>
          {filtered.map((r) => (
            <tr
              key={r.id}
              className="hover:bg-gray-50 cursor-pointer"
              onClick={() => navigate('/receptions/detail/' + r.id)}
            >
              <td className="px-4 py-3 font-semibold text-gray-800 whitespace-nowrap">{r.reference}</td>
              <td className="px-4 py-3 whitespace-nowrap text-gray-600">
                {new Date(r.date).toLocaleDateString('fr-FR')}
                {r.heure ? ` ${r.heure}` : ''}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">{suppliers.get(r.supplierId) ?? '—'}</td>
              <td className="px-4 py-3 whitespace-nowrap">{(products.get(r.productId) ?? '—') + (r.bordereau?.calibre ? ' / ' + r.bordereau.calibre : '')}</td>
              <td className="px-4 py-3 text-center">{Number(r.nbrColis)}</td>
              <td className="px-4 py-3 text-center">{Number(r.poidsEmballageVide)}</td>
              <td className="px-4 py-3 whitespace-nowrap">
                {r.avanceOui ? (
                  <Badge color="amber">
                    {ar ? 'نعم' : 'Oui'} — {Number(r.avanceMontant)} DA
                  </Badge>
                ) : (
                  <Badge color="gray">{ar ? 'لا' : 'Non'}</Badge>
                )}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                {r.bordereauId && r.bordereau?.reference ? (
                  <button
                    type="button"
                    className="text-fruite-green font-medium hover:underline"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(`/bordereaux/${r.bordereauId}`)
                    }}
                  >
                    {r.bordereau.reference}
                  </button>
                ) : (
                  r.bordereau?.reference ?? '—'
                )}
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
              <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 justify-end">
                  <Button variant="secondary" className="px-3" onClick={(e) => { e.stopPropagation(); printPdf(r.id) }}>
                    {ar ? 'طباعة A5' : 'Imprimer A5'}
                  </Button>
                  <Button variant="ghost" className="px-3" onClick={(e) => { e.stopPropagation(); void openEdit(r) }}>
                    {ar ? 'تعديل' : 'Modifier'}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal
        open={!!editing}
        title={
          editing
            ? `${ar ? 'تعديل' : 'Modifier'} ${editing.reference}`
            : ''
        }
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {ar ? 'إلغاء' : 'Annuler'}
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? '…' : ar ? 'حفظ' : 'Enregistrer'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {loadingEdit && <Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} />}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="block text-xs text-gray-500">{ar ? 'المورد' : 'Fournisseur'}</span>
              <span className="font-medium text-gray-800">{suppliers.get(editing?.supplierId ?? '') ?? '—'}</span>
            </div>
            <div>
              <span className="block text-xs text-gray-500">{ar ? 'المنتج' : 'Produit'}</span>
              <span className="font-medium text-gray-800">{products.get(editing?.productId ?? '') ?? '—'}</span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">{ar ? 'أسطر المعايير' : 'Lignes calibre'}</span>
              <Button variant="ghost" onClick={addLigne}>{ar ? '+ إضافة معيار' : '+ Ajouter un calibre'}</Button>
            </div>
            {lignes.map((l, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label={ar ? 'المعيار' : 'Calibre'}>
                    <Input
                      placeholder={ar ? 'مثال: 60-70 (اختياري)' : 'ex: 60-70 (optionnel)'}
                      value={l.calibre}
                      onChange={(e) => setLigne(i, { calibre: e.target.value })}
                    />
                  </Field>
                  <Field label={ar ? 'عدد الطرود' : 'Nombre de colis'}>
                    <Input type="number" min="0" value={l.nbrColis} onChange={(e) => setLigne(i, { nbrColis: e.target.value })} />
                  </Field>
                  <Field label={ar ? 'وزن الغلاف الفارغ (كغ)' : 'Poids emballage vide (kg)'}>
                    <Input type="number" min="0" step="0.01" value={l.poidsEmb} onChange={(e) => setLigne(i, { poidsEmb: e.target.value })} />
                  </Field>
                </div>
                {lignes.length > 1 && (
                  <div className="mt-2 text-right">
                    <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => removeLigne(i)}>
                      {ar ? 'حذف السطر' : 'Supprimer cette ligne'}
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="text-right text-xs text-slate-500">
              {ar ? 'المجموع' : 'Total'} : {lignes.reduce((a, l) => a + Number(l.nbrColis || 0), 0)} {ar ? 'طرد' : 'colis'}
            </div>
          </div>

          <Field label={ar ? 'السلفة (دج)' : 'Avance (DA)'}>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder={ar ? 'مبلغ السلفة' : 'Montant avance (DA)'}
              value={avanceMontant}
              onChange={(e) => setAvanceMontant(e.target.value)}
              className="max-w-xs"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={ar ? 'حق السوق (دج)' : 'Droit de marché (DA)'}>
              <Input type="number" min="0" step="0.01" placeholder="0" value={droitMarche} onChange={(e) => setDroitMarche(e.target.value)} />
            </Field>
            <Field label={ar ? 'النقل (دج)' : 'Transport (DA)'}>
              <Input type="number" min="0" step="0.01" placeholder="0" value={transport} onChange={(e) => setTransport(e.target.value)} />
            </Field>
          </div>

          <Field label={ar ? 'ملاحظات' : 'Observations'}>
            <textarea
              className="min-h-[44px] w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green"
              rows={3}
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

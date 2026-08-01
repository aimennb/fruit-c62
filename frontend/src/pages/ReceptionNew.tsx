import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { request, createReception, createSupplier, type SupplierReception } from '../api'
import {
  PageHeader,
  ErrorBox,
  Button,
  Input,
  Field,
  SearchSelect,
  type SearchSelectOption,
} from '../components/ui'
import { useLang } from '../i18n'

interface NamedItem {
  id: string
  name: string
  nameAr?: string | null
}

export default function ReceptionNew() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [suppliers, setSuppliers] = useState<NamedItem[]>([])
  const [products, setProducts] = useState<NamedItem[]>([])
  const [supplierQ, setSupplierQ] = useState('')
  const [productQ, setProductQ] = useState('')

  const [supplierId, setSupplierId] = useState('')
  const [supplierLabel, setSupplierLabel] = useState('')
  const [productId, setProductId] = useState('')
  const [productLabel, setProductLabel] = useState('')
  interface LigneCalibre { calibre: string; nbrColis: string; poidsEmb: string }
  const [lignes, setLignes] = useState<LigneCalibre[]>([{ calibre: '', nbrColis: '', poidsEmb: '0' }])
  const [avanceMontant, setAvanceMontant] = useState('')
  const [droitMarche, setDroitMarche] = useState('')
  const [transport, setTransport] = useState('')
  const [observations, setObservations] = useState('')

  const setLigne = (i: number, patch: Partial<LigneCalibre>) =>
    setLignes((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLigne = () => setLignes((prev) => [...prev, { calibre: '', nbrColis: '', poidsEmb: '0' }])
  const removeLigne = (i: number) => setLignes((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<SupplierReception | null>(null)

  useEffect(() => {
    request<{ items: NamedItem[] }>('/api/suppliers?take=200')
      .then((r) => setSuppliers(r.items ?? []))
      .catch(() => {})
    request<{ items: NamedItem[] }>('/api/products?take=200')
      .then((r) => setProducts(r.items ?? []))
      .catch(() => {})
  }, [])

  const filt = (list: NamedItem[], q: string): SearchSelectOption[] =>
    list
      .filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || (s.nameAr ?? '').includes(q))
      .slice(0, 20)
      .map((s) => ({ id: s.id, label: s.name, sublabel: s.nameAr ?? null }))

  const supplierOptions = (): SearchSelectOption[] => {
    const opts = filt(suppliers, supplierQ)
    const q = supplierQ.trim()
    if (q && !suppliers.some((s) => s.name.toLowerCase() === q.toLowerCase())) {
      return [{ id: '__create__', label: (lang === 'ar' ? 'إنشاء ' : 'Créer ') + q, sublabel: null }, ...opts]
    }
    return opts
  }

  async function selectSupplier(o: SearchSelectOption) {
    if (o.id === '__create__') {
      const name = supplierQ.trim()
      try {
        const s = await createSupplier({ name })
        setSuppliers((prev) => [...prev, { id: s.id, name: s.name }])
        setSupplierId(s.id)
        setSupplierLabel(s.name)
      } catch (e: any) {
        setError(e?.message ?? (ar ? 'فشل إنشاء المورد' : 'Échec de la création du fournisseur'))
      }
      return
    }
    setSupplierId(o.id)
    setSupplierLabel(o.label)
  }

  async function submit() {
    setError(null)
    if (!supplierId || !productId) {
      setError(ar ? 'يرجى ملء الحقول الإلزامية' : 'Veuillez choisir un fournisseur et un produit.')
      return
    }
    if (lignes.some((l) => !l.nbrColis || Number(l.nbrColis) <= 0)) {
      setError(ar ? 'عدد الطرود يجب أن يكون > 0 في كل سطر' : 'Chaque ligne calibre doit avoir un nombre de colis > 0.')
      return
    }
    setSaving(true)
    try {
      const r = await createReception({
        supplierId,
        productId,
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
      setCreated(r)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur lors de la création')
    } finally {
      setSaving(false)
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <PageHeader title={ar ? 'تم إنشاء وصل الاستلام' : 'Bon de réception créé'} />
        <div className="rounded-xl border border-green-300 bg-green-50 p-6 text-green-800">
          <p className="text-lg font-semibold">{created.reference}</p>
          <p>{ar ? 'تم إنشاء الحصة' : 'Lot'} : {created.lot?.lotNumber ?? '—'}</p>
          <p>{ar ? 'تم إنشاء البردية' : 'Bordereau'} : {created.bordereau?.reference ?? '—'}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate('/receptions')}>
            {ar ? 'العودة للقائمة' : 'Retour à la liste'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <PageHeader
        title={ar ? 'وصل استلام جديد' : 'Nouveau bon de réception'}
        actions={
          <Button variant="ghost" onClick={() => navigate('/receptions')}>
            {ar ? 'إلغاء' : 'Annuler'}
          </Button>
        }
      />
      {error && <ErrorBox message={error} />}

      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <Field label={ar ? 'المورد' : 'Fournisseur'}>
          <SearchSelect
            placeholder={ar ? 'ابحث عن مورد…' : 'Rechercher un fournisseur…'}
            value={supplierLabel}
            options={supplierOptions()}
            onQuery={setSupplierQ}
            onSelect={(o) => { void selectSupplier(o) }}
            onClear={() => {
              setSupplierId('')
              setSupplierLabel('')
            }}
          />
        </Field>

        <Field label={ar ? 'المنتج' : 'Produit'}>
          <SearchSelect
            placeholder={ar ? 'ابحث عن منتج…' : 'Rechercher un produit…'}
            value={productLabel}
            options={filt(products, productQ)}
            onQuery={setProductQ}
            onSelect={(o) => {
              setProductId(o.id)
              setProductLabel(o.label)
            }}
            onClear={() => {
              setProductId('')
              setProductLabel('')
            }}
          />
        </Field>

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
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={droitMarche}
              onChange={(e) => setDroitMarche(e.target.value)}
            />
          </Field>
          <Field label={ar ? 'النقل (دج)' : 'Transport (DA)'}>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
            />
          </Field>
        </div>

        <Field label={ar ? 'ملاحظات' : 'Observations'}>
          <textarea
            className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green"
            rows={3}
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
          />
        </Field>

        <Button onClick={submit} disabled={saving}>
          {saving ? '…' : ar ? 'إنشاء وصل الاستلام' : 'Créer le bon de réception'}
        </Button>
      </div>
    </div>
  )
}

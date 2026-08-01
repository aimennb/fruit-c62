import { useEffect, useState } from 'react'
import {
  getBulletins,
  createBulletin,
  validateBulletin,
  openBulletinPdf,
  getProducts,
  getSuppliers,
} from '../api'
import type { Bulletin, Product, Supplier } from '../types'
import {
  Card,
  PageHeader,
  Spinner,
  ErrorBox,
  Button,
  Input,
  Select,
  Field,
  Modal,
  EmptyState,
  Badge,
} from '../components/ui'
import { useLang } from '../i18n'

interface ItemRow {
  productId: string
  nbrColis: string
  poidsBrut: string
  tare: string
  prixUnitaire: string
}

const EMPTY_ITEM: ItemRow = {
  productId: '',
  nbrColis: '',
  poidsBrut: '',
  tare: '',
  prixUnitaire: '',
}

export default function Bulletins() {
  const { lang, tr } = useLang()
  const [items, setItems] = useState<Bulletin[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [reference, setReference] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [rows, setRows] = useState<ItemRow[]>([{ ...EMPTY_ITEM }])
  const [saving, setSaving] = useState(false)
  const [bilingual, setBilingual] = useState<Bulletin | null>(null)

  async function load() {
    try {
      const [b, p, s] = await Promise.all([getBulletins(), getProducts(), getSuppliers()])
      setItems(b)
      setProducts(p.items)
      setSuppliers(s.items)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function openNew() {
    setReference('')
    setSupplierId('')
    setRows([{ ...EMPTY_ITEM }])
    setShowForm(true)
  }

  function updateRow(i: number, patch: Partial<ItemRow>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createBulletin({
        reference,
        supplierId,
        items: rows.map((r) => ({ ...r })),
      })
      setShowForm(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function validate(b: Bulletin) {
    setError('')
    try {
      await validateBulletin(b.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function pdf(b: Bulletin) {
    try {
      void openBulletinPdf(b.id, 'a4')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (loading) return <Spinner label={tr('loading')} />

  return (
    <div className="space-y-5">
      <PageHeader title={tr('bulletins')} actions={<Button onClick={openNew}>{tr('new')} + ' bulletin'</Button>} />
      {error && <ErrorBox message={error} />}

      {items.length === 0 ? (
        <EmptyState message={tr('noData')} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((b) => (
            <Card key={b.id} className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-gray-800">{b.reference}</span>
                <Badge color={b.status === 'validated' ? 'green' : 'amber'}>{b.status}</Badge>
              </div>
              <div className="text-sm text-gray-500">
                {b.date ? new Date(b.date).toLocaleDateString('fr-FR') : '—'} ·{' '}
                {b.items.length} {lang === 'ar' ? 'عنصر' : 'articles'} · {b.totalAmount ?? '0'} DA
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {b.status !== 'validated' && (
                  <Button variant="secondary" onClick={() => validate(b)}>{tr('validate')}</Button>
                )}
                <Button variant="ghost" onClick={() => pdf(b)}>{tr('pdf')}</Button>
                <Button variant="ghost" onClick={() => setBilingual(b)}>FR/AR</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        title={tr('new') + ' bulletin'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>{tr('cancel')}</Button>
            <Button form="bulletin-form" type="submit" disabled={saving}>{tr('create')}</Button>
          </>
        }
      >
        <form id="bulletin-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={tr('reference')}>
              <Input value={reference} required onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Field label={tr('supplier')}>
              <Select value={supplierId} required onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-gray-700">{lang === 'ar' ? 'العناصر' : 'Lignes'}</div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-6 gap-2 items-end border border-gray-100 rounded-xl p-3">
                <div className="sm:col-span-2">
                  <span className="text-xs text-gray-500">{lang === 'ar' ? 'المنتج' : 'Produit'}</span>
                  <Select value={r.productId} required onChange={(e) => updateRow(i, { productId: e.target.value })} className="mt-1">
                    <option value="">—</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </div>
                <div><span className="text-xs text-gray-500">{lang === 'ar' ? 'عدد العبوات' : 'Nbr colis'}</span><Input className="mt-1" value={r.nbrColis} onChange={(e) => updateRow(i, { nbrColis: e.target.value })} /></div>
                <div><span className="text-xs text-gray-500">{lang === 'ar' ? 'الوزن الإجمالي' : 'Poids brut'}</span><Input className="mt-1" value={r.poidsBrut} onChange={(e) => updateRow(i, { poidsBrut: e.target.value })} /></div>
                <div><span className="text-xs text-gray-500">{lang === 'ar' ? 'الطرح' : 'Tare'}</span><Input className="mt-1" value={r.tare} onChange={(e) => updateRow(i, { tare: e.target.value })} /></div>
                <div className="flex gap-2">
                  <div className="flex-1"><span className="text-xs text-gray-500">{lang === 'ar' ? 'السعر' : 'Prix unit.'}</span><Input className="mt-1" value={r.prixUnitaire} onChange={(e) => updateRow(i, { prixUnitaire: e.target.value })} /></div>
                  {rows.length > 1 && (
                    <Button type="button" variant="ghost" className="text-red-600" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}>×</Button>
                  )}
                </div>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setRows((rs) => [...rs, { ...EMPTY_ITEM }])}>
              + {tr('addItem')}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!bilingual} title={`FR / AR — ${bilingual?.reference ?? ''}`} onClose={() => setBilingual(null)}>
        {bilingual && (
          <div className="space-y-4">
            <div dir="ltr" className="rounded-xl bg-gray-50 p-4 text-sm">
              <div className="font-bold mb-2">Procès-verbal d'achat / محضر شراء</div>
              <div>Réf: {bilingual.reference} · Date: {bilingual.date ? new Date(bilingual.date).toLocaleDateString('fr-FR') : '—'}</div>
              <table className="w-full mt-3 text-xs">
                <thead><tr><th className="text-start">Produit</th><th>Colis</th><th>Brut</th><th>Tare</th><th>P.U.</th></tr></thead>
                <tbody>
                  {bilingual.items.map((it, i) => (
                    <tr key={i} className="border-t border-gray-200">
                      <td>{it.productName}</td><td>{it.nbrColis}</td><td>{it.poidsBrut}</td><td>{it.tare}</td><td>{it.prixUnitaire}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 font-semibold">Total: {bilingual.totalAmount ?? '0'} DA</div>
            </div>
            <div dir="rtl" className="rounded-xl bg-gray-50 p-4 text-sm text-right">
              <div className="font-bold mb-2">محضر شراء / Procès-verbal d'achat</div>
              <div>المرجع: {bilingual.reference} · التاريخ: {bilingual.date ? new Date(bilingual.date).toLocaleDateString('fr-FR') : '—'}</div>
              <table className="w-full mt-3 text-xs">
                <thead><tr><th className="text-end">المنتج</th><th>العبوات</th><th>الوزن</th><th>الطرح</th><th>السعر</th></tr></thead>
                <tbody>
                  {bilingual.items.map((it, i) => (
                    <tr key={i} className="border-t border-gray-200">
                      <td>{it.productName}</td><td>{it.nbrColis}</td><td>{it.poidsBrut}</td><td>{it.tare}</td><td>{it.prixUnitaire}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 font-semibold">الإجمالي: {bilingual.totalAmount ?? '0'} DA</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

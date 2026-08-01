import { useEffect, useState } from 'react'
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getSuppliers,
  getProductCategories,
  getUnits,
} from '../api'
import type { Product, Supplier, ProductCategory, Unit } from '../types'
import {
  PageHeader,
  Spinner,
  ErrorBox,
  Button,
  Input,
  Select,
  Field,
  Modal,
  EmptyState,
  Table,
  Badge,
} from '../components/ui'
import { useLang } from '../i18n'

const EMPTY = {
  name: '',
  nameAr: '',
  categoryId: '',
  variety: '',
  origin: '',
  quality: '',
  calibre: '',
  alertThreshold: '',
}

// Backend lists may return either {items,total} or a bare array.
function asItems<T>(res: { items: T[]; total: number } | T[]): T[] {
  return Array.isArray(res) ? res : res.items
}

export default function Products() {
  const { lang, tr } = useLang()
  const [items, setItems] = useState<Product[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState({ ...EMPTY })
  const [supplierIds, setSupplierIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const { items } = await getProducts()
      setItems(items)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // Load selects lists. Each is independent — a failure on one (e.g. 501 not
  // implemented) must not block the others. Fall back to deriving categories/
  // units from the embedded objects on existing products when the dedicated
  // endpoints aren't available.
  async function loadLists() {
    const results = await Promise.allSettled([
      getSuppliers(),
      getProductCategories(),
      getUnits(),
    ])
    if (results[0].status === 'fulfilled') setSuppliers(results[0].value.items)
    if (results[1].status === 'fulfilled') {
      setCategories(asItems(results[1].value))
    }
    if (results[2].status === 'fulfilled') {
      setUnits(asItems(results[2].value))
    }
  }

  useEffect(() => {
    void load()
    void loadLists()
  }, [])

  // Fallback: derive category/unit options from products if endpoints failed.
  useEffect(() => {
    if (categories.length === 0 && items.length) {
      const map = new Map<string, ProductCategory>()
      items.forEach((p) => {
        if (p.category?.id) map.set(p.category.id, { id: p.category.id, name: p.category.name })
      })
      if (map.size) setCategories([...map.values()])
    }
    if (units.length === 0 && items.length) {
      const map = new Map<string, Unit>()
      items.forEach((p) => {
        if (p.unit?.id) map.set(p.unit.id, { id: p.unit.id, name: p.unit.name })
      })
      if (map.size) setUnits([...map.values()])
    }
  }, [items, categories.length, units.length])

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY })
    setSupplierIds([])
    setShowForm(true)
  }

  function openEdit(p: Product) {
    setEditing(p)
    setForm({
      name: p.name ?? '',
      nameAr: p.nameAr ?? '',
      categoryId: p.categoryId ?? p.category?.id ?? '',
      variety: p.variety ?? '',
      origin: p.origin ?? '',
      quality: p.quality ?? '',
      calibre: p.calibre ?? '',
      alertThreshold: p.alertThreshold ?? '',
    })
    setSupplierIds(p.suppliers?.map((s) => s.id) ?? [])
    setShowForm(true)
  }

  function toggleSupplier(id: string) {
    setSupplierIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    )
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    // Only send non-empty ids; strip empty strings so backend gets valid refs.
    const payload: Partial<Product> = {
      ...form,
      categoryId: form.categoryId || null,
      supplierIds,
    }
    try {
      if (editing) {
        await updateProduct(editing.id, payload)
      } else {
        await createProduct(payload)
      }
      setShowForm(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(p: Product) {
    if (!confirm(`Supprimer ${p.name} ?`)) return
    setError('')
    try {
      await deleteProduct(p.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const filtered = items.filter(
    (p) =>
      p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.nameAr?.toLowerCase().includes(search.toLowerCase()),
  )

  if (loading) return <Spinner label={tr('loading')} />

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('products')}
        actions={<Button onClick={openNew}>{tr('new')}</Button>}
      />
      {error && <ErrorBox message={error} />}

      <Input
        placeholder={tr('search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-md"
      />

      {filtered.length === 0 ? (
        <EmptyState message={tr('noData')} />
      ) : (
        <Table
          headers={[
            lang === 'ar' ? 'الاسم' : 'Nom FR',
            lang === 'ar' ? 'الاسم ع' : 'Nom AR',
            lang === 'ar' ? 'الصنف' : 'Catégorie',
            lang === 'ar' ? 'الكمية' : 'Quantité',
            lang === 'ar' ? 'الموردون' : 'Fournisseur(s)',
            lang === 'ar' ? 'المنشأ' : 'Origine',
            lang === 'ar' ? 'السعر' : 'Prix',
            '',
          ]}
        >
          {filtered.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-3">{p.name}</td>
              <td className="px-4 py-3 text-gray-500">{p.nameAr ?? '—'}</td>
              <td className="px-4 py-3">{p.category?.name ?? '—'}</td>
              <td className="px-4 py-3">
                {p.quantity == null || Number(p.quantity) === 0 ? (
                  Number(p.quantity) === 0 ? (
                    <Badge color="red">0</Badge>
                  ) : (
                    '—'
                  )
                ) : (
                  p.quantity
                )}
              </td>
              <td className="px-4 py-3">
                {p.suppliers && p.suppliers.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {p.suppliers.map((s) => (
                      <Badge key={s.id} color={s.isPreferred ? 'green' : 'gray'}>
                        {s.name}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  '—'
                )}
              </td>
              <td className="px-4 py-3">{p.origin ?? '—'}</td>
              <td className="px-4 py-3">{p.suggestedSalePrice ?? '—'}</td>
              <td className="px-4 py-3 text-end whitespace-nowrap">
                <Button variant="ghost" onClick={() => openEdit(p)}>
                  {tr('edit')}
                </Button>
                <Button variant="ghost" className="text-red-600" onClick={() => remove(p)}>
                  {tr('delete')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal
        open={showForm}
        title={editing ? tr('edit') : tr('new')}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              {tr('cancel')}
            </Button>
            <Button form="product-form" type="submit" disabled={saving}>
              {tr('save')}
            </Button>
          </>
        }
      >
        <form id="product-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={lang === 'ar' ? 'الاسم (FR)' : 'Nom FR'}>
              <Input value={form.name} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={lang === 'ar' ? 'الاسم (AR)' : 'Nom AR'}>
              <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} />
            </Field>
            <Field label={lang === 'ar' ? 'الصنف' : 'Catégorie'}>
              <Select
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              >
                <option value="">{lang === 'ar' ? '— اختر —' : '— Choisir —'}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {lang === 'ar' && c.nameAr ? c.nameAr : c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={lang === 'ar' ? 'الصنف الفرعي' : 'Variété'}>
              <Input value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} />
            </Field>
            <Field label={lang === 'ar' ? 'المنشأ' : 'Origine'}>
              <Input value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} />
            </Field>
            <Field label={lang === 'ar' ? 'الجودة' : 'Qualité'}>
              <Input value={form.quality} onChange={(e) => setForm({ ...form, quality: e.target.value })} />
            </Field>
            <Field label={lang === 'ar' ? 'المعيار' : 'Calibre'}>
              <Input value={form.calibre} onChange={(e) => setForm({ ...form, calibre: e.target.value })} />
            </Field>
            <Field label={lang === 'ar' ? 'عتبة التنبيه' : 'Seuil alerte'}>
              <Input type="number" value={form.alertThreshold} onChange={(e) => setForm({ ...form, alertThreshold: e.target.value })} />
            </Field>
          </div>

          <div>
            <div className="mb-1 text-sm font-medium text-gray-700">
              {lang === 'ar' ? 'الموردون' : 'Fournisseur(s)'}
            </div>
            {suppliers.length === 0 ? (
              <p className="text-sm text-gray-400">
                {lang === 'ar' ? 'لا يوجد موردون' : 'Aucun fournisseur'}
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 p-3">
                {suppliers.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300"
                      checked={supplierIds.includes(s.id)}
                      onChange={() => toggleSupplier(s.id)}
                    />
                    <span>{lang === 'ar' && s.nameAr ? s.nameAr : s.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </form>
      </Modal>
    </div>
  )
}

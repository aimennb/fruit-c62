import { useEffect, useState } from 'react'
import {
  getSales,
  getCustomers,
  getProducts,
  createSale,
  confirmSale,
} from '../api'
import type { Sale, Customer, Product, SaleItem } from '../types'
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
  Badge,
  Table,
} from '../components/ui'
import { useLang } from '../i18n'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

const newLine = (): SaleItem => ({ productId: '', quantity: 1, unitPrice: 0 })

function statusColor(status: string): string {
  switch (status) {
    case 'CONFIRMED':
      return 'green'
    case 'CANCELLED':
      return 'red'
    default:
      return 'gray'
  }
}

export default function Sales() {
  const { lang, tr } = useLang()
  const [items, setItems] = useState<Sale[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ customerId: '' })
  const [lines, setLines] = useState<SaleItem[]>([newLine()])

  async function load() {
    try {
      const [sales, c, p] = await Promise.all([getSales(), getCustomers(), getProducts()])
      setItems(Array.isArray(sales) ? sales : sales.items)
      setCustomers(c.items)
      setProducts(p.items)
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
    setForm({ customerId: '' })
    setLines([newLine()])
    setError('')
    setShowForm(true)
  }

  function setLine(i: number, patch: Partial<SaleItem>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  function addLine() {
    setLines((prev) => [...prev, newLine()])
  }

  function removeLine(i: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  const total = lines.reduce(
    (sum, l) => sum + Number(l.quantity || 0) * Number(l.unitPrice || 0),
    0,
  )

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const payloadLines = lines
        .filter((l) => l.productId)
        .map((l) => ({
          productId: l.productId as string,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
        }))
      if (payloadLines.length === 0) throw new Error('Ajoutez au moins un article')
      const created = await createSale({
        customerId: form.customerId || null,
        items: payloadLines,
      })
      // Confirm immediately (stock FIFO decrement)
      await confirmSale(created.id)
      setShowForm(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function confirm(id: string) {
    setError('')
    try {
      await confirmSale(id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (loading) return <Spinner label={tr('loading')} />

  const custName = (s: Sale) => s.customer?.name ?? '—'

  return (
    <div className="space-y-5">
      <PageHeader title={tr('sales')} actions={<Button onClick={openNew}>{tr('new')}</Button>} />
      {error && <ErrorBox message={error} />}

      {items.length === 0 ? (
        <EmptyState message={tr('noData')} />
      ) : (
        <Table
          headers={[
            lang === 'ar' ? 'المرجع' : 'Réf',
            lang === 'ar' ? 'العميل' : 'Client',
            lang === 'ar' ? 'المورد' : 'Fournisseur',
            lang === 'ar' ? 'الحالة' : 'Statut',
            lang === 'ar' ? 'الإجمالي' : 'Total',
            '',
          ]}
        >
          {items.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-3 font-medium">{s.reference}</td>
              <td className="px-4 py-3">{custName(s)}</td>
              <td className="px-4 py-3">{s.supplier?.name ?? '—'}</td>
              <td className="px-4 py-3">
                <Badge color={statusColor(s.status)}>{s.status}</Badge>
              </td>
              <td className="px-4 py-3 font-semibold text-fruite-green">{da(s.total)}</td>
              <td className="px-4 py-3 text-end whitespace-nowrap">
                {s.status !== 'CONFIRMED' && s.status !== 'CANCELLED' && (
                  <Button variant="ghost" onClick={() => confirm(s.id)}>
                    {lang === 'ar' ? 'تأكيد' : 'Confirmer'}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal
        open={showForm}
        title={tr('new')}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>{tr('cancel')}</Button>
            <Button form="sale-form" type="submit" disabled={saving}>
              {lang === 'ar' ? 'تأكيد البيع' : 'Confirmer la vente'}
            </Button>
          </>
        }
      >
        <form id="sale-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <Field label={lang === 'ar' ? 'العميل' : 'Client'}>
            <Select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>

          <div className="space-y-3">
            <div className="text-sm font-medium text-gray-700">{lang === 'ar' ? 'الأ articles' : 'Articles'}</div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-12 sm:col-span-5">
                  <Select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
                    <option value="">—</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.unit?.symbol ? `(${p.unit.symbol})` : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="col-span-4 sm:col-span-2">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={l.quantity}
                    onChange={(e) => setLine(i, { quantity: e.target.value })}
                  />
                </div>
                <div className="col-span-6 sm:col-span-3">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={l.unitPrice}
                    onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                  />
                </div>
                <div className="col-span-2 sm:col-span-2 flex items-center justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => removeLine(i)}
                    disabled={lines.length === 1}
                  >
                    ×
                  </Button>
                </div>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={addLine}>
              {tr('addItem')}
            </Button>
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-sm font-medium text-gray-600">{tr('total')}</span>
            <span className="text-xl font-bold text-fruite-green">{da(total)}</span>
          </div>
        </form>
      </Modal>
    </div>
  )
}

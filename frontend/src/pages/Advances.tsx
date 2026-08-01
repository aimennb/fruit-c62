import { useEffect, useState } from 'react'
import {
  getAdvances,
  createAdvance,
  allocateAdvance,
  getSuppliers,
  getSupplierStatement,
  getBulletins,
} from '../api'
import type { SupplierAdvance, Supplier, Bulletin, Statement } from '../types'
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

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

export default function Advances() {
  const { lang, tr } = useLang()
  const [items, setItems] = useState<SupplierAdvance[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [bulletins, setBulletins] = useState<Bulletin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ supplierId: '', amount: '', paymentMethod: '', reference: '' })
  const [saving, setSaving] = useState(false)
  const [allocateId, setAllocateId] = useState<string | null>(null)
  const [allocForm, setAllocForm] = useState({ purchaseBulletinId: '', amount: '' })
  const [allocSaving, setAllocSaving] = useState(false)
  const [stmt, setStmt] = useState<Statement | null>(null)

  async function load() {
    try {
      const [a, s, b] = await Promise.all([getAdvances(), getSuppliers(), getBulletins()])
      setItems(a)
      setSuppliers(s.items)
      setBulletins(b)
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
    setForm({ supplierId: '', amount: '', paymentMethod: '', reference: '' })
    setShowForm(true)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createAdvance({ ...form })
      setShowForm(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function openAllocate(a: SupplierAdvance) {
    setAllocateId(a.id)
    setAllocForm({ purchaseBulletinId: '', amount: a.amount })
  }

  async function doAllocate(e: React.FormEvent) {
    e.preventDefault()
    if (!allocateId) return
    setAllocSaving(true)
    setError('')
    try {
      await allocateAdvance(allocateId, {
        purchaseBulletinId: allocForm.purchaseBulletinId,
        amount: allocForm.amount,
      })
      setAllocateId(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAllocSaving(false)
    }
  }

  async function statement(supplierId: string) {
    setError('')
    try {
      const st = await getSupplierStatement(supplierId)
      setStmt(st)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (loading) return <Spinner label={tr('loading')} />

  const supName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? id

  return (
    <div className="space-y-5">
      <PageHeader title={tr('advances')} actions={<Button onClick={openNew}>{tr('new')}</Button>} />
      {error && <ErrorBox message={error} />}

      {items.length === 0 ? (
        <EmptyState message={tr('noData')} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((a) => (
            <Card key={a.id} className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-gray-800">{supName(a.supplierId)}</span>
                <Badge color={a.status === 'allocated' ? 'blue' : 'green'}>{a.status ?? 'actif'}</Badge>
              </div>
              <div className="text-sm text-gray-500">{tr('reference')}: {a.reference ?? '—'}</div>
              <div className="text-2xl font-bold text-fruite-green">{da(a.amount)}</div>
              <div className="text-xs text-gray-400">
                {lang === 'ar' ? 'مخصص' : 'Alloué'}: {da(a.allocatedAmount)} ·{' '}
                {lang === 'ar' ? 'الطريقة' : 'Mode'}: {a.paymentMethod ?? '—'}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="secondary" onClick={() => openAllocate(a)}>{tr('allocate')}</Button>
                <Button variant="ghost" onClick={() => statement(a.supplierId)}>{tr('statement')}</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        title={tr('new')}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>{tr('cancel')}</Button>
            <Button form="advance-form" type="submit" disabled={saving}>{tr('save')}</Button>
          </>
        }
      >
        <form id="advance-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <Field label={tr('supplier')}>
            <Select value={form.supplierId} required onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">—</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('amount')}>
            <Input type="number" step="0.01" value={form.amount} required onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label={tr('paymentMethod')}>
            <Input value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })} />
          </Field>
          <Field label={tr('reference')}>
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={!!allocateId}
        title={tr('allocate')}
        onClose={() => setAllocateId(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAllocateId(null)}>{tr('cancel')}</Button>
            <Button form="alloc-form" type="submit" disabled={allocSaving}>{tr('allocate')}</Button>
          </>
        }
      >
        <form id="alloc-form" onSubmit={doAllocate} className="space-y-4 max-w-2xl">
          <Field label={lang === 'ar' ? 'محضر الشراء' : 'Bulletin d\'achat'}>
            <Select value={allocForm.purchaseBulletinId} required onChange={(e) => setAllocForm({ ...allocForm, purchaseBulletinId: e.target.value })}>
              <option value="">—</option>
              {bulletins.map((b) => (
                <option key={b.id} value={b.id}>{b.reference}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('amount')}>
            <Input type="number" step="0.01" value={allocForm.amount} required onChange={(e) => setAllocForm({ ...allocForm, amount: e.target.value })} />
          </Field>
        </form>
      </Modal>

      <Modal open={!!stmt} title={tr('statement')} onClose={() => setStmt(null)}>
        {stmt && (
          <div className="space-y-3">
            <div className="font-bold text-lg">{stmt.supplier.name}</div>
            <div className="text-sm text-gray-500">{lang === 'ar' ? 'الرصيد' : 'Solde'}: <span className="font-semibold text-fruite-green">{stmt.balance}</span></div>
            <div className="text-xs text-gray-400">{lang === 'ar' ? 'السلف' : 'Avances'}: {stmt.advances.length} · {lang === 'ar' ? 'مشتريات حديثة' : 'Achats récents'}: {stmt.recentPurchases.length}</div>
            {stmt.entries.length === 0 && <EmptyState message={tr('noData')} />}
          </div>
        )}
      </Modal>
    </div>
  )
}

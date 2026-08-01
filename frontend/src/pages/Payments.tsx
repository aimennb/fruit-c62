import { useEffect, useState } from 'react'
import {
  getPayments,
  getCustomers,
  getInvoices,
  createPayment,
  getCustomerStatement,
} from '../api'
import type { Payment, Customer, Invoice, CustomerStatement } from '../types'
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
  Table,
} from '../components/ui'
import { useLang } from '../i18n'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

const METHODS: { value: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'; fr: string; ar: string }[] = [
  { value: 'CASH', fr: 'Espèces', ar: 'نقد' },
  { value: 'BANK_TRANSFER', fr: 'Banque', ar: 'بنك' },
  { value: 'CHECK', fr: 'Chèque', ar: 'شيك' },
  { value: 'CARD', fr: 'Carte', ar: 'بطاقة' },
]

function fmtDate(d?: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR')
}

export default function Payments() {
  const { lang, tr } = useLang()
  const [items, setItems] = useState<Payment[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ customerId: '', invoiceId: '', amount: '', method: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD' })

  // Customer statement panel
  const [stmtCustomerId, setStmtCustomerId] = useState('')
  const [stmt, setStmt] = useState<CustomerStatement | null>(null)
  const [stmtLoading, setStmtLoading] = useState(false)

  async function load() {
    try {
      const [p, c, i] = await Promise.all([getPayments(), getCustomers(), getInvoices()])
      setItems(Array.isArray(p) ? p : p.items)
      setCustomers(c.items)
      setInvoices(Array.isArray(i) ? i : i.items)
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
    setForm({ customerId: '', invoiceId: '', amount: '', method: 'CASH' })
    setError('')
    setShowForm(true)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (!form.customerId) throw new Error('Choisissez un client')
      if (!form.amount || Number(form.amount) <= 0) throw new Error('Montant invalide')
      await createPayment({
        customerId: form.customerId,
        invoiceId: form.invoiceId || null,
        amount: Number(form.amount),
        method: form.method,
      })
      setShowForm(false)
      await load()
      if (stmtCustomerId === form.customerId) await loadStatement(form.customerId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function loadStatement(id: string) {
    if (!id) {
      setStmt(null)
      return
    }
    setStmtLoading(true)
    setError('')
    try {
      const s = await getCustomerStatement(id)
      setStmt(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStmtLoading(false)
    }
  }

  if (loading) return <Spinner label={tr('loading')} />

  const custName = (p: Payment) => p.customer?.name ?? '—'
  const invRef = (p: Payment) => p.invoice?.reference ?? '—'

  return (
    <div className="space-y-5">
      <PageHeader title={tr('payments')} actions={<Button onClick={openNew}>{tr('new')}</Button>} />
      {error && <ErrorBox message={error} />}

      {/* Customer statement panel */}
      <Card className="p-5 space-y-4">
        <Field label={lang === 'ar' ? 'Relevé client' : 'Relevé client'}>
          <div className="flex flex-col sm:flex-row gap-2">
            <Select value={stmtCustomerId} onChange={(e) => setStmtCustomerId(e.target.value)}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            <Button variant="secondary" onClick={() => loadStatement(stmtCustomerId)} disabled={!stmtCustomerId}>
              {lang === 'ar' ? 'Afficher' : 'Afficher'}
            </Button>
          </div>
        </Field>

        {stmtLoading && <Spinner label={tr('loading')} />}

        {stmt && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-lg font-bold text-gray-800">{stmt.name}</span>
              <Badge color="gray">
                {lang === 'ar' ? 'الرصيد' : 'Solde'}: {da(stmt.balance)}
              </Badge>
              <Badge color="gray">
                {lang === 'ar' ? 'الحد الائتماني' : 'Limite'}: {da(stmt.creditLimit)}
              </Badge>
              {stmt.exceeded && (
                <Badge color="red">{lang === 'ar' ? 'Dépassement !' : 'Dépassement !'}</Badge>
              )}
            </div>

            {stmt.sales.length === 0 && stmt.invoices.length === 0 && stmt.payments.length === 0 ? (
              <EmptyState message={tr('noData')} />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div>
                  <div className="text-sm font-semibold text-gray-600 mb-2">{lang === 'ar' ? 'المبيعات' : 'Ventes'}</div>
                  {stmt.sales.length === 0 ? (
                    <div className="text-xs text-gray-400">—</div>
                  ) : (
                    stmt.sales.map((s) => (
                      <div key={s.id} className="text-xs py-1 border-b border-gray-50 flex justify-between">
                        <span>{s.reference}</span>
                        <span className="text-fruite-green">{da(s.total)}</span>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-600 mb-2">{lang === 'ar' ? 'الفواتير' : 'Factures'}</div>
                  {stmt.invoices.length === 0 ? (
                    <div className="text-xs text-gray-400">—</div>
                  ) : (
                    stmt.invoices.map((inv) => (
                      <div key={inv.id} className="text-xs py-1 border-b border-gray-50 flex justify-between">
                        <span>{inv.reference}</span>
                        <span className="text-fruite-green">{da(inv.total)}</span>
                      </div>
                    ))
                  )}
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-600 mb-2">{lang === 'ar' ? 'الدفعات' : 'Paiements'}</div>
                  {stmt.payments.length === 0 ? (
                    <div className="text-xs text-gray-400">—</div>
                  ) : (
                    stmt.payments.map((p) => (
                      <div key={p.id} className="text-xs py-1 border-b border-gray-50 flex justify-between">
                        <span>{p.reference}</span>
                        <span className="text-green-600">{da(p.amount)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {items.length === 0 ? (
        <EmptyState message={tr('noData')} />
      ) : (
        <Table
          headers={[
            lang === 'ar' ? 'المرجع' : 'Réf',
            lang === 'ar' ? 'العميل' : 'Client',
            lang === 'ar' ? 'الفاتورة' : 'Facture',
            lang === 'ar' ? 'المبلغ' : 'Montant',
            lang === 'ar' ? 'الطريقة' : 'Mode',
            lang === 'ar' ? 'التاريخ' : 'Date',
          ]}
        >
          {items.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-3 font-medium">{p.reference}</td>
              <td className="px-4 py-3">{custName(p)}</td>
              <td className="px-4 py-3">{invRef(p)}</td>
              <td className="px-4 py-3 font-semibold text-green-600">{da(p.amount)}</td>
              <td className="px-4 py-3">
                <Badge color="blue">{METHODS.find((m) => m.value === p.method)?.fr ?? p.method}</Badge>
              </td>
              <td className="px-4 py-3">{fmtDate(p.paymentDate)}</td>
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
            <Button form="payment-form" type="submit" disabled={saving}>{tr('save')}</Button>
          </>
        }
      >
        <form id="payment-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <Field label={lang === 'ar' ? 'العميل' : 'Client'}>
            <Select value={form.customerId} required onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={lang === 'ar' ? 'الفاتورة (اختياري)' : 'Facture (optionnel)'}>
            <Select value={form.invoiceId} onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}>
              <option value="">—</option>
              {invoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.reference} — {inv.customer?.name ?? '—'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr('amount')}>
            <Input type="number" min="0" step="0.01" value={form.amount} required onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label={tr('paymentMethod')}>
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD' })}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>{lang === 'ar' ? m.ar : m.fr}</option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>
    </div>
  )
}

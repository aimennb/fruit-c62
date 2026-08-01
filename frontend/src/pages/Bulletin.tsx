import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getSales,
  getInvoices,
  getCustomers,
  createInvoice,
  openInvoicePdf,
  updateInvoice,
  deleteInvoice,
  deleteSale,
  createPayment,
  getInvoice,
  getCustomerStatement,
} from '../api'
import type { Sale, Invoice, Customer, CustomerStatement } from '../types'
import {
  PageHeader,
  Spinner,
  ErrorBox,
  Button,
  Input,
  Field,
  Modal,
  EmptyState,
  Badge,
  Table,
} from '../components/ui'
import { useLang } from '../i18n'
import { useBarcodeSearch } from '../hooks/useBarcodeSearch'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

const METHODS: { value: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'; fr: string; ar: string }[] = [
  { value: 'CASH', fr: 'Espèces', ar: 'نقد' },
  { value: 'BANK_TRANSFER', fr: 'Banque', ar: 'بنك' },
  { value: 'CHECK', fr: 'Chèque', ar: 'شيك' },
  { value: 'CARD', fr: 'Carte', ar: 'بطاقة' },
]

const methodFr = (m?: string) => METHODS.find((x) => x.value === m)?.fr ?? m ?? '—'

// Map an invoice status to a bulletin badge.
function invoiceStatusBadge(
  status: string,
  remaining?: string | number,
  total?: string | number,
): { label: string; color: string } {
  if (
    status === 'SENT' &&
    Number(total ?? 0) > 0 &&
    Number(remaining ?? 0) === Number(total ?? 0)
  ) {
    return { label: 'Crédit', color: 'blue' }
  }
  switch (status) {
    case 'PAID':
      return { label: 'Payé', color: 'green' }
    case 'SENT':
      return { label: 'Émis', color: 'blue' }
    case 'CANCELLED':
      return { label: 'Annulé', color: 'red' }
    case 'PARTIALLY_PAID':
      return { label: 'Avance', color: 'amber' }
    default:
      return { label: 'Brouillon', color: 'gray' }
  }
}

function fmtDate(d?: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR')
}

export default function Bulletin() {
  const { lang, tr } = useLang()
  const navigate = useNavigate()
  const [sales, setSales] = useState<Sale[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Search & status filter (client-side)
  const [search, setSearch] = useState('')
  // Scanner code-barres USB : EAN13 saisi dans la barre → redirection facture.
  useBarcodeSearch(search, { onNotFound: (m) => setError(m) })
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PAID' | 'UNPAID'>('ALL')

  const filtered = sales.filter((s) => {
    const inv = invoiceBySaleId(s.id)
    const q = search.trim().toLowerCase()
    const matchSearch =
      !q ||
      s.reference.toLowerCase().includes(q) ||
      (s.customer?.name ?? '').toLowerCase().includes(q) ||
      invoiceStatusBadge(inv ? inv.status : 'DRAFT').label.toLowerCase().includes(q)
    const isPaid = inv?.status === 'PAID' || Number(inv?.remaining ?? 0) === 0
    const matchStatus =
      statusFilter === 'ALL' ||
      (statusFilter === 'PAID' && isPaid) ||
      (statusFilter === 'UNPAID' && !isPaid)
    return matchSearch && matchStatus
  })

  // Encash modal
  const [encashTarget, setEncashTarget] = useState<Invoice | null>(null)
  const [encashSaving, setEncashSaving] = useState(false)
  const [encashForm, setEncashForm] = useState({
    amount: '',
    method: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD',
  })

  // History modal
  const [historyTarget, setHistoryTarget] = useState<Customer | null>(null)
  const [stmt, setStmt] = useState<CustomerStatement | null>(null)
  const [stmtLoading, setStmtLoading] = useState(false)

  // Detail modal (facture)
  const [detailTarget, setDetailTarget] = useState<Invoice | null>(null)
  const [detailEdit, setDetailEdit] = useState(false)
  const [detailSaving, setDetailSaving] = useState(false)

  async function load() {
    try {
      const [s, inv, c] = await Promise.all([getSales(), getInvoices(), getCustomers()])
      setSales(Array.isArray(s) ? s : s.items)
      setInvoices(Array.isArray(inv) ? inv : inv.items)
      setCustomers(c.items)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function invoiceBySaleId(saleId?: string | null) {
    if (!saleId) return null
    return invoices.find((inv) => inv.saleId === saleId) ?? null
  }

  // ---- Encash ----
  function openEncash(inv: Invoice) {
    setEncashTarget(inv)
    setEncashForm({ amount: String(Number(inv.total || 0)), method: 'CASH' })
    setError('')
  }

  async function saveEncash(e: React.FormEvent) {
    e.preventDefault()
    if (!encashTarget) return
    setEncashSaving(true)
    setError('')
    try {
      if (!encashForm.amount || Number(encashForm.amount) <= 0)
        throw new Error('Montant invalide')
      await createPayment({
        customerId: encashTarget.customerId || (encashTarget.customer?.id ?? ''),
        invoiceId: encashTarget.id,
        amount: Number(encashForm.amount),
        method: encashForm.method,
      })
      setEncashTarget(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setEncashSaving(false)
    }
  }

  // ---- History ----
  function openHistory(customer?: Customer | null) {
    const c = customer ?? null
    setHistoryTarget(c)
    setStmt(null)
    setError('')
    if (c) void loadStatement(c.id)
  }

  async function loadStatement(id: string) {
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

  // Ensure a sale has a linked invoice (create one on the fly if missing).
  // Returns the invoice id, or null on failure.
  async function ensureInvoice(sale: Sale): Promise<string | null> {
    const existing = invoiceBySaleId(sale.id)
    if (existing) return existing.id
    try {
      const created = await createInvoice({ saleId: sale.id })
      await load()
      const fresh = invoiceBySaleId(sale.id)
      return fresh?.id ?? created.id ?? null
    } catch (e) {
      setError((e as Error).message)
      return null
    }
  }

  // BUG 4: Imprimer — guarantees a linked invoice before opening the PDF.
  async function handlePrint(sale: Sale) {
    const invId = await ensureInvoice(sale)
    if (!invId) return
    try {
      void openInvoicePdf(invId)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // BUG 4: Encaisser — guarantees a linked invoice, then opens the encash modal.
  async function handleEncash(sale: Sale) {
    const invId = await ensureInvoice(sale)
    if (!invId) return
    try {
      const inv = await getInvoice(invId)
      openEncash(inv)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Détail facture : garantit une facture liée, puis ouvre /factures/:id
  // dans un nouvel onglet (comportement identique à BordereauDetail.tsx).
  async function handleDetail(sale: Sale) {
    const invId = await ensureInvoice(sale)
    if (!invId) {
      setError('Impossible de créer ou d’ouvrir la facture liée à cette vente.')
      return
    }
    window.open('/factures/' + invId, '_blank')
  }

  async function saveDetail(e: React.FormEvent) {
    e.preventDefault()
    if (!detailTarget) return
    setDetailSaving(true)
    setError('')
    try {
      const items = (detailTarget.items ?? []).map((it) => ({
        description: (it as any).description ?? '',
        productId: (it as any).productId ?? undefined,
        quantity: Number((it as any).quantity ?? 0),
        unitPrice: Number((it as any).unitPrice ?? 0),
        packingUnitPrice: (it as any).packingUnitPrice !== undefined ? Number((it as any).packingUnitPrice) : undefined,
        colis: (it as any).colis !== undefined ? Number((it as any).colis) : undefined,
        grossWeight: (it as any).grossWeight !== undefined ? Number((it as any).grossWeight) : undefined,
        tare: (it as any).tare !== undefined ? Number((it as any).tare) : undefined,
        netWeight: (it as any).netWeight !== undefined ? Number((it as any).netWeight) : undefined,
      }))
      await updateInvoice(detailTarget.id, {
        items,
        packingReturned: (detailTarget as any).packingReturned ?? undefined,
      })
      // Recharge la facture complète (items, paiements, client) après la mise à jour.
      const fresh = await getInvoice(detailTarget.id)
      setDetailTarget(fresh)
      setDetailEdit(false)
      await load()
    } catch (e) {
      console.error('saveDetail error', e)
      setError((e as Error).message)
    } finally {
      setDetailSaving(false)
    }
  }

  async function removeDetail() {
    if (!detailTarget) return
    if (!confirm(lang === 'ar' ? 'Supprimer ce bulletin (vente + facture) ?' : 'Supprimer ce bulletin (vente + facture) ?')) return
    setDetailSaving(true)
    try {
      await deleteInvoice(detailTarget.id)
      if (detailTarget.saleId) await deleteSale(detailTarget.saleId)
      setDetailTarget(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDetailSaving(false)
    }
  }

  if (loading) return <Spinner label={tr('loading')} />

  return (
    <div className="space-y-5">
      <PageHeader
        title={lang === 'ar' ? 'المبيعات' : 'Ventes'}
        subtitle={lang === 'ar' ? 'بيع + فاتورة + دفع' : 'Vente + facture + paiement'}
        actions={<Button onClick={() => navigate('/ventes/nouveau')}>{tr('new')}</Button>}
      />
      {error && <ErrorBox message={error} />}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={lang === 'ar' ? 'بحث (المرجع، العميل، الحالة)...' : 'Recherche (réf, client, statut)...'}
          className="w-full sm:w-72 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-fruite-green focus:ring-1 focus:ring-fruite-green"
        />
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { key: 'ALL', fr: 'Toutes', ar: 'الكل' },
              { key: 'PAID', fr: 'Payées', ar: 'مدفوعة' },
              { key: 'UNPAID', fr: 'Non payées', ar: 'غير مدفوعة' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setStatusFilter(opt.key)}
              className={
                'rounded-lg px-3 py-2 text-sm font-medium transition ' +
                (statusFilter === opt.key
                  ? 'bg-fruite-green text-white'
                  : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50')
              }
            >
              {lang === 'ar' ? opt.ar : opt.fr}
            </button>
          ))}
        </div>
      </div>

      {sales.length === 0 ? (
        <EmptyState message={tr('noData')} />
      ) : filtered.length === 0 ? (
        <EmptyState message={lang === 'ar' ? 'لا توجد نتائج' : 'Aucun résultat'} />
      ) : (
        <Table
          headers={[
            lang === 'ar' ? 'المرجع' : 'Réf',
            lang === 'ar' ? 'العميل' : 'Client',
            lang === 'ar' ? 'المنتج' : 'Produit',
            lang === 'ar' ? 'التاريخ' : 'Date',
            lang === 'ar' ? 'الإجمالي' : 'Total',
            lang === 'ar' ? 'الدفعة' : 'Avance',
            lang === 'ar' ? 'الباقي' : 'Restant',
            lang === 'ar' ? 'الحالة' : 'Statut',
            '',
          ]}
        >
          {filtered.map((s) => {
            const inv = invoiceBySaleId(s.id)
            const badge = invoiceStatusBadge(inv ? inv.status : 'DRAFT', inv?.remaining, inv?.total)
            return (
              <tr key={s.id}>
                <td className="px-4 py-3 font-medium">{s.reference}</td>
                <td className="px-4 py-3">{s.customer?.name ?? '—'}</td>
                <td className="px-4 py-3">{((s as any).items ?? []).map((i:any)=>i.product?.name).filter(Boolean).join(', ') || '—'}</td>
                <td className="px-4 py-3">{fmtDate((s as any).date)}</td>
                <td className="px-4 py-3 font-semibold text-fruite-green">{da(s.total)}</td>
                <td className="px-4 py-3 text-blue-600">{da(inv?.paidAmount ?? 0)}</td>
                <td className="px-4 py-3 text-red-600">{da(inv?.remaining ?? s.total)}</td>
                <td className="px-4 py-3">
                  <Badge color={badge.color}>{badge.label}</Badge>
                </td>
                <td className="px-4 py-3 text-end whitespace-nowrap space-x-1">
                  <Button variant="ghost" onClick={() => handlePrint(s)}>
                    {lang === 'ar' ? 'طباعة' : 'Imprimer'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleEncash(s)}
                    disabled={
                      !inv ||
                      inv.status === 'PAID' ||
                      inv.status === 'CANCELLED' ||
                      Number(inv.remaining ?? 0) === 0
                    }
                  >
                    {lang === 'ar' ? 'تحصيل' : 'Encaisser'}
                  </Button>
                  <Button variant="ghost" onClick={() => handleDetail(s)}>
                    {lang === 'ar' ? 'تفاصيل' : 'Détail'}
                  </Button>
                </td>
              </tr>
            )
          })}
        </Table>
      )}


      {/* Encash modal */}
      <Modal
        open={!!encashTarget}
        title={lang === 'ar' ? 'تحصيل' : 'Encaisser'}
        onClose={() => setEncashTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEncashTarget(null)}>
              {tr('cancel')}
            </Button>
            <Button form="encash-form" type="submit" disabled={encashSaving}>
              {tr('save')}
            </Button>
          </>
        }
      >
        {encashTarget && (
          <form id="encash-form" onSubmit={saveEncash} className="space-y-4 max-w-2xl">
            <div className="text-sm text-gray-500">
              {encashTarget.reference} — {encashTarget.customer?.name ?? '—'} ·{' '}
              {da(encashTarget.total)}
            </div>
            <Field label={tr('amount')}>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={encashForm.amount}
                required
                onChange={(e) => setEncashForm({ ...encashForm, amount: e.target.value })}
              />
            </Field>
            <Field label={tr('paymentMethod')}>
              <select
                className="min-h-[44px] w-full rounded-xl border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green"
                value={encashForm.method}
                onChange={(e) =>
                  setEncashForm({
                    ...encashForm,
                    method: e.target.value as 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD',
                  })
                }
              >
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {lang === 'ar' ? m.ar : m.fr}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-gray-400">
              {lang === 'ar'
                ? 'إذا كان المبلغ أقل من الإجمالي، يصبح الوضع "Avance" والباقي يتبع في رصيد العميل.'
                : 'Si le montant < total, le statut passe en Avance et le reste suit dans le solde client.'}
            </p>
          </form>
        )}
      </Modal>

      {/* History modal */}
      <Modal
        open={!!historyTarget}
        title={lang === 'ar' ? 'سجل العميل' : 'Historique client'}
        onClose={() => setHistoryTarget(null)}
      >
        {historyTarget && (
          <div className="space-y-4">
            <Field label={lang === 'ar' ? 'العميل' : 'Client'}>
              <select
                className="min-h-[44px] w-full rounded-xl border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green"
                value={historyTarget.id}
                onChange={(e) => {
                  const c = customers.find((x) => x.id === e.target.value) ?? null
                  openHistory(c)
                }}
              >
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            {stmtLoading && <Spinner label={tr('loading')} />}

            {stmt && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-lg font-bold text-gray-800">{stmt.name}</span>
                  <Badge color={stmt.exceeded ? 'red' : 'gray'}>
                    {lang === 'ar' ? 'الرصيد' : 'Solde'}: {da(stmt.balance)}
                  </Badge>
                  <Badge color="gray">
                    {lang === 'ar' ? 'الحد الائتماني' : 'Limite'}: {da(stmt.creditLimit)}
                  </Badge>
                  {stmt.exceeded && (
                    <Badge color="red">
                      {lang === 'ar' ? 'Dépassement !' : 'Dépassement !'}
                    </Badge>
                  )}
                </div>

                {stmt.sales.length === 0 &&
                stmt.invoices.length === 0 &&
                stmt.payments.length === 0 ? (
                  <EmptyState message={tr('noData')} />
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div>
                      <div className="text-sm font-semibold text-gray-600 mb-2">
                        {lang === 'ar' ? 'المبيعات' : 'Ventes'}
                      </div>
                      {stmt.sales.length === 0 ? (
                        <div className="text-xs text-gray-400">—</div>
                      ) : (
                        stmt.sales.map((s) => (
                          <div
                            key={s.id}
                            className="text-xs py-1 border-b border-gray-50 flex justify-between"
                          >
                            <span>{s.reference}</span>
                            <span className="text-fruite-green">{da(s.total)}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-600 mb-2">
                        {lang === 'ar' ? 'الفواتير' : 'Factures'}
                      </div>
                      {stmt.invoices.length === 0 ? (
                        <div className="text-xs text-gray-400">—</div>
                      ) : (
                        stmt.invoices.map((inv) => (
                          <div
                            key={inv.id}
                            className="text-xs py-1 border-b border-gray-50 flex justify-between"
                          >
                            <span>{inv.reference}</span>
                            <span className="text-fruite-green">{da(inv.total)}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-600 mb-2">
                        {lang === 'ar' ? 'الدفعات' : 'Paiements'}
                      </div>
                      {stmt.payments.length === 0 ? (
                        <div className="text-xs text-gray-400">—</div>
                      ) : (
                        stmt.payments.map((p) => (
                          <div
                            key={p.id}
                            className="text-xs py-1 border-b border-gray-50 flex justify-between"
                          >
                            <span>
                              {p.reference} ({methodFr(p.method)})
                            </span>
                            <span className="text-green-600">{da(p.amount)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Detail facture modal */}
      <Modal
        open={!!detailTarget}
        size="xl"
        title={lang === 'ar' ? 'تفاصيل الفاتورة' : 'Détail de la facture'}
        onClose={() => { setDetailTarget(null); setDetailEdit(false) }}
        footer={
          detailEdit ? null : (
            <>
              <Button variant="ghost" className="text-red-600" onClick={removeDetail} disabled={detailSaving}>
                {lang === 'ar' ? 'حذف' : 'Supprimer'}
              </Button>
              <Button variant="primary" onClick={() => setDetailEdit(true)}>
                {lang === 'ar' ? 'تعديل' : 'Modifier'}
              </Button>
            </>
          )
        }
      >
        {detailTarget && (
          <div className="space-y-4">
            {error && <ErrorBox message={error} />}
            <div className="flex flex-wrap gap-3 text-sm">
              <span><b>{detailTarget.reference}</b></span>
              <Badge color={invoiceStatusBadge(detailTarget.status).color}>
                {invoiceStatusBadge(detailTarget.status).label}
              </Badge>
              <span className="text-gray-500">{fmtDate(detailTarget.issueDate)}</span>
              <span className="text-gray-500">{detailTarget.customer?.name ?? ''}</span>
              <span className="font-semibold text-fruite-green">{da(detailTarget.total)}</span>
            </div>
            {detailEdit ? (
              <form id="detail-form" onSubmit={saveDetail} className="space-y-2">
                {(detailTarget.items ?? []).map((it: any, i: number) => (
                  <div key={i} className="grid grid-cols-7 gap-2 items-end">
                    <Field label={lang === 'ar' ? 'المنتج' : 'Produit'}>
                      <Input
                        value={it.description ?? ''}
                        onChange={(e) => {
                          const items = [...(detailTarget.items ?? [])]
                          ;(items[i] as any).description = e.target.value
                          setDetailTarget({ ...detailTarget, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'العبوات' : 'Colis'}>
                      <Input
                        type="number"
                        value={it.colis ?? ''}
                        onChange={(e) => {
                          const items = [...(detailTarget.items ?? [])]
                          const b = Number((items[i] as any).grossWeight || 0)
                          const t = Number((items[i] as any).tare || 0)
                          ;(items[i] as any).colis = e.target.value
                          ;(items[i] as any).netWeight = String(b - t * Number(e.target.value || 0))
                          ;(items[i] as any).quantity = String(b - t * Number(e.target.value || 0))
                          setDetailTarget({ ...detailTarget, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'الوزن' : 'Brut (kg)'}>
                      <Input
                        type="number"
                        value={it.grossWeight ?? ''}
                        onChange={(e) => {
                          const items = [...(detailTarget.items ?? [])]
                          ;(items[i] as any).grossWeight = e.target.value
                          const b = Number(e.target.value || 0)
                          const t = Number((items[i] as any).tare || 0)
                          const c = Number((items[i] as any).colis || 0)
                          // Net = Brut − (Tare × Colis)
                          ;(items[i] as any).netWeight = String(b - t * c)
                          ;(items[i] as any).quantity = String(b - t * c)
                          setDetailTarget({ ...detailTarget, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'الطرح' : 'Tare (kg)'}>
                      <Input
                        type="number"
                        value={it.tare ?? ''}
                        onChange={(e) => {
                          const items = [...(detailTarget.items ?? [])]
                          ;(items[i] as any).tare = e.target.value
                          const b = Number((items[i] as any).grossWeight || 0)
                          const t = Number(e.target.value || 0)
                          const c = Number((items[i] as any).colis || 0)
                          // Net = Brut − (Tare × Colis)
                          ;(items[i] as any).netWeight = String(b - t * c)
                          ;(items[i] as any).quantity = String(b - t * c)
                          setDetailTarget({ ...detailTarget, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'الصافي' : 'Net (kg)'}>
                      <Input
                        type="number"
                        value={it.netWeight ?? ''}
                        disabled
                        readOnly
                      />
                    </Field>
                    <Field label="PU (DA)">
                      <Input
                        type="number"
                        value={it.unitPrice ?? ''}
                        onChange={(e) => {
                          const items = [...(detailTarget.items ?? [])]
                          ;(items[i] as any).unitPrice = e.target.value
                          setDetailTarget({ ...detailTarget, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'سعر التغليف / صندوق' : 'Prix emb. / colis'}>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={it.packingUnitPrice ?? ''}
                        onChange={(e) => {
                          const items = [...(detailTarget.items ?? [])]
                          ;(items[i] as any).packingUnitPrice = e.target.value
                          setDetailTarget({ ...detailTarget, items })
                        }}
                      />
                    </Field>
                  </div>
                ))}
                <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
                  <Button type="button" variant="secondary" onClick={() => setDetailEdit(false)}>
                    {lang === 'ar' ? 'إلغاء' : 'Annuler'}
                  </Button>
                  <Button type="submit" variant="primary" disabled={detailSaving}>
                    {lang === 'ar' ? 'حفظ' : 'Enregistrer'}
                  </Button>
                </div>
              </form>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-start py-1">{lang === 'ar' ? 'المنتج' : 'Produit'}</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'العبوات' : 'Colis'}</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'الوزن' : 'Brut (kg)'}</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'الطرح' : 'Tare (kg)'}</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'الصافي' : 'Net (kg)'}</th>
                    <th className="text-end py-1">PU</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'سعر التغليف' : 'PU Emb.'}</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'التغليف' : 'Emballage'}</th>
                    <th className="text-end py-1">{lang === 'ar' ? 'الإجمالي' : 'Total'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(detailTarget.items ?? []).map((it: any, i: number) => (
                    <tr key={i}>
                      <td className="py-1">{it.description}</td>
                      <td className="py-1 text-end">{it.colis} colis</td>
                      <td className="py-1 text-end">{it.grossWeight} kg</td>
                      <td className="py-1 text-end">{it.tare} kg</td>
                      <td className="py-1 text-end">{it.netWeight} kg</td>
                      <td className="py-1 text-end">{da(it.unitPrice)}</td>
                      <td className="py-1 text-end">{da(it.packingUnitPrice)}</td>
                      <td className="py-1 text-end text-gray-600">{da(Number(it.packingUnitPrice || 0) * Number(it.colis || 0))}</td>
                      <td className="py-1 text-end font-semibold text-fruite-green">{da(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8} className="py-1 text-gray-600">{lang === 'ar' ? 'مجموع التغليف' : 'Total emballage'}</td>
                    <td className="py-1 text-end text-gray-700">{da(detailTarget.packingTotal ?? 0)}</td>
                  </tr>
                  <tr className="border-t-2 border-gray-200">
                    <td colSpan={8} className="py-2 font-semibold">{lang === 'ar' ? 'الإجمالي' : 'Total'}</td>
                    <td className="py-2 text-end font-bold text-fruite-green">{da(detailTarget.total)}</td>
                  </tr>
                  <tr>
                    <td colSpan={8} className="py-1 font-semibold text-blue-600">{lang === 'ar' ? 'الدفعة' : 'Avance'}</td>
                    <td className="py-1 text-end font-semibold text-blue-600">{da(detailTarget.paidAmount ?? 0)}</td>
                  </tr>
                  <tr>
                    <td colSpan={8} className="py-1 font-semibold text-red-600">{lang === 'ar' ? 'الباقي' : 'Restant'}</td>
                    <td className="py-1 text-end font-semibold text-red-600">{da(detailTarget.remaining ?? detailTarget.total)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

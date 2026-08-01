import { useEffect, useState } from 'react'
import {
  getCustomers,
  getCustomerSearch,
  getCustomerStatement,
  getInvoice,
  openInvoicePdf,
  createPayment,
  createCustomer,
  type CustomerSearchItem,
} from '../api'
import type { Customer, Invoice, CustomerStatement } from '../types'
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
  SearchSelect,
  type SearchSelectOption,
} from '../components/ui'
import { useLang } from '../i18n'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

type View = 'list' | 'invoices' | 'detail'

const METHODS: { value: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'; fr: string; ar: string }[] = [
  { value: 'CASH', fr: 'Espèces', ar: 'نقد' },
  { value: 'BANK_TRANSFER', fr: 'Banque', ar: 'بنك' },
  { value: 'CHECK', fr: 'Chèque', ar: 'شيك' },
  { value: 'CARD', fr: 'Carte', ar: 'بطاقة' },
]

function invoiceStatusBadge(status: string): { label: string; color: string } {
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

export default function Clients() {
  const { lang, tr } = useLang()
  const [all, setAll] = useState<Customer[]>([])
  const [list, setList] = useState<Customer[]>([])
  const [searchResults, setSearchResults] = useState<CustomerSearchItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchReq, setSearchReq] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [view, setView] = useState<View>('list')
  const [active, setActive] = useState<Customer | null>(null)
  const [stmt, setStmt] = useState<CustomerStatement | null>(null)
  const [stmtLoading, setStmtLoading] = useState(false)
  const [detail, setDetail] = useState<Invoice | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Encash modal
  const [encashTarget, setEncashTarget] = useState<Invoice | null>(null)
  const [encashSaving, setEncashSaving] = useState(false)
  const [encashForm, setEncashForm] = useState({
    amount: '',
    method: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD',
  })

  // Nouveau client modal
  const [newOpen, setNewOpen] = useState(false)
  const [newSaving, setNewSaving] = useState(false)
  const [newForm, setNewForm] = useState({ name: '', phone: '', wilaya: '', creditLimit: '' })
  const [invSearch, setInvSearch] = useState('')
  const [invFilter, setInvFilter] = useState<'ALL' | 'PAID' | 'UNPAID'>('ALL')

  async function saveNewCustomer(e: React.FormEvent) {
    e.preventDefault()
    setNewSaving(true)
    setError('')
    try {
      if (!newForm.name.trim())
        throw new Error(lang === 'ar' ? 'الاسم مطلوب' : 'Le nom est requis')
      await createCustomer({
        name: newForm.name.trim(),
        phone: newForm.phone.trim() || undefined,
        wilaya: newForm.wilaya.trim() || undefined,
        creditLimit: newForm.creditLimit === '' ? undefined : newForm.creditLimit,
      })
      setNewOpen(false)
      setNewForm({ name: '', phone: '', wilaya: '', creditLimit: '' })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setNewSaving(false)
    }
  }

  async function load() {
    try {
      const { items } = await getCustomers()
      setAll(items)
      setList(items)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function query(q: string) {
    const my = searchReq + 1
    setSearchReq(my)
    setSearchLoading(true)
    try {
      const r = await getCustomerSearch(q)
      if (searchReq === my) setSearchResults(r.items)
    } catch {
      /* ignore */
    } finally {
      if (searchReq === my) setSearchLoading(false)
    }
  }

  function selectCustomer(c: Customer) {
    setActive(c)
    setDetail(null)
    setView('invoices')
    setError('')
    void loadStatement(c.id)
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

  async function openDetail(inv: Invoice) {
    setDetailLoading(true)
    setError('')
    try {
      const full = await getInvoice(inv.id)
      setDetail(full)
      setView('detail')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDetailLoading(false)
    }
  }

  function print(inv: Invoice | null) {
    if (!inv) return
    try {
      void openInvoicePdf(inv.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

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
        customerId: active?.id ?? encashTarget.customerId ?? (encashTarget.customer?.id ?? ''),
        invoiceId: encashTarget.id,
        amount: Number(encashForm.amount),
        method: encashForm.method,
      })
      setEncashTarget(null)
      if (active) await loadStatement(active.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setEncashSaving(false)
    }
  }

  const searchOptions: SearchSelectOption[] = searchResults.map((c) => ({
    id: c.id,
    label: c.name,
    sublabel: c.nameAr ?? null,
  }))

  if (loading) return <Spinner label={tr('loading')} />

  const filteredInvoices = (stmt?.invoices ?? []).filter((inv) => {
    const q = invSearch.trim().toLowerCase()
    const matchSearch =
      !q ||
      (inv.reference ?? '').toLowerCase().includes(q) ||
      (invoiceStatusBadge(inv.status).label ?? '').toLowerCase().includes(q)
    const isPaid = inv.status === 'PAID' || Number((inv as any).remaining ?? 0) === 0
    const matchStatus =
      invFilter === 'ALL' ||
      (invFilter === 'PAID' && isPaid) ||
      (invFilter === 'UNPAID' && !isPaid)
    return matchSearch && matchStatus
  })

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('clients')}
        subtitle={lang === 'ar' ? 'زبائن + فواتير' : 'Clients + factures'}
        actions={
          <div className="flex gap-2">
            <Button onClick={() => { setNewOpen(true); setError('') }}>
              {lang === 'ar' ? 'عميل جديد' : 'Nouveau client'}
            </Button>
            {view !== 'list' && (
              <Button variant="secondary" onClick={() => setView('list')}>
                {lang === 'ar' ? 'القائمة' : 'Liste'}
              </Button>
            )}
          </div>
        }
      />
      {error && <ErrorBox message={error} />}

      {view === 'list' && (
        <>
          <SearchSelect
            placeholder={lang === 'ar' ? 'ابحث عن عميل…' : 'Rechercher client…'}
            value=""
            options={searchOptions}
            loading={searchLoading}
            onQuery={query}
            onSelect={(o) => {
              const c = all.find((x) => x.id === o.id) ?? null
              if (c) selectCustomer(c)
            }}
            onClear={() => setList(all)}
          />
          {list.length === 0 ? (
            <EmptyState message={tr('noData')} />
          ) : (
            <Table
              headers={[
                lang === 'ar' ? 'الاسم' : 'Nom',
                lang === 'ar' ? 'الهاتف' : 'Téléphone',
                lang === 'ar' ? 'الولاية' : 'Wilaya',
                lang === 'ar' ? 'الحد الائتماني' : 'Limite crédit',
                lang === 'ar' ? 'الرصيد' : 'Solde',
                '',
              ]}
            >
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 font-medium">
                    <button
                      className="text-start hover:text-fruite-green hover:underline"
                      onClick={() => selectCustomer(c)}
                    >
                      {c.name}
                    </button>
                  </td>
                  <td className="px-4 py-3">{c.phone ?? '—'}</td>
                  <td className="px-4 py-3">{c.wilaya ?? '—'}</td>
                  <td className="px-4 py-3">{c.creditLimit ?? '—'}</td>
                  <td className="px-4 py-3">{c.balance ?? '—'}</td>
                  <td className="px-4 py-3 text-end whitespace-nowrap">
                    <Button variant="ghost" onClick={() => selectCustomer(c)}>
                      {lang === 'ar' ? 'فواتير' : 'Factures'}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}

      {view === 'invoices' && active && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={() => setView('list')}>
              ← {lang === 'ar' ? 'العملاء' : 'Clients'}
            </Button>
            <span className="text-lg font-bold text-gray-800">{active.name}</span>
            {stmt && (
              <>
                <Badge color={stmt.exceeded ? 'red' : 'gray'}>
                  {lang === 'ar' ? 'الرصيد' : 'Solde'}: {da(stmt.balance)}
                </Badge>
                <Badge color="gray">
                  {lang === 'ar' ? 'الحد الائتماني' : 'Limite'}: {da(stmt.creditLimit)}
                </Badge>
              </>
            )}
          </div>

          {stmt && (
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={invSearch}
                onChange={(e) => setInvSearch(e.target.value)}
                placeholder={lang === 'ar' ? 'ابحث عن فاتورة…' : 'Rechercher facture…'}
                className="max-w-xs"
              />
              <Button variant={invFilter === 'ALL' ? 'primary' : 'secondary'} onClick={() => setInvFilter('ALL')}>
                {lang === 'ar' ? 'الكل' : 'Toutes'}
              </Button>
              <Button variant={invFilter === 'PAID' ? 'primary' : 'secondary'} onClick={() => setInvFilter('PAID')}>
                {lang === 'ar' ? 'مدفوعة' : 'Payées'}
              </Button>
              <Button variant={invFilter === 'UNPAID' ? 'primary' : 'secondary'} onClick={() => setInvFilter('UNPAID')}>
                {lang === 'ar' ? 'غير مدفوعة' : 'Non payées'}
              </Button>
            </div>
          )}

          {stmtLoading && <Spinner label={tr('loading')} />}

          {stmt && (filteredInvoices.length === 0 ? (
            <EmptyState message={tr('noData')} />
          ) : (
            <Table
              headers={[
                lang === 'ar' ? 'المرجع' : 'Réf',
                lang === 'ar' ? 'التاريخ' : 'Date',
                lang === 'ar' ? 'الإجمالي' : 'Total',
                lang === 'ar' ? 'الحالة' : 'Statut',
                '',
              ]}
            >
              {filteredInvoices.map((inv) => {
                const badge = invoiceStatusBadge(inv.status)
                return (
                  <tr
                    key={inv.id}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => window.open('/factures/' + inv.id, '_blank')}
                  >
                    <td className="px-4 py-3 font-medium">
                      <span className="hover:text-fruite-green hover:underline">
                        {inv.reference}
                      </span>
                    </td>
                    <td className="px-4 py-3">{fmtDate(inv.issueDate ?? inv.createdAt)}</td>
                    <td className="px-4 py-3 font-semibold text-fruite-green">{da(inv.total)}</td>
                    <td className="px-4 py-3">
                      <Badge color={badge.color}>{badge.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-end whitespace-nowrap">
                      <Button
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDetail(inv)
                        }}
                      >
                        {lang === 'ar' ? 'تفاصيل' : 'Détail'}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </Table>
          ))}
        </div>
      )}

      {view === 'detail' && active && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={() => setView('invoices')}>
              ← {lang === 'ar' ? 'الفواتير' : 'Factures'}
            </Button>
            <span className="text-lg font-bold text-gray-800">{detail?.reference}</span>
            {detail && (
              <Badge color={invoiceStatusBadge(detail.status).color}>
                {invoiceStatusBadge(detail.status).label}
              </Badge>
            )}
          </div>

          {detailLoading && <Spinner label={tr('loading')} />}

          {detail && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs text-gray-500">{lang === 'ar' ? 'العميل' : 'Client'}</div>
                  <div className="font-semibold">{active.name}</div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs text-gray-500">{lang === 'ar' ? 'التاريخ' : 'Date'}</div>
                  <div className="font-semibold">{fmtDate(detail.issueDate ?? detail.createdAt)}</div>
                </div>
                <div className="rounded-xl bg-gray-50 p-3">
                  <div className="text-xs text-gray-500">{lang === 'ar' ? 'الإجمالي' : 'Total'}</div>
                  <div className="font-semibold text-fruite-green">{da(detail.total)}</div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-4 py-3 text-start font-semibold">
                        {lang === 'ar' ? 'المنتج' : 'Article'}
                      </th>
                      <th className="px-4 py-3 font-semibold">{lang === 'ar' ? 'العبوات' : 'Colis'}</th>
                      <th className="px-4 py-3 font-semibold">{lang === 'ar' ? 'الوزن' : 'Brut'}</th>
                      <th className="px-4 py-3 font-semibold">{lang === 'ar' ? 'الطرح' : 'Tare'}</th>
                      <th className="px-4 py-3 font-semibold">{lang === 'ar' ? 'الصافي' : 'Net'}</th>
                      <th className="px-4 py-3 font-semibold">{lang === 'ar' ? 'السعر' : 'P.U.'}</th>
                      <th className="px-4 py-3 text-end font-semibold">{lang === 'ar' ? 'الإجمالي' : 'Total'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(detail.items ?? []).map((it, i) => (
                      <tr key={i}>
                        <td className="px-4 py-3">{it.name ?? it.product?.name ?? '—'}</td>
                        <td className="px-4 py-3">{it.colis ?? '—'}</td>
                        <td className="px-4 py-3">{it.grossWeight ?? '—'}</td>
                        <td className="px-4 py-3">{it.tare ?? '—'}</td>
                        <td className="px-4 py-3">{it.netWeight ?? '—'}</td>
                        <td className="px-4 py-3">{da(it.unitPrice)}</td>
                        <td className="px-4 py-3 text-end font-semibold">{da(it.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-200">
                      <td className="px-4 py-3 font-bold text-gray-700" colSpan={6}>
                        {lang === 'ar' ? 'الإجمالي العام' : 'Prix total de tout'}
                      </td>
                      <td className="px-4 py-3 text-end font-bold text-fruite-green">{da(detail.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => print(detail)}>{lang === 'ar' ? 'طباعة' : 'Imprimer'}</Button>
                <Button
                  variant="secondary"
                  onClick={() => openEncash(detail)}
                  disabled={detail.status === 'PAID' || detail.status === 'CANCELLED'}
                >
                  {lang === 'ar' ? 'تحصيل' : 'Encaisser'}
                </Button>
              </div>
            </div>
          )}
        </div>
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
              {encashTarget.reference} — {active?.name ?? encashTarget.customer?.name ?? '—'} ·{' '}
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
                ? 'إذا كان المبلغ أقل من الإجمالي، يصبح الوضع "Avance".'
                : 'Si le montant < total, le statut passe en Avance et le reste suit dans le solde client.'}
            </p>
          </form>
        )}
      </Modal>

      {/* Nouveau client modal */}
      <Modal
        open={newOpen}
        title={lang === 'ar' ? 'عميل جديد' : 'Nouveau client'}
        onClose={() => setNewOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>
              {tr('cancel')}
            </Button>
            <Button form="new-customer-form" type="submit" disabled={newSaving}>
              {tr('save')}
            </Button>
          </>
        }
      >
        <form id="new-customer-form" onSubmit={saveNewCustomer} className="space-y-4 max-w-2xl">
          <Field label={lang === 'ar' ? 'الاسم *' : 'Nom *'}>
            <Input
              value={newForm.name}
              required
              onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
            />
          </Field>
          <Field label={lang === 'ar' ? 'الهاتف' : 'Téléphone'}>
            <Input
              value={newForm.phone}
              onChange={(e) => setNewForm({ ...newForm, phone: e.target.value })}
            />
          </Field>
          <Field label={lang === 'ar' ? 'الولاية' : 'Wilaya'}>
            <Input
              value={newForm.wilaya}
              onChange={(e) => setNewForm({ ...newForm, wilaya: e.target.value })}
            />
          </Field>
          <Field label={lang === 'ar' ? 'الحد الائتماني (اختياري)' : 'Limite crédit (optionnel)'}>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={newForm.creditLimit}
              onChange={(e) => setNewForm({ ...newForm, creditLimit: e.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </div>
  )
}

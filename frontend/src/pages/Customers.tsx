import { useEffect, useState } from 'react'
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from '../api'
import type { Customer } from '../types'
import {
  PageHeader,
  Spinner,
  ErrorBox,
  Button,
  Input,
  Textarea,
  Field,
  Modal,
  EmptyState,
  Table,
} from '../components/ui'
import { useLang } from '../i18n'

const EMPTY = {
  name: '',
  contactName: '',
  phone: '',
  address: '',
  commune: '',
  wilaya: '',
  nif: '',
  creditLimit: '',
  paymentTerms: '',
  notes: '',
}

export default function Customers() {
  const { lang, tr } = useLang()
  const [items, setItems] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState({ ...EMPTY })
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const { items } = await getCustomers()
      setItems(items)
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
    setEditing(null)
    setForm({ ...EMPTY })
    setShowForm(true)
  }

  function openEdit(c: Customer) {
    setEditing(c)
    setForm({
      name: c.name ?? '',
      contactName: c.contactName ?? '',
      phone: c.phone ?? '',
      address: c.address ?? '',
      commune: c.commune ?? '',
      wilaya: c.wilaya ?? '',
      nif: c.nif ?? '',
      creditLimit: c.creditLimit ?? '',
      paymentTerms: c.paymentTerms ?? '',
      notes: c.notes ?? '',
    })
    setShowForm(true)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (editing) await updateCustomer(editing.id, { ...form })
      else await createCustomer({ ...form })
      setShowForm(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(c: Customer) {
    if (!confirm(`Supprimer ${c.name} ?`)) return
    setError('')
    try {
      await deleteCustomer(c.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const filtered = items.filter((c) =>
    c.name?.toLowerCase().includes(search.toLowerCase()),
  )

  if (loading) return <Spinner label={tr('loading')} />

  return (
    <div className="space-y-5">
      <PageHeader title={tr('clients')} actions={<Button onClick={openNew}>{tr('new')}</Button>} />
      {error && <ErrorBox message={error} />}
      <Input placeholder={tr('search')} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-md" />

      {filtered.length === 0 ? (
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
          {filtered.map((c) => (
            <tr key={c.id}>
              <td className="px-4 py-3 font-medium">{c.name}</td>
              <td className="px-4 py-3">{c.phone ?? '—'}</td>
              <td className="px-4 py-3">{c.wilaya ?? '—'}</td>
              <td className="px-4 py-3">{c.creditLimit ?? '—'}</td>
              <td className="px-4 py-3">{c.balance ?? '—'}</td>
              <td className="px-4 py-3 text-end whitespace-nowrap">
                <Button variant="ghost" onClick={() => openEdit(c)}>{tr('edit')}</Button>
                <Button variant="ghost" className="text-red-600" onClick={() => remove(c)}>{tr('delete')}</Button>
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
            <Button variant="secondary" onClick={() => setShowForm(false)}>{tr('cancel')}</Button>
            <Button form="customer-form" type="submit" disabled={saving}>{tr('save')}</Button>
          </>
        }
      >
        <form id="customer-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={lang === 'ar' ? 'الاسم' : 'Nom'}><Input value={form.name} required onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'جهة الاتصال' : 'Contact'}><Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'الهاتف' : 'Téléphone'}><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'العنوان' : 'Adresse'}><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'البلدية' : 'Commune'}><Input value={form.commune} onChange={(e) => setForm({ ...form, commune: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'الولاية' : 'Wilaya'}><Input value={form.wilaya} onChange={(e) => setForm({ ...form, wilaya: e.target.value })} /></Field>
            <Field label="NIF"><Input value={form.nif} onChange={(e) => setForm({ ...form, nif: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'الحد الائتماني' : 'Limite crédit'}><Input value={form.creditLimit} onChange={(e) => setForm({ ...form, creditLimit: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'شروط الدفع' : 'Conditions paiement'}><Input value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} /></Field>
          </div>
          <Field label={lang === 'ar' ? 'ملاحظات' : 'Notes'}>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </form>
      </Modal>
    </div>
  )
}

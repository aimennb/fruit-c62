import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  getSupplierStatement,
} from '../api'
import type { Supplier, Statement } from '../types'
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
  country: '',
  rc: '',
  nif: '',
  notes: '',
}

export default function Suppliers() {
  const { lang, tr } = useLang()
  const navigate = useNavigate()
  const [items, setItems] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState({ ...EMPTY })
  const [saving, setSaving] = useState(false)
  const [stmt, setStmt] = useState<Statement | null>(null)

  async function load() {
    try {
      const { items } = await getSuppliers()
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

  function openEdit(s: Supplier) {
    setEditing(s)
    setForm({
      name: s.name ?? '',
      contactName: s.contactName ?? '',
      phone: s.phone ?? '',
      address: s.address ?? '',
      commune: s.commune ?? '',
      wilaya: s.wilaya ?? '',
      country: s.country ?? '',
      rc: s.rc ?? '',
      nif: s.nif ?? '',
      notes: s.notes ?? '',
    })
    setShowForm(true)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      if (editing) await updateSupplier(editing.id, { ...form })
      else await createSupplier({ ...form })
      setShowForm(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(s: Supplier) {
    if (!confirm(`Supprimer ${s.name} ?`)) return
    setError('')
    try {
      await deleteSupplier(s.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function statement(s: Supplier) {
    setError('')
    try {
      const st = await getSupplierStatement(s.id)
      setStmt(st)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const filtered = items.filter((s) =>
    s.name?.toLowerCase().includes(search.toLowerCase()),
  )

  if (loading) return <Spinner label={tr('loading')} />

  return (
    <div className="space-y-5">
      <PageHeader title={tr('suppliers')} actions={<Button onClick={openNew}>{tr('new')}</Button>} />
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
            lang === 'ar' ? 'RC/NIF' : 'RC/NIF',
            lang === 'ar' ? 'الرصيد' : 'Solde',
            '',
          ]}
        >
          {filtered.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-3 font-medium">
                <button
                  type="button"
                  className="text-fruite-green hover:underline font-medium text-start"
                  onClick={() => navigate('/fournisseurs/detail?id=' + s.id)}
                  title={lang === 'ar' ? 'عرض التفاصيل' : 'Voir le détail'}
                >
                  {s.name}
                </button>
              </td>
              <td className="px-4 py-3">{s.phone ?? '—'}</td>
              <td className="px-4 py-3">{s.wilaya ?? '—'}</td>
              <td className="px-4 py-3 text-gray-500">{s.rc ?? s.nif ?? '—'}</td>
              <td className="px-4 py-3">{s.balance ?? '—'}</td>
              <td className="px-4 py-3 text-end whitespace-nowrap">
                <Button variant="ghost" onClick={() => statement(s)}>{tr('statement')}</Button>
                <Button variant="ghost" onClick={() => openEdit(s)}>{tr('edit')}</Button>
                <Button variant="ghost" className="text-red-600" onClick={() => remove(s)}>{tr('delete')}</Button>
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
            <Button form="supplier-form" type="submit" disabled={saving}>{tr('save')}</Button>
          </>
        }
      >
        <form id="supplier-form" onSubmit={save} className="space-y-4 max-w-2xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={lang === 'ar' ? 'الاسم' : 'Nom'}><Input value={form.name} required onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'جهة الاتصال' : 'Contact'}><Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'الهاتف' : 'Téléphone'}><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'العنوان' : 'Adresse'}><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'البلدية' : 'Commune'}><Input value={form.commune} onChange={(e) => setForm({ ...form, commune: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'الولاية' : 'Wilaya'}><Input value={form.wilaya} onChange={(e) => setForm({ ...form, wilaya: e.target.value })} /></Field>
            <Field label={lang === 'ar' ? 'البلد' : 'Pays'}><Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></Field>
            <Field label="RC"><Input value={form.rc} onChange={(e) => setForm({ ...form, rc: e.target.value })} /></Field>
            <Field label="NIF"><Input value={form.nif} onChange={(e) => setForm({ ...form, nif: e.target.value })} /></Field>
          </div>
          <Field label={lang === 'ar' ? 'ملاحظات' : 'Notes'}>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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

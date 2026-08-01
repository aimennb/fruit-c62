// Approvisionnement de caisse : formulaire de saisie + liste du jour.
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createSupply, getSupplies, type CashSupply } from '../api'
import {
  PageHeader, Button, Input, Select, Textarea, Field, Form, Table, Spinner, ErrorBox, EmptyState,
} from '../components/ui'
import { fmtDA, aujourdhui, heureCourante, MODES_PAIEMENT } from './caisse-utils'

export default function CashSupplyPage() {
  const navigate = useNavigate()
  const [date, setDate] = useState(aujourdhui())
  const [heure, setHeure] = useState(heureCourante())
  const [amount, setAmount] = useState('')
  const [motif, setMotif] = useState('')
  const [mode, setMode] = useState('CASH')
  const [observation, setObservation] = useState('')
  const [items, setItems] = useState<CashSupply[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getSupplies(date)
      setItems(r.items ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!motif.trim()) return setError('Le motif est obligatoire.')
    if (!(Number(amount) > 0)) return setError('Le montant doit être supérieur à 0.')
    setSaving(true)
    try {
      await createSupply({
        date, heure, amount: Number(amount), motif: motif.trim(), mode,
        observation: observation || null,
      })
      setAmount(''); setMotif(''); setObservation('')
      await load()
    } catch (err: any) {
      setError(err?.message ?? "Erreur lors de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Approvisionnement de caisse"
        subtitle="Entrée d'argent dans la caisse (hors ventes)"
        actions={<Button variant="secondary" onClick={() => navigate('/caisse')}>← Retour caisse</Button>}
      />

      <Form onSubmit={onSubmit} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 max-w-2xl mb-8">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Heure">
            <Input type="time" value={heure} onChange={(e) => setHeure(e.target.value)} />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Montant (DA) *">
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES_PAIEMENT.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Motif *">
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ex : apport du gérant" />
        </Field>
        <Field label="Observation">
          <Textarea rows={2} value={observation} onChange={(e) => setObservation(e.target.value)} />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? 'Enregistrement…' : "Enregistrer l'approvisionnement"}
          </Button>
        </div>
      </Form>

      <h2 className="text-lg font-bold text-gray-800 mb-2">Approvisionnements du jour</h2>
      {loading && <Spinner label="Chargement…" />}
      {!loading && items.length === 0 && <EmptyState message="Aucun approvisionnement pour cette date." />}
      {!loading && items.length > 0 && (
        <Table headers={['Référence', 'Heure', 'Motif', 'Mode', 'Montant']}>
          {items.map((x) => (
            <tr key={x.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-600">{x.reference}</td>
              <td className="px-4 py-3 text-gray-500">{x.heure ?? '—'}</td>
              <td className="px-4 py-3 font-medium text-gray-800">{x.motif}</td>
              <td className="px-4 py-3 text-gray-600">
                {MODES_PAIEMENT.find((m) => m.value === x.mode)?.label ?? x.mode}
              </td>
              <td className="px-4 py-3 text-green-600 font-semibold">{fmtDA(x.amount)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

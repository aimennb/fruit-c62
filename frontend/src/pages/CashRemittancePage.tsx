// Remise d'espèces : formulaire de saisie + liste du jour.
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createRemittance, getRemittances, type CashRemittance } from '../api'
import {
  PageHeader, Button, Input, Textarea, Field, Form, Table, Spinner, ErrorBox, EmptyState,
} from '../components/ui'
import { fmtDA, aujourdhui, heureCourante } from './caisse-utils'

export default function CashRemittancePage() {
  const navigate = useNavigate()
  const [date, setDate] = useState(aujourdhui())
  const [heure, setHeure] = useState(heureCourante())
  const [amount, setAmount] = useState('')
  const [beneficiary, setBeneficiary] = useState('')
  const [motif, setMotif] = useState('')
  const [observation, setObservation] = useState('')
  const [items, setItems] = useState<CashRemittance[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getRemittances(date)
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
      await createRemittance({
        date, heure, amount: Number(amount), motif: motif.trim(),
        beneficiary: beneficiary || null, observation: observation || null,
      })
      setAmount(''); setMotif(''); setBeneficiary(''); setObservation('')
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
        title="Remise d'espèces"
        subtitle="Sortie d'argent de la caisse (banque / direction)"
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
          <Field label="Bénéficiaire">
            <Input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="Ex : banque BNA" />
          </Field>
        </div>
        <Field label="Motif *">
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ex : versement bancaire" />
        </Field>
        <Field label="Observation">
          <Textarea rows={2} value={observation} onChange={(e) => setObservation(e.target.value)} />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer la remise'}
          </Button>
        </div>
      </Form>

      <h2 className="text-lg font-bold text-gray-800 mb-2">Remises du jour</h2>
      {loading && <Spinner label="Chargement…" />}
      {!loading && items.length === 0 && <EmptyState message="Aucune remise pour cette date." />}
      {!loading && items.length > 0 && (
        <Table headers={['Référence', 'Heure', 'Motif', 'Bénéficiaire', 'Montant']}>
          {items.map((x) => (
            <tr key={x.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-600">{x.reference}</td>
              <td className="px-4 py-3 text-gray-500">{x.heure ?? '—'}</td>
              <td className="px-4 py-3 font-medium text-gray-800">{x.motif}</td>
              <td className="px-4 py-3 text-gray-600">{x.beneficiary ?? '—'}</td>
              <td className="px-4 py-3 text-red-600 font-semibold">{fmtDA(x.amount)}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

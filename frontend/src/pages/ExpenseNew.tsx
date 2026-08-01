// Formulaire de création d'une dépense de caisse.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createExpense } from '../api'
import { PageHeader, Button, Input, Select, Textarea, Field, Form, ErrorBox } from '../components/ui'
import { aujourdhui, heureCourante, CATEGORIES_DEPENSE, MODES_PAIEMENT } from './caisse-utils'

export default function ExpenseNew() {
  const navigate = useNavigate()
  const [date, setDate] = useState(aujourdhui())
  const [heure, setHeure] = useState(heureCourante())
  const [motif, setMotif] = useState('')
  const [category, setCategory] = useState(CATEGORIES_DEPENSE[0])
  const [amount, setAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('CASH')
  const [observation, setObservation] = useState('')
  const [justificatif, setJustificatif] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!motif.trim()) return setError('Le motif est obligatoire.')
    if (!(Number(amount) > 0)) return setError('Le montant doit être supérieur à 0.')
    setSaving(true)
    try {
      await createExpense({
        date,
        heure,
        motif: motif.trim(),
        category,
        amount: Number(amount),
        paymentMethod,
        observation: observation || null,
        justificatif: justificatif || null,
      })
      navigate('/depenses')
    } catch (err: any) {
      setError(err?.message ?? 'Erreur lors de la création de la dépense')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Nouvelle dépense"
        subtitle="La dépense génère automatiquement une sortie de caisse"
        actions={
          <Button variant="secondary" onClick={() => navigate('/depenses')}>
            ← Retour
          </Button>
        }
      />
      <Form onSubmit={onSubmit} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Heure">
            <Input type="time" value={heure} onChange={(e) => setHeure(e.target.value)} />
          </Field>
        </div>
        <Field label="Motif *">
          <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ex : achat de sacs" />
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Catégorie">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES_DEPENSE.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Montant (DA) *">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        </div>
        <Field label="Mode de paiement">
          <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
            {MODES_PAIEMENT.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Observation">
          <Textarea rows={3} value={observation} onChange={(e) => setObservation(e.target.value)} />
        </Field>
        <Field label="Justificatif (référence / n° de pièce, optionnel)">
          <Input value={justificatif} onChange={(e) => setJustificatif(e.target.value)} />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => navigate('/depenses')}>
            Annuler
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer la dépense'}
          </Button>
        </div>
      </Form>
    </div>
  )
}

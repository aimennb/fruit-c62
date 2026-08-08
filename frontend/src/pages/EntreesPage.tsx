// Liste des entrées de caisse (rentrées d'argent hors ventes) + annulation.
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getExpenses, cancelExpense, type Expense } from '../api'
import { PageHeader, Button, Input, Field, Table, Spinner, ErrorBox, EmptyState, Badge } from '../components/ui'
import { fmtDA, fmtDate, MODES_PAIEMENT } from './caisse-utils'

export default function EntreesPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState('')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getExpenses(date || undefined, 'entree')
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

  async function onCancel(id: string) {
    if (!confirm('Annuler cette entrée ? Une ligne inverse sera créée en caisse.')) return
    setError(null)
    try {
      await cancelExpense(id)
      await load()
    } catch (e: any) {
      setError(e?.message ?? "Erreur lors de l'annulation")
    }
  }

  const modeLabel = (m: string) => MODES_PAIEMENT.find((x) => x.value === m)?.label ?? m
  const filtres = items.filter(
    (x) =>
      !q ||
      x.motif.toLowerCase().includes(q.toLowerCase()) ||
      (x.category ?? '').toLowerCase().includes(q.toLowerCase()),
  )

  return (
    <div>
      <PageHeader
        title="Entrées"
        subtitle="Entrées de caisse (rentrées d'argent)"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled title="Bientôt disponible">
              Export PDF / Excel (bientôt)
            </Button>
            <Button onClick={() => navigate('/entrees/nouvelle')}>Nouvelle entrée</Button>
          </div>
        }
      />

      <div className="grid sm:grid-cols-2 gap-3 mb-4 max-w-xl">
        <Field label="Filtrer par date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Recherche (motif / catégorie)">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher…" />
        </Field>
      </div>

      {error && <ErrorBox message={error} />}
      {loading && <Spinner label="Chargement…" />}
      {!loading && filtres.length === 0 && <EmptyState message="Aucune entrée trouvée." />}

      {!loading && filtres.length > 0 && (
        <Table
          headers={['Date', 'N°', 'Motif', 'Catégorie', 'Montant', 'Mode', 'Utilisateur', 'Statut', 'Actions']}
        >
          {filtres.map((x) => (
            <tr key={x.id} className={`hover:bg-gray-50 ${x.status === 'annulee' ? 'opacity-60' : ''}`}>
              <td className="px-4 py-3 whitespace-nowrap">
                {fmtDate(x.date)}
                {x.heure && <span className="text-xs text-gray-400"> {x.heure}</span>}
              </td>
              <td className="px-4 py-3 text-xs text-gray-500">{x.id.slice(-6).toUpperCase()}</td>
              <td className="px-4 py-3 font-medium text-gray-800">{x.motif}</td>
              <td className="px-4 py-3 text-gray-600">{x.category ?? '—'}</td>
              <td className="px-4 py-3 text-green-600 font-semibold">{fmtDA(x.amount)}</td>
              <td className="px-4 py-3 text-gray-600">{modeLabel(x.paymentMethod)}</td>
              <td className="px-4 py-3 text-gray-500 text-xs">{x.userId ?? '—'}</td>
              <td className="px-4 py-3">
                <Badge color={x.status === 'annulee' ? 'red' : 'green'}>
                  {x.status === 'annulee' ? 'Annulée' : 'Validée'}
                </Badge>
              </td>
              <td className="px-4 py-3">
                {x.status !== 'annulee' && (
                  <Button variant="ghost" onClick={() => onCancel(x.id)}>
                    Annuler
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

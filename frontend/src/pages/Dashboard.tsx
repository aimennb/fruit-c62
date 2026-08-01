import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { getProducts, getStock, getBulletins, getAdvances } from '../api'
import { Card, PageHeader, Spinner, ErrorBox } from '../components/ui'
import { useLang } from '../i18n'

const da = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

const MODULES = [
  { to: '/bordereaux', fr: 'Bordereaux', ar: 'برديات الموردين', desc: 'Suivi des bordereaux fournisseurs' },
  { to: '/stock', fr: 'Stocks', ar: 'المخزون', desc: 'Lots, quantités, pertes' },
  { to: '/produits', fr: 'Produits', ar: 'المنتجات', desc: 'Catalogue & seuils' },
  { to: '/fournisseurs', fr: 'Fournisseurs', ar: 'الموردون', desc: 'Référencements & relevés' },
  { to: '/clients', fr: 'Clients', ar: 'الزبائن', desc: 'Comptes & crédits' },
  { to: '/ventes', fr: 'Ventes', ar: 'المبيعات', desc: 'Vente + facture + paiement' },
  { to: '/receptions', fr: 'Réceptions', ar: 'وصولات الاستلام', desc: 'Bons de réception fournisseurs' },
]

export default function Dashboard() {
  const { lang } = useLang()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState({
    products: 0,
    stockValue: '0',
    bulletins: 0,
    advances: 0,
  })

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [prod, stock, bul, adv] = await Promise.all([
          getProducts(),
          getStock(),
          getBulletins(),
          getAdvances(),
        ])
        if (!alive) return
        setStats({
          products: prod.total ?? prod.items.length,
          stockValue: stock.totalValue,
          bulletins: bul.length,
          advances: adv.length,
        })
      } catch (e) {
        if (alive) setError((e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (loading) return <Spinner label="Chargement…" />
  if (error) return <ErrorBox message={error} />

  const summary = [
    { label: lang === 'ar' ? 'المنتجات' : 'Produits', value: String(stats.products) },
    { label: lang === 'ar' ? 'قيمة المخزون' : 'Valeur stock', value: da(stats.stockValue) },
    { label: lang === 'ar' ? 'محاضر' : 'Bulletins', value: String(stats.bulletins) },
    { label: lang === 'ar' ? 'السلف' : 'Avances', value: String(stats.advances) },
  ]

  return (
    <div className="space-y-6">
      <PageHeader title="Tableau de bord" subtitle="Vue d'ensemble de l'activité" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {summary.map((s) => (
          <Card key={s.label} className="p-5">
            <div className="text-sm text-gray-500">{s.label}</div>
            <div className="text-2xl font-bold text-fruite-green mt-1">{s.value}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MODULES.map((m) => (
          <NavLink key={m.to} to={m.to}>
            <Card className="p-5 h-full hover:shadow-md transition-shadow hover:border-fruite-green/40">
              <div className="font-bold text-gray-800">{lang === 'ar' ? m.ar : m.fr}</div>
              <div className="text-sm text-gray-500 mt-1">{m.desc}</div>
            </Card>
          </NavLink>
        ))}
      </div>
    </div>
  )
}

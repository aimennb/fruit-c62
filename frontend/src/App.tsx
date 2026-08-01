import { useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import { useLang } from './i18n'
import { Button, Input, Field, Spinner, ErrorBox } from './components/ui'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import Suppliers from './pages/Suppliers'
import SupplierDetail from './pages/SupplierDetail'
import Customers from './pages/Customers'
import Clients from './pages/Clients'
import Bulletins from './pages/Bulletins'
import Stock from './pages/Stock'
import Advances from './pages/Advances'
import Bulletin from './pages/Bulletin'
import SaleNew from './pages/SaleNew'
import Receptions from './pages/Receptions'
import ReceptionNew from './pages/ReceptionNew'
import ReceptionDetail from './pages/ReceptionDetail'
import Bordereaux from './pages/Bordereaux'
import BordereauDetail from './pages/BordereauDetail'
import InvoiceDetail from './pages/InvoiceDetail'
import CaissePage from './pages/CaissePage'
import CaisseDayDetail from './pages/CaisseDayDetail'
import DepensesPage from './pages/DepensesPage'
import ExpenseNew from './pages/ExpenseNew'
import CashSupplyPage from './pages/CashSupplyPage'
import CashRemittancePage from './pages/CashRemittancePage'
import CloturePage from './pages/CloturePage'
import CaisseInvoices from './pages/CaisseInvoices'
import CaisseCreditCollections from './pages/CaisseCreditCollections'
import CaisseExpenses from './pages/CaisseExpenses'
import CaisseCreditSales from './pages/CaisseCreditSales'
import CaisseRemittances from './pages/CaisseRemittances'
import SupplierPaymentsPage from './pages/SupplierPaymentsPage'
import SupplierPaymentNew from './pages/SupplierPaymentNew'
import SupplierPaymentDetail from './pages/SupplierPaymentDetail'

function Login() {
  const { login } = useAuth()
  const { lang } = useLang()
  const navigate = useNavigate()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
      navigate('/dashboard')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center bg-gray-100 p-4">
      <form onSubmit={onSubmit} className="bg-white p-8 rounded-2xl shadow-lg w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-bold text-fruite-green text-center">Fruiterie ERP</h1>
        <p className="text-center text-sm text-gray-500">
          {lang === 'ar' ? 'تسجيل الدخول' : 'Connexion'} — Grossiste fruits & légumes
        </p>
        <Field label={lang === 'ar' ? 'اسم المستخدم' : "Nom d'utilisateur"}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <Field label={lang === 'ar' ? 'كلمة المرور' : 'Mot de passe'}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <ErrorBox message={error} />}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? (lang === 'ar' ? 'جارٍ الدخول…' : 'Connexion…') : (lang === 'ar' ? 'دخول' : 'Se connecter')}
        </Button>
        <div className="text-center text-xs text-gray-400">
          {lang === 'ar' ? 'الحسابات' : 'Comptes'}: admin / responsable / employe
        </div>
      </form>
    </div>
  )
}

function Protected() {
  return (
    <Layout>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/bulletins" element={<Bulletins />} />
        <Route path="/stock" element={<Stock />} />
        <Route path="/produits" element={<Products />} />
        <Route path="/fournisseurs" element={<Suppliers />} />
        <Route path="/fournisseurs/detail" element={<SupplierDetail />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients-manage" element={<Customers />} />
        <Route path="/avances" element={<Advances />} />
        <Route path="/ventes" element={<Bulletin />} />
        <Route path="/ventes/nouveau" element={<SaleNew />} />
        <Route path="/receptions" element={<Receptions />} />
        <Route path="/receptions/new" element={<ReceptionNew />} />
        <Route path="/receptions/detail/:id" element={<ReceptionDetail />} />
        <Route path="/bordereaux" element={<Bordereaux />} />
        <Route path="/bordereaux/:id" element={<BordereauDetail />} />
        <Route path="/paiements-fournisseur" element={<SupplierPaymentsPage />} />
        <Route path="/paiements-fournisseur/nouveau" element={<SupplierPaymentNew />} />
        <Route path="/paiements-fournisseur/:id" element={<SupplierPaymentDetail />} />
        <Route path="/factures/:id" element={<InvoiceDetail />} />
        {/* Module CAISSE (Temps 1) — ordre important : routes fixes avant /caisse/:date */}
        <Route path="/caisse" element={<CaissePage />} />
        <Route path="/caisse/approvisionnement" element={<CashSupplyPage />} />
        <Route path="/caisse/remise" element={<CashRemittancePage />} />
        <Route path="/caisse/cloture" element={<CloturePage />} />
        {/* Drill-down des synthèses : plus spécifiques que /caisse/:date */}
        <Route path="/caisse/:date/factures" element={<CaisseInvoices />} />
        <Route path="/caisse/:date/credits-encaisses" element={<CaisseCreditCollections />} />
        <Route path="/caisse/:date/depenses" element={<CaisseExpenses />} />
        <Route path="/caisse/:date/credits-crees" element={<CaisseCreditSales />} />
        <Route path="/caisse/:date/remises" element={<CaisseRemittances />} />
        <Route path="/caisse/:date" element={<CaisseDayDetail />} />
        <Route path="/depenses" element={<DepensesPage />} />
        <Route path="/depenses/nouvelle" element={<ExpenseNew />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  )
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-full bg-gray-50">
        <Spinner label="Chargement…" />
      </div>
    )
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/dashboard" replace />} />
      <Route path="/*" element={<Protected />} />
    </Routes>
  )
}

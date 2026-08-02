import { NavLink, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth'
import { useLang } from '../i18n'

interface NavItem {
  to: string
  fr: string
  ar: string
}

const NAV: NavItem[] = [
  { to: '/dashboard', fr: 'Tableau de bord', ar: 'لوحة التحكم' },
  { to: '/ventes', fr: 'Ventes', ar: 'المبيعات' },
  { to: '/bordereaux', fr: 'Bordereaux', ar: 'برديات الموردين' },
  { to: '/stock', fr: 'Stocks', ar: 'المخزون' },
  { to: '/produits', fr: 'Produits', ar: 'المنتجات' },
  { to: '/fournisseurs', fr: 'Fournisseurs', ar: 'الموردون' },
  { to: '/clients', fr: 'Clients', ar: 'الزبائن' },
  { to: '/avances', fr: 'Avances fournisseurs', ar: 'السلف للموردين' },
  { to: '/paiements-fournisseur', fr: 'Paiement fournisseur', ar: 'دفع الموردين' },
  { to: '/receptions', fr: 'Réceptions', ar: 'وصولات الاستلام' },
  { to: '/caisse', fr: 'Caisse', ar: 'الصندوق' },
  { to: '/depenses', fr: 'Dépenses', ar: 'المصاريف' },
]

// Mapping route -> permission requise pour l'affichage dans le menu.
// Une route absente de ce mapping est visible par tous les utilisateurs
// authentifiés (ex: /dashboard).
const NAV_PERM: Record<string, string> = {
  '/dashboard': 'SALE_READ',
  '/ventes': 'SALE_READ',
  '/bordereaux': 'PURCHASE_READ',
  '/stock': 'STOCK_READ',
  '/produits': 'PRODUCT_READ',
  '/fournisseurs': 'SUPPLIER_READ',
  '/clients': 'CUSTOMER_READ',
  '/avances': 'PURCHASE_READ',
  '/paiements-fournisseur': 'PAYMENT_READ',
  '/receptions': 'RECEPTION_WRITE',
  '/caisse': 'PAYMENT_READ',
  '/depenses': 'PAYMENT_READ',
}

const ICONS: Record<string, ReactNode> = {
  '/dashboard': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>
  ),
  '/ventes': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1Z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>
  ),
  '/receptions': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8Z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>
  ),
  '/bordereaux': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>
  ),
  '/stock': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>
  ),
  '/produits': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18M3 12h18"/></svg>
  ),
  '/fournisseurs': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/></svg>
  ),
  '/clients': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 11a3 3 0 1 0 0-6"/><path d="M21 20a5 5 0 0 0-4-5"/></svg>
  ),
  '/avances': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h6M9 14h6"/></svg>
  ),
  '/paiements-fournisseur': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></svg>
  ),
  '/caisse': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/></svg>
  ),
  '/depenses': (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18"/><path d="M17 8a4 4 0 0 0-4-3h-2a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-2a4 4 0 0 1-4-3"/></svg>
  ),
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout, hasPerm } = useAuth()
  const { lang, toggle, tr } = useLang()
  const navigate = useNavigate()

  // Menu filtré par permission : un utilisateur restreint (RECEPTION_WRITE seul)
  // ne voit que l'entrée /receptions.
  const visibleNav = NAV.filter((item) =>
    NAV_PERM[item.to] ? hasPerm(NAV_PERM[item.to]) : true,
  )

  const onLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div className="min-h-full bg-gray-50 text-gray-800">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex flex-col fixed inset-y-0 start-0 w-64 bg-white border-e border-gray-100 shadow-sm">
        <div className="flex items-center gap-2 px-5 h-16 border-b border-gray-100">
          <div className="h-9 w-9 rounded-xl bg-fruite-green text-white grid place-items-center font-bold">F</div>
          <span className="font-bold text-lg text-fruite-green">{tr('appName')}</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 min-h-[44px] px-3 rounded-xl text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-fruite-green text-white'
                    : 'text-gray-600 hover:bg-gray-100'
                }`
              }
            >
              {ICONS[item.to]}
              <span>{lang === 'ar' ? item.ar : item.fr}</span>
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-4 border-t border-gray-100 space-y-2">
          <button
            onClick={toggle}
            className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            {tr('language')}: {lang === 'fr' ? 'FR' : 'AR'}
          </button>
          <div className="px-2 text-xs text-gray-400">
            {user && (
              <>
                <div className="font-semibold text-gray-600">{user.fullName}</div>
                <div>{user.role}</div>
              </>
            )}
          </div>
          <button
            onClick={onLogout}
            className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            {tr('logout')}
          </button>
        </div>
      </aside>

      {/* Main (desktop offset) */}
      <div className="md:ps-64">
        {/* Mobile top bar */}
        <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-14 bg-white border-b border-gray-100 shadow-sm">
          <span className="font-bold text-fruite-green">{tr('appName')}</span>
          <button
            onClick={toggle}
            className="min-h-[44px] min-w-[44px] rounded-xl bg-gray-100 text-sm font-medium text-gray-700"
          >
            {lang === 'fr' ? 'FR' : 'AR'}
          </button>
        </header>
        <main className="p-4 sm:p-6 pb-24 md:pb-6">{children}</main>
      </div>

      {/* Bottom nav (mobile) */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-gray-100 overflow-x-auto">
        <div className="flex min-w-max">
        {visibleNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center min-h-[56px] min-w-[72px] gap-0.5 text-[10px] shrink-0 ${
                isActive ? 'text-fruite-green' : 'text-gray-400'
              }`
            }
          >
            {ICONS[item.to]}
            <span className="leading-none">{lang === 'ar' ? item.ar : item.fr}</span>
          </NavLink>
        ))}
        </div>
      </nav>
    </div>
  )
}

import { useEffect, useState } from 'react'

export type Lang = 'fr' | 'ar'

type Dict = Record<string, { fr: string; ar: string }>

// Minimal bilingual dictionary: navigation + page titles (per spec).
// Business content stays FR with RTL for the moment.
export const t: Dict = {
  appName: { fr: 'Fruiterie ERP', ar: 'نظام فاكهة' },
  login: { fr: 'Connexion', ar: 'تسجيل الدخول' },
  username: { fr: "Nom d'utilisateur", ar: 'اسم المستخدم' },
  password: { fr: 'Mot de passe', ar: 'كلمة المرور' },
  signIn: { fr: 'Se connecter', ar: 'دخول' },
  connecting: { fr: 'Connexion…', ar: 'جارٍ الدخول…' },
  demoAccounts: { fr: 'Comptes: admin / responsable / employe', ar: 'الحسابات: admin / responsable / employe' },
  logout: { fr: 'Déconnexion', ar: 'خروج' },
  language: { fr: 'Langue', ar: 'اللغة' },
  dashboard: { fr: 'Tableau de bord', ar: 'لوحة التحكم' },
  products: { fr: 'Produits', ar: 'المنتجات' },
  suppliers: { fr: 'Fournisseurs', ar: 'الموردون' },
  clients: { fr: 'Clients', ar: 'الزبائن' },
  bulletins: { fr: 'Bulletins', ar: 'محاضر الشراء' },
  stock: { fr: 'Stocks', ar: 'المخزون' },
  advances: { fr: 'Avances fournisseurs', ar: 'السلف للموردين' },
  new: { fr: 'Nouveau', ar: 'جديد' },
  create: { fr: 'Créer', ar: 'إنشاء' },
  edit: { fr: 'Modifier', ar: 'تعديل' },
  search: { fr: 'Rechercher', ar: 'بحث' },
  save: { fr: 'Enregistrer', ar: 'حفظ' },
  cancel: { fr: 'Annuler', ar: 'إلغاء' },
  delete: { fr: 'Supprimer', ar: 'حذف' },
  validate: { fr: 'Valider', ar: 'اعتماد' },
  pdf: { fr: 'PDF', ar: 'PDF' },
  back: { fr: 'Retour', ar: 'رجوع' },
  name: { fr: 'Nom', ar: 'الاسم' },
  reference: { fr: 'Référence', ar: 'المرجع' },
  amount: { fr: 'Montant', ar: 'المبلغ' },
  status: { fr: 'Statut', ar: 'الحالة' },
  supplier: { fr: 'Fournisseur', ar: 'المورد' },
  total: { fr: 'Total', ar: 'الإجمالي' },
  loading: { fr: 'Chargement…', ar: 'جارٍ التحميل…' },
  noData: { fr: 'Aucune donnée', ar: 'لا توجد بيانات' },
  error: { fr: 'Erreur', ar: 'خطأ' },
  connectedAs: { fr: 'Connecté en tant que', ar: 'متصل باسم' },
  loss: { fr: 'Perte', ar: 'خسارة' },
  quantity: { fr: 'Quantité', ar: 'الكمية' },
  reason: { fr: 'Motif', ar: 'السبب' },
  statement: { fr: 'Relevé', ar: 'كشف الحساب' },
  allocate: { fr: 'Allouer', ar: 'تخصيص' },
  template: { fr: 'Modèle', ar: 'النموذج' },
  netWeight: { fr: 'Poids net', ar: 'الوزن الصافي' },
  grossWeight: { fr: 'Poids brut', ar: 'الوزن الإجمالي' },
  tare: { fr: 'Tare', ar: 'الطرح' },
  packages: { fr: 'Nbr colis', ar: 'عدد العبوات' },
  unitPrice: { fr: 'Prix unitaire', ar: 'السعر الوحدة' },
  value: { fr: 'Valeur', ar: 'القيمة' },
  lot: { fr: 'Lot', ar: 'الدفعة' },
  alert: { fr: 'Alerte', ar: 'تنبيه' },
  paymentMethod: { fr: 'Mode de paiement', ar: 'طريقة الدفع' },
  addItem: { fr: 'Ajouter un article', ar: 'إضافة عنصر' },
  balance: { fr: 'Solde', ar: 'الرصيد' },
  sales: { fr: 'Ventes', ar: 'المبيعات' },
  invoices: { fr: 'Factures', ar: 'الفواتير' },
  payments: { fr: 'Paiements', ar: 'المدفوعات' },
}

const STORAGE_KEY = 'fruiterie_lang'

export function getInitialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'ar' ? 'ar' : 'fr'
}

export function useLang() {
  const [lang, setLang] = useState<Lang>(getInitialLang())

  useEffect(() => {
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr')
    document.documentElement.setAttribute('lang', lang === 'ar' ? 'ar' : 'fr')
    localStorage.setItem(STORAGE_KEY, lang)
  }, [lang])

  const tr = (key: keyof typeof t | string): string => {
    const entry = t[key]
    if (!entry) return String(key)
    return entry[lang]
  }

  const toggle = () => setLang((l) => (l === 'fr' ? 'ar' : 'fr'))

  return { lang, setLang, toggle, tr }
}

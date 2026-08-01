import { useEffect, useRef, useState } from 'react'
import type {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  FormHTMLAttributes,
} from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm border border-gray-100 ${className}`}>
      {children}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const btnBase =
  'inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-fruite-green text-white hover:bg-fruite-dark',
  secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  ghost: 'bg-transparent text-gray-600 hover:bg-gray-100',
}

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button className={`${btnBase} ${btnVariants[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-h-[44px] w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green ${className}`}
      {...props}
    />
  )
}

export function Select({ className = '', children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`min-h-[44px] w-full rounded-xl border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}

export function Textarea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green ${className}`}
      {...props}
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

export function Form({ className = '', children, ...props }: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form className={`space-y-4 ${className}`} {...props}>
      {children}
    </form>
  )
}

export function Badge({ children, color = 'gray' }: { children: ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',
    blue: 'bg-blue-100 text-blue-700',
  }
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${colors[color] ?? colors.gray}`}>
      {children}
    </span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10 text-gray-500">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-fruite-green border-t-transparent" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl bg-red-50 text-red-700 border border-red-200 px-4 py-3 text-sm">
      {message}
    </div>
  )
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-10 text-center text-sm text-gray-400">{message}</div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg' | 'xl'
}) {
  if (!open) return null
  const sizeClass =
    size === 'xl' ? 'sm:max-w-4xl' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
      <div className={`bg-white w-full ${sizeClass} rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-800">{title}</h2>
          <button onClick={onClose} className="min-h-[44px] min-w-[44px] text-gray-400 hover:text-gray-700 text-xl">
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function Table({
  headers,
  children,
}: {
  headers: string[]
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white">
      <table className="w-full text-sm text-left">
        <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="px-4 py-3 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  )
}

export interface SearchSelectOption {
  id: string
  label: string
  sublabel?: string | null
}

interface SearchSelectProps {
  placeholder?: string
  value: string
  options: SearchSelectOption[]
  loading?: boolean
  onQuery: (q: string) => void
  onSelect: (opt: SearchSelectOption) => void
  onClear?: () => void
  // Appelé à CHAQUE frappe (texte libre), même sans sélection d'une suggestion.
  // Permet au parent de capter un nom saisi librement (ex. client auto-créé).
  onChange?: (text: string) => void
}

// Lightweight autocomplete: text input + dropdown list (AR/FR results).
// Calls onQuery as the user types; onSelect populates the value.
export function SearchSelect({
  placeholder,
  value,
  options,
  loading,
  onQuery,
  onSelect,
  onClear,
  onChange,
}: SearchSelectProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(value)
  const ref = useRef<HTMLDivElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setText(value)
  }, [value])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function handleChange(raw: string) {
    setText(raw)
    onChange?.(raw)
    setOpen(true)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => onQuery(raw), 200)
  }

  return (
    <div className="relative" ref={ref}>
      <Input
        value={text}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          setOpen(true)
          if (!text) onQuery('')
        }}
        className="pe-9"
      />
      {value && onClear && (
        <button
          type="button"
          onClick={() => {
            onClear()
            setText('')
            onQuery('')
          }}
          className="absolute end-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 text-lg leading-none"
          aria-label="Effacer"
        >
          ×
        </button>
      )}
      {open && (loading || options.length > 0) && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg max-h-60 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-xs text-gray-400">…</div>
          )}
          {options.map((o) => (
            <button
              type="button"
              key={o.id}
              className="w-full text-start px-3 py-2 hover:bg-gray-100 flex flex-col"
              onClick={() => {
                onSelect(o)
                setText(o.label)
                setOpen(false)
              }}
            >
              <span className="text-sm font-medium text-gray-800">{o.label}</span>
              {o.sublabel && (
                <span className="text-xs text-gray-500">{o.sublabel}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

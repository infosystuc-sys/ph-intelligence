'use client'

import { useEffect, useMemo, useState } from 'react'
import { Phone, Plus, Pencil, Trash2, Check, X, Loader2, Info, Search } from 'lucide-react'

type EmployeePhone = {
  id: string
  phone: string
  name: string | null
  notes: string | null
  created_at: string
}

type FormState = { phone: string; name: string; notes: string }
const EMPTY_FORM: FormState = { phone: '', name: '', notes: '' }

export default function EmployeePhonesPage() {
  const [phones, setPhones] = useState<EmployeePhone[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // Nuevo registro
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Edición inline
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // Eliminación
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  // Búsqueda por teléfono: se compara solo los dígitos para que no importe si
  // el usuario tipea espacios, guiones o el "+" inicial.
  const digitsOnly = (s: string) => s.replace(/\D/g, '')
  const filteredPhones = useMemo(() => {
    const q = digitsOnly(search)
    if (!q) return phones
    return phones.filter(p =>
      digitsOnly(p.phone).includes(q) ||
      (p.name ?? '').toLowerCase().includes(search.toLowerCase())
    )
  }, [phones, search])

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/employee-phones')
    const data = await res.json()
    setPhones(data.data ?? [])
    setLoading(false)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setAddError(null)
    const res = await fetch('/api/employee-phones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm),
    })
    const data = await res.json()
    setSaving(false)
    if (!res.ok) { setAddError(data.error); return }
    setAddForm(EMPTY_FORM)
    setShowAdd(false)
    await load()
  }

  const startEdit = (p: EmployeePhone) => {
    setEditingId(p.id)
    setEditForm({ phone: p.phone, name: p.name ?? '', notes: p.notes ?? '' })
    setEditError(null)
  }

  const handleEdit = async (id: string) => {
    setEditSaving(true)
    setEditError(null)
    const res = await fetch('/api/employee-phones', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...editForm }),
    })
    const data = await res.json()
    setEditSaving(false)
    if (!res.ok) { setEditError(data.error); return }
    setEditingId(null)
    await load()
  }

  const handleDelete = async (id: string) => {
    setDeleting(id)
    await fetch(`/api/employee-phones?id=${id}`, { method: 'DELETE' })
    setDeleting(null)
    setConfirmDelete(null)
    await load()
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-body flex items-center gap-2">
            <Phone size={22} className="text-primary" />
            Teléfonos de Empleados
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Los números registrados aquí pueden filtrarse en el módulo de Conversaciones.
            {!loading && (
              search
                ? ` ${filteredPhones.length} de ${phones.length} coinciden.`
                : ` ${phones.length} registrados.`
            )}
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(v => !v); setAddForm(EMPTY_FORM); setAddError(null) }}
          className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors"
        >
          {showAdd ? <X size={14} /> : <Plus size={14} />}
          {showAdd ? 'Cancelar' : 'Agregar'}
        </button>
      </div>

      {/* Buscador */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por teléfono o nombre..."
          className="w-full border border-border rounded-md pl-9 pr-3 py-2 text-sm bg-surface text-body focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* Aviso formato */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-700">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Ingresá el número en el mismo formato que WhatsApp, sin espacios ni guiones.
          Ejemplo: <strong>5491112345678</strong> (código país + código área sin 0 + número sin 15).
        </span>
      </div>

      {/* Formulario de alta */}
      {showAdd && (
        <form onSubmit={handleAdd} className="bg-surface rounded-lg border-2 border-primary/30 p-5 space-y-4">
          <h2 className="font-semibold text-body flex items-center gap-2">
            <Plus size={15} className="text-primary" /> Nuevo teléfono
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Teléfono <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={addForm.phone}
                onChange={e => setAddForm(p => ({ ...p, phone: e.target.value }))}
                placeholder="5491112345678"
                required
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-body focus:outline-none focus:ring-2 focus:ring-primary font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Nombre</label>
              <input
                type="text"
                value={addForm.name}
                onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))}
                placeholder="Juan Pérez"
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
              <input
                type="text"
                value={addForm.notes}
                onChange={e => setAddForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="Ej: Vendedor zona norte"
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-body focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-4 py-2 rounded-md transition-colors disabled:opacity-60"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      )}

      {/* Tabla */}
      <div className="bg-surface rounded-lg border border-border shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-12">
            <Loader2 size={14} className="animate-spin" /> Cargando...
          </div>
        ) : phones.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-12">
            No hay teléfonos registrados aún
          </div>
        ) : filteredPhones.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-12">
            Ningún número coincide con &quot;{search}&quot; ({phones.length} registrados en total)
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg border-b border-border text-left">
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Teléfono</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Nombre</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Notas</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Agregado</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredPhones.map(p => {
                const isEditing = editingId === p.id
                return (
                  <tr key={p.id} className={`transition-colors ${isEditing ? 'bg-yellow-50' : 'hover:bg-bg'}`}>
                    {/* Teléfono */}
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editForm.phone}
                          onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))}
                          className="border border-border rounded px-2 py-1 text-xs font-mono w-36 focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      ) : (
                        <span className="font-mono text-xs text-body">{p.phone}</span>
                      )}
                    </td>

                    {/* Nombre */}
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editForm.name}
                          onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          placeholder="Nombre"
                          className="border border-border rounded px-2 py-1 text-xs w-32 focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      ) : (
                        <span className="text-body">{p.name ?? <span className="text-gray-300">—</span>}</span>
                      )}
                    </td>

                    {/* Notas */}
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editForm.notes}
                          onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                          placeholder="Notas"
                          className="border border-border rounded px-2 py-1 text-xs w-40 focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      ) : (
                        <span className="text-gray-500 text-xs">{p.notes ?? <span className="text-gray-300">—</span>}</span>
                      )}
                    </td>

                    {/* Fecha */}
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {new Date(p.created_at).toLocaleDateString('es-AR')}
                    </td>

                    {/* Acciones */}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {isEditing ? (
                          <>
                            {editError && <span className="text-xs text-red-500 mr-1">{editError}</span>}
                            <button
                              onClick={() => handleEdit(p.id)}
                              disabled={editSaving}
                              className="text-green-600 hover:text-green-700 disabled:opacity-50"
                              title="Guardar"
                            >
                              {editSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                            </button>
                            <button
                              onClick={() => { setEditingId(null); setEditError(null) }}
                              className="text-gray-400 hover:text-gray-600"
                              title="Cancelar"
                            >
                              <X size={14} />
                            </button>
                          </>
                        ) : confirmDelete === p.id ? (
                          <>
                            <span className="text-xs text-red-500">¿Eliminar?</span>
                            <button
                              onClick={() => handleDelete(p.id)}
                              disabled={deleting === p.id}
                              className="text-xs text-red-600 font-semibold hover:text-red-700 disabled:opacity-50"
                            >
                              {deleting === p.id ? <Loader2 size={12} className="animate-spin" /> : 'Sí'}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="text-xs text-gray-400 hover:text-gray-600"
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEdit(p)}
                              className="text-gray-400 hover:text-body transition-colors"
                              title="Editar"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => setConfirmDelete(p.id)}
                              className="text-gray-400 hover:text-red-500 transition-colors"
                              title="Eliminar"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

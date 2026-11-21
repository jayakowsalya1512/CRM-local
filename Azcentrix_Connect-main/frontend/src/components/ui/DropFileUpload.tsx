// src/components/ui/DropFileUpload.tsx

import { useRef, useState } from 'react'
import { Upload, Loader2 } from 'lucide-react'
import api from '@/services/api'
import { useToast } from '@/components/ui/FormComponents'

type DropFileUploadProps = {
  label: string
  file?: File | null
  accept?: string
  multiple?: boolean
  variant?: 'compact' | 'panel'
  helperText?: string
  className?: string
  uploading?: boolean
  disabled?: boolean
  storagePrecheck?: boolean
  onFile?: (file: File) => void | Promise<void>
  onFiles?: (files: File[]) => void | Promise<void>
}

export default function DropFileUpload({
  label,
  file,
  accept,
  multiple = false,
  variant = 'compact',
  helperText,
  className = '',
  uploading = false,
  disabled = false,
  storagePrecheck = true,
  onFile,
  onFiles,
}: DropFileUploadProps) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { error: showError } = useToast()
  const isPanel = variant === 'panel'

  const openPicker = () => {
    if (disabled || uploading) return
    inputRef.current?.click()
  }

  const pickFile = async (files: FileList | null) => {
    if (disabled || uploading) return
    if (!files?.length) return
    const selectedFiles = multiple ? Array.from(files) : [files[0]]
    if (storagePrecheck) {
      try {
        const fd = new FormData()
        selectedFiles.forEach(file => fd.append('files', file, file.name))
        await api.post('/storage/check-file', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      } catch (e: any) {
        showError(e?.response?.status === 413 ? 'Storage limit exceeded.' : (e?.response?.data?.detail || 'Storage limit exceeded.'))
        return
      }
    }
    if (onFiles) {
      await onFiles(selectedFiles)
      return
    }
    const selected = selectedFiles[0]
    if (selected) await onFile?.(selected)
  }

  return (
    <div
      role="button"
      tabIndex={disabled || uploading ? -1 : 0}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openPicker()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled && !uploading) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        pickFile(e.dataTransfer.files)
      }}
      className={`cursor-pointer border-2 border-dashed rounded-xl transition-colors
        ${isPanel ? 'flex w-full items-start px-4 py-4 text-left' : 'flex items-center justify-center gap-2 px-3 py-3 text-xs font-semibold'}
        ${dragging ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-blue-300 hover:bg-blue-50'}
        ${(disabled || uploading) ? 'opacity-60 cursor-not-allowed' : ''}
        ${className}
      `}
    >
      {isPanel ? (
        <div className="flex w-full items-center gap-3">
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border ${
            dragging ? 'border-blue-200 bg-white text-blue-600' : 'border-gray-200 bg-white text-gray-500'
          }`}>
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          </div>
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-gray-700">
              {file ? file.name : label}
            </span>
            {helperText && (
              <span className="mt-1 block text-xs font-medium text-gray-400">
                {helperText}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openPicker()
            }}
            disabled={disabled || uploading}
            className="hidden rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-600 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 sm:inline-flex">
            {file ? 'Selected' : 'Browse'}
          </button>
        </div>
      ) : (
        <>
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}

          <span className="truncate">
            {file ? file.name : label}
          </span>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled || uploading}
        className="sr-only"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          pickFile(e.target.files)
          e.currentTarget.value = ''
        }}
      />
    </div>
  )
}

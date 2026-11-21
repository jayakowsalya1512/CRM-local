export function getApiErrorMessage(
  error: any,
  fallback: string,
  options: { storageFallback?: string } = {}
): string {
  if (error?.response?.status === 413) {
    return options.storageFallback || 'Storage limit exceeded.'
  }

  const detail = error?.response?.data?.detail
  const message = Array.isArray(detail)
    ? detail.map((item: any) => item?.msg || String(item)).join(', ')
    : (typeof detail === 'string' ? detail : '')

  if (!message) return fallback

  if (message.includes("Data too long for column 'po_doc'")) {
    return 'PO document could not be saved.'
  }

  const rawServerMarkers = ['[SQL:', '[parameters:', 'pymysql.err.', 'sqlalchemy.exc.']
  if (rawServerMarkers.some(marker => message.includes(marker))) {
    return fallback
  }

  return message
}

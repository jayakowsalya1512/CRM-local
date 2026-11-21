import axios, { AxiosInstance } from 'axios'

import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios'
import { emitSessionActivity } from '@/services/sessionActivity'
import { useAuthStore } from '@/store'
import type { SessionPolicy } from '@/types'
import { clearAuthStorage, isTokenExpired } from '@/utils/auth'

const BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'
const SESSION_NOTICE_QUERY_KEY = 'session_notice'
const SESSION_NOTICE_ADMIN_FORCE_LOGOUT = 'admin-force-logout'
const SESSION_NOTICE_OTHER_DEVICE_LOGOUT = 'other-device-logout'
export const SESSION_NOTICE_INACTIVE_TIMEOUT = 'inactive-timeout'
export const SESSION_ACTIVITY_HEADER = 'X-Session-Activity'
export const PASSIVE_SESSION_ACTIVITY_VALUE = 'passive'
const PUBLIC_REQUEST_PATHS = new Set([
  '/auth/login',
  '/auth/login/verify-otp',
  '/auth/login/resend-otp',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/contact-administrator',
  '/auth/maintenance-status',
  '/platform/login',
  '/settings/theme',
])

type SessionResponsePayload = {
  access_token?: string
  refresh_token?: string
  login_expiry_minutes?: number
}

type SessionAwareRequestConfig = InternalAxiosRequestConfig & {
  _retry?: boolean
}

const normalizeRequestPath = (url?: string) => {
  if (!url) return ''

  const [withoutQuery] = url.split('?')
  if (!withoutQuery) return ''

  if (/^https?:\/\//i.test(withoutQuery)) {
    try {
      return new URL(withoutQuery).pathname
    } catch {
      return withoutQuery
    }
  }

  return withoutQuery
}

const isPublicRequest = (url?: string) => {
  const path = normalizeRequestPath(url)
  if (!path) return false
  if ([...PUBLIC_REQUEST_PATHS].some((publicPath) => path === publicPath || path.endsWith(publicPath))) {
    return true
  }
  return path.startsWith('/auth/captcha-status/') || path.includes('/auth/captcha-status/')
}

const isTenantScopedPublicRequest = (url?: string) => {
  const path = normalizeRequestPath(url)
  if (!path) return false
  return (
    path === '/settings/theme' ||
    path.endsWith('/settings/theme') ||
    path.startsWith('/auth/captcha-status/') ||
    path.includes('/auth/captcha-status/') ||
    path === '/auth/maintenance-status' ||
    path.endsWith('/auth/maintenance-status')
  )
}

const resolveSessionNotice = (detail?: string) => {
  const normalizedDetail = (detail || '').trim().toLowerCase()
  if (!normalizedDetail) return ''
  if (
    normalizedDetail.includes('administrator logged you out')
    || normalizedDetail.includes('logged you out for security reasons')
  ) {
    return SESSION_NOTICE_ADMIN_FORCE_LOGOUT
  }
  if (normalizedDetail.includes('another device') || normalizedDetail.includes('other device')) {
    return SESSION_NOTICE_OTHER_DEVICE_LOGOUT
  }
  if (normalizedDetail.includes('inactivity')) {
    return SESSION_NOTICE_INACTIVE_TIMEOUT
  }
  return ''
}

export const performClientLogout = (notice = '') => {
  try {
    useAuthStore.getState().logout()
  } catch {
    clearAuthStorage()
  }
  const target = notice ? `/login?${SESSION_NOTICE_QUERY_KEY}=${encodeURIComponent(notice)}` : '/login'
  window.location.replace(target)
}

const getApiOrigin = () => {
  if (/^https?:\/\//i.test(BASE_URL)) {
    try {
      return new URL(BASE_URL).origin
    } catch {
      return window.location.origin
    }
  }
  return window.location.origin
}

export const buildApiAssetUrl = (path?: string | null) => {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getApiOrigin()}${normalizedPath}`
}

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

const refreshClient = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

const extractSessionPolicy = (data?: SessionResponsePayload | null): SessionPolicy | null => {
  const loginExpiryMinutes = Number(data?.login_expiry_minutes)
  if (!Number.isFinite(loginExpiryMinutes) || loginExpiryMinutes <= 0) return null
  return { login_expiry_minutes: loginExpiryMinutes }
}

const getStoredTenantSlug = () => useAuthStore.getState().tenant_slug || localStorage.getItem('tenant_slug') || ''

function getOrCreateDeviceUuid(): string {
  const STORAGE_KEY = 'device_uuid'
  let uuid = localStorage.getItem(STORAGE_KEY)
  if (!uuid) {
    uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(STORAGE_KEY, uuid)
  }
  return uuid
}
const getStoredAccessToken = () => useAuthStore.getState().access_token || localStorage.getItem('access_token')
const getStoredRefreshToken = () => useAuthStore.getState().refresh_token || localStorage.getItem('refresh_token')
const hasStoredSession = () => {
  const { user, access_token, refresh_token } = useAuthStore.getState()
  return Boolean(user || access_token || refresh_token || localStorage.getItem('digitcrm-auth'))
}

let refreshPromise: Promise<string | null> | null = null

export async function refreshAuthSession(options?: { redirectOnFail?: boolean; countAsActivity?: boolean }) {
  const redirectOnFail = options?.redirectOnFail ?? true
  const countAsActivity = options?.countAsActivity ?? true
  const refreshToken = getStoredRefreshToken()
  const tenantSlug = getStoredTenantSlug()

  if (!refreshToken || isTokenExpired(refreshToken)) {
    if (redirectOnFail) performClientLogout()
    return null
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const { data } = await refreshClient.post<SessionResponsePayload>(
          '/auth/refresh',
          { refresh_token: refreshToken },
          {
            headers: tenantSlug ? { 'X-Tenant-Slug': tenantSlug } : undefined,
          },
        )

        if (!data?.access_token) {
          throw new Error('No access token returned from refresh')
        }

        useAuthStore.getState().updateSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token || refreshToken,
          session_policy: extractSessionPolicy(data),
        })
        if (countAsActivity) emitSessionActivity('api')
        return data.access_token
      } catch (error: any) {
        const notice = resolveSessionNotice(error?.response?.data?.detail)
        if (redirectOnFail) performClientLogout(notice)
        throw error
      } finally {
        refreshPromise = null
      }
    })()
  }

  return refreshPromise
}

export const withPassiveSessionActivity = <T extends AxiosRequestConfig>(config?: T): T => {
  const headers = {
    ...(config?.headers || {}),
    [SESSION_ACTIVITY_HEADER]: PASSIVE_SESSION_ACTIVITY_VALUE,
  }

  return {
    ...((config || {}) as T),
    headers,
  }
}

api.interceptors.request.use(async (config) => {
  const requestConfig = config as SessionAwareRequestConfig
  const isPublic = isPublicRequest(requestConfig.url)
  let token = getStoredAccessToken()
  const refreshToken = getStoredRefreshToken()
  const tenantSlug = getStoredTenantSlug()
  const activityMode = String(
    (requestConfig.headers as Record<string, unknown> | undefined)?.[SESSION_ACTIVITY_HEADER] ??
    (requestConfig.headers as Record<string, unknown> | undefined)?.[SESSION_ACTIVITY_HEADER.toLowerCase()] ??
    '',
  ).trim().toLowerCase()
  const isPassiveRequest = activityMode === PASSIVE_SESSION_ACTIVITY_VALUE
  const existingTenantHeader =
    (requestConfig.headers as Record<string, unknown> | undefined)?.['X-Tenant-Slug'] ??
    (requestConfig.headers as Record<string, unknown> | undefined)?.['x-tenant-slug']

  if (!isPublic) {
    const canRefresh = Boolean(refreshToken && !isTokenExpired(refreshToken))
    if ((!token || isTokenExpired(token)) && canRefresh) {
      try {
        token = await refreshAuthSession({ countAsActivity: !isPassiveRequest })
      } catch {
        return new Promise(() => {})
      }
    }

    if (token && !isTokenExpired(token)) {
      requestConfig.headers.Authorization = `Bearer ${token}`
    } else if (!isPassiveRequest && hasStoredSession()) {
      performClientLogout()
      return new Promise(() => {})
    }
  }

  if (tenantSlug && (!isPublic || isTenantScopedPublicRequest(requestConfig.url)) && !existingTenantHeader) {
    requestConfig.headers['X-Tenant-Slug'] = tenantSlug
  }
  return requestConfig
})

api.interceptors.response.use(
  (response) => {
    const configHeaders = response.config.headers as Record<string, unknown> | undefined
    const activityMode = String(
      configHeaders?.[SESSION_ACTIVITY_HEADER] ??
      configHeaders?.[SESSION_ACTIVITY_HEADER.toLowerCase()] ??
      '',
    ).trim().toLowerCase()

    if (!isPublicRequest(response.config.url) && activityMode !== PASSIVE_SESSION_ACTIVITY_VALUE) {
      emitSessionActivity('api')
    }
    return response
  },
  async (error) => {
    const requestConfig = (error.config || {}) as SessionAwareRequestConfig
    const shouldHandleAsSession = hasStoredSession()
    const activityMode = String(
      (requestConfig.headers as Record<string, unknown> | undefined)?.[SESSION_ACTIVITY_HEADER] ??
      (requestConfig.headers as Record<string, unknown> | undefined)?.[SESSION_ACTIVITY_HEADER.toLowerCase()] ??
      '',
    ).trim().toLowerCase()
    const isPassiveRequest = activityMode === PASSIVE_SESSION_ACTIVITY_VALUE
    const notice = resolveSessionNotice(error.response?.data?.detail)

    if (error.response?.status === 401 && !isPublicRequest(requestConfig.url) && isPassiveRequest) {
      if (notice) {
        performClientLogout(notice)
        return new Promise(() => {})
      }
      return Promise.reject(error)
    }

    if (error.response?.status === 401 && !isPublicRequest(requestConfig.url) && shouldHandleAsSession && !requestConfig._retry) {
      requestConfig._retry = true
      try {
        const nextAccessToken = await refreshAuthSession({ countAsActivity: true })
        if (!nextAccessToken) throw error
        requestConfig.headers = requestConfig.headers || {}
        requestConfig.headers.Authorization = `Bearer ${nextAccessToken}`
        return api(requestConfig)
      } catch (refreshError: any) {
        const refreshNotice = resolveSessionNotice(refreshError?.response?.data?.detail || error.response?.data?.detail)
        performClientLogout(refreshNotice)
        return new Promise(() => {})
      }
    }

    if (error.response?.status === 401 && !isPublicRequest(requestConfig.url) && shouldHandleAsSession) {
      performClientLogout(notice)
      return new Promise(() => {})
    }
    return Promise.reject(error)
  }
)

const rawGet = api.get.bind(api)
const inFlightGetRequests = new Map<string, Promise<any>>()

const stableStringify = (value: unknown): string => {
  if (!value || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

api.get = ((url: string, config?: AxiosRequestConfig) => {
  if (config?.signal || (config?.responseType && config.responseType !== 'json')) {
    return rawGet(url, config)
  }

  const key = stableStringify({
    url,
    params: config?.params ?? null,
    headers: config?.headers ?? null,
  })
  const existing = inFlightGetRequests.get(key)
  if (existing) return existing

  const request = rawGet(url, config).finally(() => {
    inFlightGetRequests.delete(key)
  })
  inFlightGetRequests.set(key, request)
  return request
}) as typeof api.get

export const authApi = {
  maintenanceStatus: (tenantSlug: string) => api.get<{ maintenance_mode: boolean }>('/auth/maintenance-status', {
    headers: { 'X-Tenant-Slug': tenantSlug },
  }),
  login: (
    tenantSlug: string,
    username: string,
    password: string,
    remember_me = true,
    captcha_token?: string,
  ) => api.post('/auth/login', { username, password, remember_me, captcha_token, login_from: 'web' }, {
    headers: { 'X-Tenant-Slug': tenantSlug, 'X-Device-UUID': getOrCreateDeviceUuid() },
    withCredentials: true,
  }),
  verifyLoginOtp: (
    tenantSlug: string,
    challengeId: string,
    otp: string,
  ) => api.post('/auth/login/verify-otp', { challenge_id: challengeId, otp }, {
    headers: { 'X-Tenant-Slug': tenantSlug, 'X-Device-UUID': getOrCreateDeviceUuid() },
    withCredentials: true,
  }),
  resendLoginOtp: (
    tenantSlug: string,
    challengeId: string,
  ) => api.post('/auth/login/resend-otp', { challenge_id: challengeId }, {
    headers: { 'X-Tenant-Slug': tenantSlug },
  }),
  refreshSession: (refreshToken: string, tenantSlug?: string) =>
    refreshClient.post('/auth/refresh', { refresh_token: refreshToken }, {
      headers: tenantSlug ? { 'X-Tenant-Slug': tenantSlug } : undefined,
    }),
  touchSessionActivity: () => api.post('/auth/session/activity'),
  logout: () => api.post('/auth/logout'),
  logoutAllMyDevices: () => api.post('/auth/logout-all-devices'),
  logoutSelectedUsers: (userIds: number[], requirePasswordReset = false) => api.post('/auth/users/logout-selected', {
    user_ids: userIds,
    require_password_reset: requirePasswordReset,
  }),
  logoutAllUsers: (requirePasswordReset = false) => api.post('/auth/users/logout-all', {
    require_password_reset: requirePasswordReset,
  }),
  getMyLogoutHistory: (limit = 10) => api.get('/auth/me/logout-history', { params: { limit } }),
  me: () => api.get('/auth/me'),
  captchaStatus: (tenantSlug: string, username: string) => api.get(`/auth/captcha-status/${encodeURIComponent(username)}`, {
    headers: { 'X-Tenant-Slug': tenantSlug },
  }),
  forgotPassword: (email: string, tenantSlug?: string, employeeCode?: string) => api.post('/auth/forgot-password', { email, employee_code: employeeCode || undefined }, {
    headers: tenantSlug ? { 'X-Tenant-Slug': tenantSlug } : undefined,
    params: tenantSlug ? { tenant: tenantSlug } : undefined,
  }),
  requestMyPasswordReset: () => api.post('/auth/me/request-reset', {}),
  resetPassword: (data: { token: string; new_password: string; confirm_password: string }) =>
    api.post('/auth/reset-password', data),
  contactAdministrator: (data: { email?: string; tenant_slug?: string; username?: string }) =>
    api.post('/auth/contact-administrator', data),
  listUsers: () => api.get('/auth/users'),
  createUser: (data: Record<string, unknown>) => api.post('/auth/users', data),
  updateUser: (id: number, data: Record<string, unknown>) => api.put(`/auth/users/${id}`, data),
  deactivateUser: (id: number) => api.delete(`/auth/users/${id}`),
  sendUserResetLink: (id: number) => api.post(`/auth/users/${id}/send-reset-link`),
}
export const themeApi = {
  getTheme: () => api.get('/settings/theme'),
  getSettings: () => api.get('/settings/settings'),
  updateSettings: (data: Record<string, unknown>) => api.put('/settings/settings', data),
  getNotificationRecipientTypes: (module: string) => api.get('/settings/notification-recipient-types', { params: { module } }),
  getNotificationEvents: () => api.get('/settings/notification-events'),
  getNotificationRules: (params?: Record<string, unknown>) => api.get('/settings/notification-rules', { params }),
  updateNotificationRules: (data: Record<string, unknown>) => api.put('/settings/notification-rules', data),
  getNotificationTemplates: (params?: Record<string, unknown>) => api.get('/settings/notification-templates', { params }),
  updateNotificationTemplates: (data: Record<string, unknown>) => api.put('/settings/notification-templates', data),
  uploadCompanyLogo: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/settings/company/logo', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  deleteCompanyLogo: (deleteFile = true) => api.delete('/settings/company/logo', {
    params: { delete_file: deleteFile },
  }),
  uploadLetterPadSeal: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/settings/company/letter-pad-seal', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  deleteLetterPadSeal: () => api.delete('/settings/company/letter-pad-seal'),
  getDashboardPreferences: () => api.get('/settings/dashboard/preferences'),
  updateDashboardPreferences: (widgets: { id: string; visible: boolean; order: number }[]) =>
    api.put('/settings/dashboard/preferences', { widgets }),
}

// ── Customer API ──────────────────────────────────────────────────────────────
export const customerApi = {
  list: (params?: Record<string, unknown>) => api.get('/customers/', { params }),
  get: (id: number) => api.get(`/customers/${id}`),
  create: (data: Record<string, unknown>) => api.post('/customers/', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/customers/${id}`, data),
  delete: (id: number) => api.delete(`/customers/${id}`),
}

// ── Questionnaire API ────────────────────────────────────────────────────────
const normalizePositiveId = (value: number | string | null | undefined) => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

const rejectInvalidQuestionnaireCustomerId = () =>
  Promise.reject(new Error('Valid customer id is required to load questionnaire'))

export const questionnaireApi = {
  listCustomers: (params?: Record<string, unknown>) => api.get('/questionnaire/customers', { params }),
  getCustomerQuestionnaire: (customerId: number | string | null | undefined, params?: Record<string, unknown>) => {
    const id = normalizePositiveId(customerId)
    if (!id) return rejectInvalidQuestionnaireCustomerId()
    return api.get(`/questionnaire/customers/${id}`, { params })
  },
  getSection: (customerId: number | string | null | undefined, sectionId: number, params?: Record<string, unknown>) => {
    const id = normalizePositiveId(customerId)
    if (!id) return rejectInvalidQuestionnaireCustomerId()
    return api.get(`/questionnaire/customers/${id}/sections/${sectionId}`, { params })
  },
  saveAnswers: (customerId: number | string | null | undefined, data: Record<string, unknown>) => {
    const id = normalizePositiveId(customerId)
    if (!id) return rejectInvalidQuestionnaireCustomerId()
    return api.post(`/questionnaire/customers/${id}/answers`, data)
  },
  uploadAnswerFile: (customerId: number | string | null | undefined, elementId: number, file: File) => {
    const id = normalizePositiveId(customerId)
    if (!id) return rejectInvalidQuestionnaireCustomerId()
    const fd = new FormData()
    fd.append('file', file, file.name)
    return api.post(`/questionnaire/customers/${id}/answers/${elementId}/upload`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  complete: (customerId: number | string | null | undefined, params?: Record<string, unknown>) => {
    const id = normalizePositiveId(customerId)
    if (!id) return rejectInvalidQuestionnaireCustomerId()
    return api.post(`/questionnaire/customers/${id}/complete`, null, { params })
  },
  reopen: (customerId: number | string | null | undefined, reason: string, params?: Record<string, unknown>) => {
    const id = normalizePositiveId(customerId)
    if (!id) return rejectInvalidQuestionnaireCustomerId()
    return api.post(`/questionnaire/customers/${id}/reopen`, { reason }, { params })
  },

  listQuestionnaires: () => api.get('/questionnaire/questionnaires'),
  createQuestionnaire: (data: Record<string, unknown>) => api.post('/questionnaire/questionnaires', data),
  updateQuestionnaire: (id: number, data: Record<string, unknown>) => api.put(`/questionnaire/questionnaires/${id}`, data),
  archiveQuestionnaire: (id: number) => api.patch(`/questionnaire/questionnaires/${id}/archive`),
  preview: (questionnaireId: number) => api.get('/questionnaire/preview', { params: { questionnaire_id: questionnaireId } }),
  publish: (questionnaireId: number) => api.post('/questionnaire/publish', null, { params: { questionnaire_id: questionnaireId } }),

  listStructure: (questionnaireId: number, includeInactive = false) =>
    api.get('/questionnaire/structure', { params: { questionnaire_id: questionnaireId, include_inactive: includeInactive } }),
  createStructure: (data: Record<string, unknown>) => api.post('/questionnaire/structure', data),
  updateStructure: (id: number, data: Record<string, unknown>) => api.put(`/questionnaire/structure/${id}`, data),
  setStructureStatus: (id: number, isActive: boolean) => api.patch(`/questionnaire/structure/${id}/status`, { is_active: isActive }),
  deleteStructure: (id: number) => api.delete(`/questionnaire/structure/${id}`),
  reorderStructure: (ids: number[]) => api.post('/questionnaire/structure/reorder', { ids }),

  listElements: (questionnaireId: number, subsectionId?: number, includeInactive = false) =>
    api.get('/questionnaire/elements', {
      params: { questionnaire_id: questionnaireId, subsection_id: subsectionId, include_inactive: includeInactive },
    }),
  getMasterOptions: (masterKey: string) => api.get('/questionnaire/elements/master-options', { params: { master_key: masterKey } }),
  createElement: (data: Record<string, unknown>) => api.post('/questionnaire/elements', data),
  updateElement: (id: number, data: Record<string, unknown>) => api.put(`/questionnaire/elements/${id}`, data),
  setElementStatus: (id: number, isActive: boolean) => api.patch(`/questionnaire/elements/${id}/status`, { is_active: isActive }),
  reorderElements: (ids: number[]) => api.post('/questionnaire/elements/reorder', { ids }),
}

// ── Lead API ──────────────────────────────────────────────────────────────────
export const leadApi = {
  list: (params?: Record<string, unknown>) => api.get('/leads/', { params }),
  get: (id: number) => api.get(`/leads/${id}`),
  create: (data: Record<string, unknown>) => api.post('/leads/', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/leads/${id}`, data),
  delete: (id: number) => api.delete(`/leads/${id}`),
  approve: (id: number, approved: boolean, notes?: string) =>
    api.post(`/leads/${id}/approve`, null, { params: { approved, notes } }),
  listSources: () => api.get('/leads/sources'),
  createSource: (name: string) => api.post('/leads/sources', null, { params: { name } }),
  listCompetitors: () => api.get('/leads/competitors'),
  createCompetitor: (name: string) => api.post('/leads/competitors', null, { params: { name } }),

  // ── Kanban
  kanban:       ()                                      => api.get('/leads/kanban'),
  updateStatus: (id: number, status: string)            => api.patch(`/leads/${id}/status`, { status }),
  updateProducts: (id: number, data: Record<string, unknown>) => api.put(`/leads/${id}/products`, data),
}

// ── Tender API ────────────────────────────────────────────────────────────────
export const tenderApi = {
  list: (params?: Record<string, unknown>) => api.get('/tenders/', { params }),
  get: (id: number) => api.get(`/tenders/${id}`),
  create: (data: Record<string, unknown>) => api.post('/tenders/', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/tenders/${id}`, data),
  delete: (id: number) => api.delete(`/tenders/${id}`),
  approve: (id: number, approved: boolean, notes?: string) =>
    api.post(`/tenders/${id}/approve`, null, { params: { approved, notes } }),
}

// ─── Consignee API ────────────────────────────────────────────────────────────

export const consigneeApi = {
  list: (tenderId: number) =>
    api.get('/consignees/', { params: { tender_id: tenderId } }),

  get: (id: number) =>
    api.get(`/consignees/${id}`),

  create: (data: {
    tender_id: number
    consignee_name: string
    address?: string
    city?: string
    state?: string
    pincode?: string
    contact_person?: string
    contact_phone?: string
    delivery_date?: string
    notes?: string
    max_count?: number
    items?: Array<{
      tender_product_id?: number | null
      product_name: string
      quantity: number
      unit?: string
      remarks?: string
    }>
  }) => api.post('/consignees/', data),

  update: (id: number, data: {
    consignee_name: string
    address?: string
    city?: string
    state?: string
    pincode?: string
    contact_person?: string
    contact_phone?: string
    delivery_date?: string
    notes?: string
    items?: Array<{
      tender_product_id?: number | null
      product_name: string
      quantity: number
      unit?: string
      remarks?: string
    }>
  }) => api.put(`/consignees/${id}`, data),

  delete: (id: number) =>
    api.delete(`/consignees/${id}`),

  downloadTemplate: () =>
    api.get('/consignees/template', { responseType: 'blob' }),

  bulkImport: (tenderId: number, file: File, maxImport?: number) => {
    const fd = new FormData()
    fd.append('file', file)
    const params = maxImport != null
      ? `tender_id=${tenderId}&max_import=${maxImport}`
      : `tender_id=${tenderId}`
    return api.post(
      `/consignees/bulk-import?${params}`,
      fd,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    )
  },
}

// ── Dashboard API ─────────────────────────────────────────────────────────────
export const dashboardApi = {
  get: () => api.get('/dashboard/'),
  getEmployee: () => api.get('/dashboard/employee'),
}

// ── WorkOrder API ─────────────────────────────────────────────────────────────
export const workorderApi = {
  list: (params?: Record<string, unknown>) => api.get('/workorders/', { params }),
  get: (id: number) => api.get(`/workorders/${id}`),
  getUsers: () => api.get(`/workorders/users`),
  create: (data: Record<string, unknown>) => api.post('/workorders/', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/workorders/${id}`, data),
  delete: (id: number) => api.delete(`/workorders/${id}`),
}

// ── OEM API ───────────────────────────────────────────────────────────────────
export const oemApi = {
  list: (params?: Record<string, unknown>) => api.get('/oems/', { params }),
  get: (id: number) => api.get(`/oems/${id}`),
  getcats: () => api.get(`/oems/categorys`),
  create: (data: Record<string, unknown>) => api.post('/oems/', data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/oems/${id}`, data),
}

// ── EMDBG API ─────────────────────────────────────────────────────────────────







// ── KAM API ───────────────────────────────────────────────────────────────────






// ── Notification API ──────────────────────────────────────────────────────────
export const notificationApi = {
  list: () => api.get('/notifications/'),
  markRead: (id: number) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),
}

// ── Travel API ────────────────────────────────────────────────────────────────









// ── Reports API ───────────────────────────────────────────────────────────────
const reportGet = (path: string, params?: Record<string, unknown>) =>
  api.get(path, { params, responseType: params?.export ? 'blob' : 'json' })

export const reportsApi = {
  getInsights: () => api.get('/reports/insights'),
  leads:      (params?: Record<string, unknown>) => reportGet('/reports/leads', params),
  tenders:    (params?: Record<string, unknown>) => reportGet('/reports/tenders', params),
  customers:  (params?: Record<string, unknown>) => reportGet('/reports/customers', params),
  opportunities: (params?: Record<string, unknown>) => reportGet('/reports/opportunities', params),
  quotations: (params?: Record<string, unknown>) => reportGet('/reports/quotations', params),
  workorders: (params?: Record<string, unknown>) => reportGet('/reports/workorders', params),
  emdbg:      (params?: Record<string, unknown>) => reportGet('/reports/emdbg', params),
  oem:        (params?: Record<string, unknown>) => reportGet('/reports/oem', params),
  competitors:(params?: Record<string, unknown>) => reportGet('/reports/competitors', params),
  kam:        (params?: Record<string, unknown>) => reportGet('/reports/kam', params),
  tada:       (params?: Record<string, unknown>) => reportGet('/reports/tada', params),
  travel:     (params?: Record<string, unknown>) => reportGet('/reports/travel', params),
  leadsFilterOptions: () => api.get('/reports/leads/filter-options'),
  tendersFilterOptions: () => api.get('/reports/tenders/filter-options'),
  customersFilterOptions: () => api.get('/reports/customers/filter-options'),
  opportunitiesFilterOptions: () => api.get('/reports/opportunities/filter-options'),
  quotationsFilterOptions: () => api.get('/reports/quotations/filter-options'),
  workordersFilterOptions: () => api.get('/reports/workorders/filter-options'),
  emdbgFilterOptions: () => api.get('/reports/emdbg/filter-options'),
  kamFilterOptions: () => api.get('/reports/kam/filter-options'),
  tadaFilterOptions: () => api.get('/reports/tada/filter-options'),
  travelFilterOptions: () => api.get('/reports/travel/filter-options'),
  savedViews: (reportType?: string) =>
    api.get('/reports/saved-views', { params: reportType ? { report_type: reportType } : {} }),
  createSavedView: (data: Record<string, unknown>) => api.post('/reports/saved-views', data),
  updateSavedView: (id: number, data: Record<string, unknown>) => api.put(`/reports/saved-views/${id}`, data),
  deleteSavedView: (id: number) => api.delete(`/reports/saved-views/${id}`),
}

// ── Platform API (Super Admin) ────────────────────────────────────────────────
export const platformApi = {
  login: (username: string, password: string) =>
    api.post('/platform/login', { username, password }),
  listTenants: () => api.get('/platform/tenants'),
  createTenant: (data: Record<string, unknown>) => api.post('/platform/tenants', data),
  updateTenant: (id: number, data: Record<string, unknown>) => api.put(`/platform/tenants/${id}`, data),
  suspendTenant: (id: number) => api.delete(`/platform/tenants/${id}`),
  stats: () => api.get('/platform/stats'),
  listPlans: () => api.get('/platform/plans'),
  createPlan: (data: Record<string, unknown>) => api.post('/platform/plans', data),
}

// ── Travel & TA/DA ─────────────────────────────────────────────────────────────
export const travelApi = {
  listRequests: (status?: string) => api.get(`/travel/requests${status ? `?status_filter=${status}` : ''}`),
  createRequest: (data: any) => api.post('/travel/requests', data),
  submitRequest: (id: number) => api.post(`/travel/requests/${id}/submit`),
  decideRequest: (id: number, data: any) => api.post(`/travel/requests/${id}/decision`, data),
  listClaims: (status?: string) => api.get(`/travel/tada${status ? `?status_filter=${status}` : ''}`),
  createClaim: (data: any) => api.post('/travel/tada', data),
  submitClaim: (id: number) => api.post(`/travel/tada/${id}/submit`),
  managerDecide: (id: number, data: any) => api.post(`/travel/tada/${id}/manager-decision`, data),
  accountsDecide: (id: number, data: any) => api.post(`/travel/tada/${id}/accounts-decision`, data),
  pendingApprovals: () => api.get('/travel/pending-approvals'),
}


// ── EMD/BG ────────────────────────────────────────────────────────────────────
export const emdbgApi = {
  list: (filter?: string) => api.get(`/emdbg${filter ? `?expiry_filter=${filter}` : ''}`),
  create: (data: any) => api.post('/emdbg', data),
  requestApproval: (id: number) => api.post(`/emdbg/${id}/request-approval`),
  approve: (id: number, data: any) => api.post(`/emdbg/${id}/approve`, data),
  renew: (id: number, data: any) => api.post(`/emdbg/${id}/renew`, data),
  release: (id: number, data: any) => api.post(`/emdbg/${id}/release`, data),
  summary: () => api.get('/emdbg/expiry-summary'),
}

// ── RFP AI ────────────────────────────────────────────────────────────────────
export const rfpApi = {
  list: (tenderId?: number) => api.get(`/rfp${tenderId ? `?tender_id=${tenderId}` : ''}`),
  analyze: (formData: FormData) => api.post('/rfp/analyze', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  get: (id: number) => api.get(`/rfp/${id}`),
}

// ── Document Management ──────────────────────────────────────────────────────
export const documentManagementApi = {
  list: (params?: Record<string, unknown>) =>
    api.get('/document-management', { params, ...withPassiveSessionActivity() }),
  upload: (formData: FormData) =>
    api.post('/document-management/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  linkOptions: (source: string, params?: Record<string, unknown>) =>
    api.get('/document-management/link-options', { params: { ...(params || {}), source } }),
  toggleStar: (documentId: string) =>
    api.post('/document-management/star', { document_id: documentId }),
  getShares: (documentId: string) =>
    api.get('/document-management/shares', { params: { document_id: documentId } }),
  share: (documentId: string, userIds: number[]) =>
    api.post('/document-management/share', { document_id: documentId, user_ids: userIds }),
  move: (documentId: string, folderId: number | null) =>
    api.post(`/document-management/${encodeURIComponent(documentId)}/move`, { folder_id: folderId }),
  trash: (documentId: string) =>
    api.post(`/document-management/${encodeURIComponent(documentId)}/trash`),
  submitForApproval: (documentId: string) =>
    api.post(`/document-management/${encodeURIComponent(documentId)}/submit-approval`),
  approveDocument: (documentId: string, comment?: string) =>
    api.post(`/document-management/${encodeURIComponent(documentId)}/approve`, { comment: comment || undefined }),
  rejectDocument: (documentId: string, reason: string) =>
    api.post(`/document-management/${encodeURIComponent(documentId)}/reject`, { reason }),
  restore: (documentId: string) =>
    api.post(`/document-management/${encodeURIComponent(documentId)}/restore`),
  deletePermanently: (documentId: string) =>
    api.delete(`/document-management/${encodeURIComponent(documentId)}`),
  listFolders: () =>
    api.get('/document-management/folders'),
  createFolder: (data: { name: string; parent_id?: number | null }) =>
    api.post('/document-management/folders', data),
  renameFolder: (folderId: number, data: { name: string }) =>
    api.put(`/document-management/folders/${folderId}`, data),
  deleteFolder: (folderId: number) =>
    api.delete(`/document-management/folders/${folderId}`),
}

// Recycle Bin
export type RecycleBinItem = {
  id: string
  module_key: string
  module_label: string
  record_id: string
  title: string
  subtitle?: string | null
  deleted_at?: string | null
  deleted_by?: number | null
  deleted_by_name?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export type RestoredRecycleBinItem = {
  id: string
  module_key: string
  module_label: string
  record_id: string
  title: string
  restored_at?: string | null
  restored_by_name?: string | null
}

export type RecycleBinResponse = {
  items: RecycleBinItem[]
  counts: Record<string, number>
  total: number
  page: number
  restored_counts: Record<string, number>
  actors: Array<{ id: number; name: string }>
  restored_count: number
  restored_items: RestoredRecycleBinItem[]
  modules: Array<{ key: string; label: string }>
}

export const recycleBinApi = {
  bulk: (action: 'restore' | 'delete', items: Array<{ module_key: string; record_id: string }>) =>
    api.post<{ results: Array<{ module_key: string; record_id: string; success: boolean; error?: string }> }>(`/recycle-bin/bulk/${action}`, { items }),
  list: (params?: { module?: string; search?: string; limit?: number; page?: number; view?: string; deleted_by?: number; date_from?: string; date_to?: string }) =>
    api.get<RecycleBinResponse>('/recycle-bin', { params, ...withPassiveSessionActivity() }),
  restore: (moduleKey: string, recordId: string) =>
    api.post(`/recycle-bin/${encodeURIComponent(moduleKey)}/${encodeURIComponent(recordId)}/restore`),
  deletePermanently: (moduleKey: string, recordId: string) =>
    api.delete(`/recycle-bin/${encodeURIComponent(moduleKey)}/${encodeURIComponent(recordId)}`),
}

// ── KAM ───────────────────────────────────────────────────────────────────────
export const kamApi = {
  listActivities: (params?: Record<string, any>) => api.get('/kam/activities', { params }),
  createActivity: (data: any) => api.post('/kam/activities', data),
  updateActivity: (id: number, data: any) => api.put(`/kam/activities/${id}`, data),
  deleteActivity: (id: number) => api.delete(`/kam/activities/${id}`),
  getPerformance: (userId?: number, period?: string) => api.get('/kam/performance', { params: { user_id: userId, period } }),
  teamPerformance: (period?: string) => api.get('/kam/team-performance', { params: { period } }),
  setTarget: (data: any) => api.post('/kam/targets', data),
  visitCoverage: (params?: Record<string, any>) => api.get('/kam/visit-coverage', { params }),
  userLocationDaySummary: (params?: Record<string, any>) => api.get('/kam/user-location-day-summary', { params }),
  userLocationDayMap: (params?: Record<string, any>) => api.get('/kam/user-location-day-map', { params }),
}

// ── Masters ───────────────────────────────────────────────────────────────────
export const mastersApi = {
  leadSources: () => api.get('/masters/lead-sources'),
  createLeadSource: (data: any) => api.post('/masters/lead-sources', data),
  competitors: () => api.get('/masters/competitors'),
  createCompetitor: (data: any) => api.post('/masters/competitors', data),
  products: () => api.get('/masters/products'),
  createProduct: (data: any) => api.post('/masters/products', data),
  verticalSectors: () => api.get('/masters/vertical-sectors'),
  createVerticalSector: (data: any) => api.post('/masters/vertical-sectors', data),
  oems: () => api.get('/masters/oems'),
  createOEM: (data: any) => api.post('/masters/oems', data),
  settings: (category?: string) => api.get(`/masters/settings${category ? `?category=${category}` : ''}`),
  updateSetting: (key: string, value: string) => api.put(`/masters/settings/${key}`, { value }),
  updateSettings: (data: Record<string, any>) => api.put('/masters/settings', data),
  pincodeLookup: (pincode: string) => api.get(`/masters/pincode/${pincode}`),
  usersForSelect: (roles?: string) => api.get(`/masters/users-for-select${roles ? `?roles=${roles}` : ''}`),
  approvalRules: () => api.get('/masters/approval-rules'),
  alertRules: () => api.get('/masters/alert-rules'),
}

// ── Integrations (WhatsApp / Email / Telephone) ────────────────────────────────
export const integrationsApi = {
  getConfig:      () => api.get('/integrations/config'),
  updateConfig:   (data: Record<string, unknown>) => api.put('/integrations/config', data),
  getLogs:        (params?: Record<string, unknown>) => api.get('/integrations/logs', { params }),
  getWebhookInfo: () => api.get('/integrations/webhook-info'),
}


// ─── Approval Workflow API ────────────────────────────────────────────────────

export const approvalWorkflowApi = {
  getMeta: () =>
    api.get('/approval-workflows/meta'),

  getEscalationSettings: () =>
    api.get('/approval-workflows/escalation/settings'),

  updateEscalationSettings: (data: {
    is_enabled: boolean
    default_escalation_minutes?: number | null
  }) => api.put('/approval-workflows/escalation/settings', data),

  listEscalationRules: () =>
    api.get('/approval-workflows/escalation/rules'),

  createEscalationRule: (data: {
    module_key: string
    action_key: string
    approver_role: string
    escalation_minutes: number
    is_active: boolean
  }) => api.post('/approval-workflows/escalation/rules', data),

  updateEscalationRule: (ruleId: number, data: {
    module_key: string
    action_key: string
    approver_role: string
    escalation_minutes: number
    is_active: boolean
  }) => api.put(`/approval-workflows/escalation/rules/${ruleId}`, data),

  setEscalationRuleStatus: (ruleId: number, is_active: boolean) =>
    api.patch(`/approval-workflows/escalation/rules/${ruleId}/status`, { is_active }),

  deleteEscalationRule: (ruleId: number) =>
    api.delete(`/approval-workflows/escalation/rules/${ruleId}`),

  listRules: () =>
    api.get('/approval-workflows/rules'),

  createRule: (data: {
    module_key?: string
    action_key?: string
    module_keys?: string[]
    action_keys?: string[]
    name?: string
    requester_type: 'role' | 'specific_user' | 'group'
    requester_role?: string | null
    requester_roles?: string[]
    requester_user_id?: number | null
    requester_user_ids?: number[]
    requester_group_id?: number | null
    requester_group_ids?: number[]
    is_active: boolean
    approval_type: string
    steps: Array<{
      step_no: number
      approver_type: 'reporting_manager' | 'role' | 'specific_user' | 'hierarchy_level'
      approver_role?: string | null
      approver_user_id?: number | null
      approver_level?: number | null
      is_required: boolean
      stop_on_reject: boolean
    }>
  }) => api.post('/approval-workflows/rules', data),

  updateRule: (ruleId: number, data: {
    module_key?: string
    action_key?: string
    module_keys?: string[]
    action_keys?: string[]
    name?: string
    requester_type: 'role' | 'specific_user' | 'group'
    requester_role?: string | null
    requester_roles?: string[]
    requester_user_id?: number | null
    requester_user_ids?: number[]
    requester_group_id?: number | null
    requester_group_ids?: number[]
    is_active: boolean
    approval_type: string
    steps: Array<{
      step_no: number
      approver_type: 'reporting_manager' | 'role' | 'specific_user' | 'hierarchy_level'
      approver_role?: string | null
      approver_user_id?: number | null
      approver_level?: number | null
      is_required: boolean
      stop_on_reject: boolean
    }>
  }) => api.put(`/approval-workflows/rules/${ruleId}`, data),

  setRuleStatus: (ruleId: number, is_active: boolean) =>
    api.patch(`/approval-workflows/rules/${ruleId}/status`, { is_active }),

  deleteRule: (ruleId: number) =>
    api.delete(`/approval-workflows/rules/${ruleId}`),

  updateStepEscalation: (ruleId: number, stepId: number, escalation_minutes: number | null) =>
    api.patch(`/approval-workflows/rules/${ruleId}/steps/${stepId}/escalation`, { escalation_minutes }),

  listPendingRequests: () =>
    api.get('/approval-workflows/requests/pending'),

  listHistory: (params?: { module_key?: string; record_id?: number; page?: number; per_page?: number }) =>
    api.get('/approval-workflows/requests/history', { params }),

  createRequest: (data: { module_key: string; action_key: string; record_id: number; group_id?: number | null }) =>
    api.post('/approval-workflows/requests', data),

  decideRequest: (approvalRequestId: number, data: { decision: 'approved' | 'rejected'; remarks?: string }) =>
    api.post(`/approval-workflows/requests/${approvalRequestId}/decision`, data),

  getAutoApproveSettings: () =>
    api.get('/approval-workflows/auto-approve/settings'),

  updateAutoApproveSetting: (data: { module_key: string; action_key: string; is_enabled: boolean }) =>
    api.put('/approval-workflows/auto-approve/settings', data),
}

export default api

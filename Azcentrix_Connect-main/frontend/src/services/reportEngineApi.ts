import api from './api'

const BASE = '/reports/engine'

export interface ReportType {
  id: number
  key: string
  name: string
  description: string | null
  base_table: string
  base_module_key?: string | null
  base_module_label?: string | null
  data_scope_module?: string | null
  module_permission_key: string | null
  default_date_field: string
  supports_charts: boolean
  supports_grouping: boolean
}

export interface ReportModuleParent {
  module_key: string
  label: string
  sort_order: number
}

export interface ReportModuleChild {
  module_key: string
  label: string
  module_label: string
  description: string | null
  report_type_key: string
  report_type_name: string
  parent_module: string
  child_modules: string[]
  module_chain: string[]
  chain?: string[]
  chain_key: string
  level: number
  can_continue: boolean
}

export interface ReportModuleRelations {
  parent_modules: ReportModuleParent[]
  selected_parent: string | null
  child_modules: ReportModuleChild[]
}

export interface ReportModuleChildrenResponse {
  parent_module: string
  chain: string[]
  child_modules: ReportModuleChild[]
}

export interface ReportTypeField {
  id: number
  field_key: string
  label: string
  module_key: string
  module_label: string
  data_type: 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'boolean' | 'enum'
  is_default_column: boolean
  is_filterable: boolean
  is_groupable: boolean
  is_sortable: boolean
  is_aggregatable: boolean
  allowed_operators: string[] | null
  enum_values: string[] | null
  format: string | null
  display_order?: number
  drilldown_kind?: 'detail' | 'report' | null
  drilldown_target?: string | null
  drilldown_id_field?: string | null
  drilldown_filter_field?: string | null
}

export interface BusinessReportModuleOption {
  module_key: string
  label: string
  sort_order?: number
}

export interface BusinessReportCombination {
  primary_module: string
  primary_module_label?: string
  related_modules: string[]
  related_module_labels?: string[]
  module_chain: string[]
  report_type_key: string
  fields_endpoint: string
}

export interface BusinessReportTemplate {
  template_key: string
  template_name: string
  category: string
  category_label: string
  description: string | null
  primary_module: string
  primary_module_label: string
  allowed_related_modules: BusinessReportModuleOption[]
  default_related_modules: string[]
  default_report_type_key: string
  default_module_chain: string[]
  fields_endpoint: string
  default_fields: string[]
  permission_keys: string[]
}

export interface BusinessReportTemplateDetail extends BusinessReportTemplate {
  allowed_combinations: BusinessReportCombination[]
  available_combinations: BusinessReportCombination[]
  report_type_key_map?: Array<{
    module_chain: string[]
    primary_module: string
    related_modules: string[]
    report_type_key: string
  }>
}

export interface BusinessReportCategory {
  category_key: string
  label: string
  sort_order: number
  templates: BusinessReportTemplate[]
}

export interface BusinessReportTemplatesResponse {
  categories: BusinessReportCategory[]
  templates: BusinessReportTemplate[]
}

export interface BusinessTemplateResolveResponse {
  template_key: string
  template_name: string
  category: string
  category_label: string
  description: string | null
  primary_module: string
  primary_module_label: string
  related_modules: string[]
  related_module_labels: string[]
  report_type_key: string
  module_chain: string[]
  chain_key: string
  fields_endpoint: string
  default_fields: string[]
  permission_keys: string[]
}

export interface ReportFolder {
  id: number
  name: string
  description: string | null
  parent_id: number | null
  is_system: boolean
  visibility: string
  created_by: number | null
}

export interface FilterItem {
  field: string
  operator: string
  value: unknown
}

export interface SortItem {
  field: string
  direction: 'asc' | 'desc'
}

export interface ReportConfig {
  report_type_key?: string
  template_key?: string
  primary_module?: string
  related_modules?: string[]
  parent_module?: string
  module_chain?: string[]
  child_modules?: string[]
  chain_key?: string
  fields?: string[]
  filters?: FilterItem[]
  // Drilldown-only filters (e.g. the id from a clicked customer_name/lead_title/etc.).
  // Never sent to Save Report / Save Filter — locked in the UI, always merged into requests.
  locked_filters?: FilterItem[]
  sort?: SortItem[]
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface SavedReport {
  id: number
  name: string
  description: string | null
  report_type_id: number | null
  report_type_key: string | null
  folder_id: number | null
  is_system: boolean
  visibility: 'private' | 'org'
  is_clone_of: number | null
  config_json: ReportConfig | null
  chart_config_json: Record<string, unknown> | null
  created_by: number | null
  created_at: string | null
  updated_at?: string | null
  last_run_at: string | null
  last_accessed_at: string | null
  run_count: number
  can_edit: boolean
}

export interface ReportResult {
  report_type: string
  total: number
  page: number
  per_page: number
  pages: number
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface SavedFilterConfig {
  quick_filters?: Record<string, unknown>
  advanced_filters?: FilterItem[]
}

export interface SavedFilter {
  id: number
  report_type_key: string
  filter_name: string
  filter_type: 'quick' | 'advanced' | 'mixed'
  visibility: 'private' | 'org'
  config_json: SavedFilterConfig
  created_by: number | null
  created_at: string | null
  can_edit: boolean
}

export const reportEngineApi = {
  getBusinessTemplates: () =>
    api.get<BusinessReportTemplatesResponse>(`${BASE}/business-templates`),

  getBusinessTemplate: (templateKey: string) =>
    api.get<BusinessReportTemplateDetail>(`${BASE}/business-templates/${templateKey}`),

  resolveBusinessTemplate: (data: {
    template_key: string
    primary_module: string
    related_modules: string[]
  }) => api.post<BusinessTemplateResolveResponse>(`${BASE}/business-templates/resolve`, data),

  getModuleRelations: (parent_module?: string) =>
    api.get<ReportModuleRelations>(`${BASE}/module-relations`, {
      params: parent_module ? { parent_module } : undefined,
    }),

  getModuleRelationChildren: (parent_module: string, chain: string[]) =>
    api.get<ReportModuleChildrenResponse>(`${BASE}/module-relations/children`, {
      params: {
        parent_module,
        chain: chain.join(','),
      },
    }),

  getTypes: () => api.get<ReportType[]>(`${BASE}/types`),

  getTypeFields: (key: string) =>
    api.get<ReportTypeField[]>(`${BASE}/types/${key}/fields`),

  getFilterValues: (key: string, field: string, q?: string) =>
    api.get<{ field: string; values: string[]; source: 'enum' | 'data' | 'unsupported' }>(
      `${BASE}/types/${key}/filter-values`,
      { params: q ? { field, q } : { field } },
    ),

  getFolders: () => api.get<ReportFolder[]>(`${BASE}/folders`),

  createFolder: (data: {
    name: string
    description?: string
    parent_id?: number
    visibility?: string
  }) => api.post<{ id: number; name: string }>(`${BASE}/folders`, data),

  deleteFolder: (id: number) => api.delete(`${BASE}/folders/${id}`),

  getSaved: (params?: { folder_id?: number; report_type_key?: string }) =>
    api.get<SavedReport[]>(`${BASE}/saved`, { params }),

  getSavedById: (id: number) =>
    api.get<SavedReport>(`${BASE}/saved/${id}`),

  createSaved: (data: {
    name: string
    description?: string
    report_type_key?: string
    report_type_id?: number
    folder_id?: number
    visibility?: 'private' | 'org'
    config_json?: ReportConfig
    chart_config_json?: Record<string, unknown>
  }) => api.post<{ id: number; name: string }>(`${BASE}/saved`, data),

  updateSaved: (
    id: number,
    data: {
      name?: string
      description?: string
      folder_id?: number
      config_json?: ReportConfig
      chart_config_json?: Record<string, unknown>
    },
  ) => api.put<{ id: number; name: string }>(`${BASE}/saved/${id}`, data),

  cloneSaved: (id: number) =>
    api.post<{ id: number; name: string }>(`${BASE}/saved/${id}/clone`),

  deleteSaved: (id: number) =>
    api.delete(`${BASE}/saved/${id}`),

  setVisibility: (id: number, visibility: 'private' | 'org') =>
    api.patch<{ id: number; visibility: string }>(
      `${BASE}/saved/${id}/visibility`,
      { visibility },
    ),

  runAdhoc: (body: {
    report_type?: string
    report_type_key?: string
    template_key?: string
    primary_module?: string
    related_modules?: string[]
    parent_module?: string
    module_chain?: string[]
    child_modules?: string[]
    fields?: string[]
    filters?: FilterItem[]
    sort?: SortItem[]
    date_from?: string
    date_to?: string
    page?: number
    per_page?: number
  }) => api.post<ReportResult>(`${BASE}/run`, body),

  runSaved: (id: number, params?: { page?: number; per_page?: number }) =>
    api.post<ReportResult>(`${BASE}/saved/${id}/run`, null, { params }),

  exportSaved: (id: number, fmt: 'csv' = 'csv') =>
    api.post(`${BASE}/saved/${id}/export`, null, {
      params: { fmt },
      responseType: 'blob',
    }),

  getSavedFilters: (report_type_key: string) =>
    api.get<SavedFilter[]>(`${BASE}/saved-filters`, { params: { report_type_key } }),

  createSavedFilter: (data: {
    report_type_key: string
    filter_name: string
    filter_type?: 'quick' | 'advanced' | 'mixed'
    visibility?: 'private' | 'org'
    config_json: SavedFilterConfig
  }) => api.post<{ id: number; filter_name: string }>(`${BASE}/saved-filters`, data),

  updateSavedFilter: (
    id: number,
    data: {
      filter_name?: string
      filter_type?: 'quick' | 'advanced' | 'mixed'
      visibility?: 'private' | 'org'
      config_json?: SavedFilterConfig
    },
  ) => api.put<{ id: number; filter_name: string }>(`${BASE}/saved-filters/${id}`, data),

  deleteSavedFilter: (id: number) =>
    api.delete(`${BASE}/saved-filters/${id}`),
}

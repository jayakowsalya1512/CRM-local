import { Suspense, lazy, Component, ReactNode, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useState } from 'react'
import { useAuthStore } from '@/store'
import { loadPermissions, usePermissions } from '@/hooks'
import AppLayout from '@/components/layout/AppLayout'
import { ToastProvider } from '@/components/ui/ToastContext'
import { authApi, refreshAuthSession } from '@/services/api'
import { useTheme } from '@/hooks/UseTheme'
import { isTokenExpired } from '@/utils/auth'
import { usePlatformAuthStore } from '@/store/platformAuthStore'
import LogoWriteLoader from '@/components/ui/LogoWriteLoader'

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Lazy pages Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const LoginPage = lazy(() => import('@/pages/LoginPage'))
const MaintenancePage = lazy(() => import('@/pages/MaintenancePage'))
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('@/pages/ResetPasswordPage'))
const PrivacyPolicyPage = lazy(() => import('@/pages/PrivacyPolicyPage'))
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'))
const QuestionnairePage = lazy(() => import('@/pages/questionnaire/QuestionnairePage'))
const CustomerQuestionnaireListPage = lazy(() => import('@/pages/questionnaire/CustomerQuestionnaireListPage'))
const CustomerQuestionnaireEntryPage = lazy(() => import('@/pages/questionnaire/CustomerQuestionnaireEntryPage'))
const CustomerQuestionnaireFormPage = lazy(() => import('@/pages/questionnaire/CustomerQuestionnaireFormPage'))
const QuestionnaireFormBuilderPage = lazy(() => import('@/pages/questionnaire/QuestionnaireFormBuilderPage'))
// Customers & Contacts (prototype v17): list with saved views, Customer 360 and the prototype customer form page.
const TeamChatPage = lazy(() => import('@/pages/chat/TeamChatPage'))
const CustomerListPage = lazy(() => import('@/pages/customers/CustomersListPage'))
const Customer360Page = lazy(() => import('@/pages/customers/Customer360Page'))
const CustomerForm = lazy(() => import('@/pages/customers/CustomerForm'))
const LeadsListV17 = lazy(() => import('@/pages/leads/LeadsListPage'))
const LeadFormV17 = lazy(() => import('@/pages/leads/LeadFormV17'))
const CaptureFormsPage = lazy(() => import('@/pages/capture/CaptureFormsPage'))
const DealsListV17 = lazy(() => import('@/pages/deals/DealsListPage'))
const DealFormV17 = lazy(() => import('@/pages/deals/DealFormV17'))
const TendersListV17 = lazy(() => import('@/pages/tenders/TendersListPage'))
const TenderFormV17 = lazy(() => import('@/pages/tenders/TenderFormV17'))
const TenderPageV17 = lazy(() => import('@/pages/tenders/TenderPage'))
const ConsigneesPage = lazy(() => import('@/pages/consignees/ConsigneesPage'))
// Orders & Projects – prototype v17 (list + board, order drawer with milestones & billing, full-page form, order lifecycles)
const OrdersListV17 = lazy(() => import('@/pages/orders/OrdersListPage'))
const OrderFormV17  = lazy(() => import('@/pages/orders/OrderFormV17'))
// Guarantees & Deposits – prototype v18 (outstanding + KPIs, Register / Awaiting approval / Finance desk / Expiry & alerts / By tender, drawer, request modal)
const GuaranteesV18 = lazy(() => import('@/pages/instruments/GuaranteesPage'))

const KAMPage = lazy(() => import('@/pages/kam/KAMPage'))
// Field Sales 360 – prototype v17: seven tabs (Team overview … Territories) + full-page Log activity composer
const FieldSales360Page = lazy(() => import('@/pages/kam/fieldsales/FieldSales360Page'))
const FieldSalesLogActivity = lazy(() => import('@/pages/kam/fieldsales/LogActivityPage'))
const TravelTADAPage = lazy(() => import('@/pages/travel/TravelTADAPage'))
const TADAPage = lazy(() => import('@/pages/tada/TADAPage'))
// Travel & Expense – prototype v17: tabs Requests · Expense claims · Calendar, trip drawer, full-page New / Edit trip
const TravelExpenseV17 = lazy(() => import('@/pages/travel/v17/TravelExpensePage'))
const TripFormV17 = lazy(() => import('@/pages/travel/v17/TripFormV17'))
const RFPPage = lazy(() => import('@/pages/rfp/RFPPage'))
const DocumentManagementPage = lazy(() => import('@/pages/document-management/DocumentManagementPage'))
const LetterManagementPage = lazy(() => import('@/pages/letter-management/LetterManagementPage'))
const AuditLogPage = lazy(() => import('@/pages/audit-logs/AuditLogPage'))
const RecycleBinPage = lazy(() => import('@/pages/recycle-bin/RecycleBinPage'))
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage'))
// Reports – prototype v17 (Intelligence → Reports): Catalogue (21 ready-made + custom reports) and Builder
const ReportsV17Page = lazy(() => import('@/pages/reports/v17/ReportsPage'))
// Analytics – prototype v17 (Intelligence → Analytics): nine tabs for a fiscal year, FY selector and Share
const AnalyticsV17Page = lazy(() => import('@/pages/analytics/v17/AnalyticsPage'))
const ReportEnginePage = lazy(() => import('@/pages/report-engine/ReportEnginePage'))
const AlertsPage = lazy(() => import('@/pages/alerts/AlertsPage'))
const NotificationsPage = lazy(() => import('@/pages/notifications/InboxNotificationsPage'))
const CalendarTasksPage = lazy(() => import('@/pages/calendar/CalendarTasksPage'))
const NotesPinboardPage = lazy(() => import('@/pages/notes/NotesPinboardPage'))
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage'))
const AppSettingsPage = lazy(() => import('@/pages/settings/AppSettingsPage'))
const UsersTeamsPage = lazy(() => import('@/pages/settings/UsersTeamsPage'))
const RolesSecurityPage = lazy(() => import('@/pages/roles/RolesSecurityPage'))
const StudioPage = lazy(() => import('@/pages/form-builder/StudioPage'))
const MarketplacePage = lazy(() => import('@/pages/integrations/MarketplacePage'))
const MastersV17Page = lazy(() => import('@/pages/masters/MastersV17Page'))
const ApprovalsV18Page = lazy(() => import('@/pages/approvals/ApprovalsV18Page'))
const DocumentHubPage = lazy(() => import('@/pages/document-management/DocumentHubPage'))
const AutomationStudioPage = lazy(() => import('@/pages/automation/AutomationStudioPage'))
const FunnelAnalyticsPage = lazy(() => import('@/pages/intelligence/FunnelAnalyticsPage'))
const CorrespondencePage = lazy(() => import('@/pages/letter-management/CorrespondencePage'))
const DataHubPage = lazy(() => import('@/pages/datahub/DataHubPage'))
const ProcessDesignerPage = lazy(() => import('@/pages/process/ProcessDesignerPage'))
const PartnersOemPage = lazy(() => import('@/pages/directory/PartnersOemPage'))
const CompetitorsIntelPage = lazy(() => import('@/pages/directory/CompetitorsIntelPage'))
const UsersPage = lazy(() => import('@/pages/settings/UsersPage'))
const UserListPage = lazy(() => import('@/pages/settings/UserListPage'))
const UserFormPage = lazy(() => import('@/pages/settings/UserFormPage'))
const IntegrationsPage = lazy(() => import('@/pages/settings/IntegrationsPage'))
const ProfilePage = lazy(() => import('@/pages/settings/ProfilePage'))
const RolesPage = lazy(() => import('@/pages/roles/Rolespage'))
const FormBuilderPage = lazy(() => import('@/pages/form-builder/FormBuilderPage'))
const MastersPage = lazy(() => import('@/pages/masters/MastersPage'))
const CompetitorsPage = lazy(() => import('@/pages/competitors/CompetitorsPage'))
const CompetitorListPage = lazy(() => import('@/pages/competitors/CompetitorListPage'))
const CompetitorFormPage = lazy(() => import('@/pages/competitors/CompetitorFormPage'))
const PlatformPage = lazy(() => import('@/pages/platform/PlatformPage'))
const OEMPage = lazy(() => import('@/pages/oems/OEMPage'))
const OEMListPage = lazy(() => import('@/pages/oems/OEMListPage'))
const OEMFormPage = lazy(() => import('@/pages/oems/OEMFormPage'))
const ApprovalsPage = lazy(() => import('@/pages/approvals/ApprovalsPage'))
const ApprovalWorkflowPage = lazy(() => import('@/pages/approvalWorkflow/ApprovalWorkflowPage'))
const InsightsPage = lazy(() => import('@/pages/AiInsights/InsightsPage'))
const PlatformLoginPage = lazy(() => import('@/pages/platform/PlatformLoginPage'))
const PlatformForgotPasswordPage = lazy(() => import('@/pages/platform/PlatformForgotPasswordPage'))
const PlatformProfilePage = lazy(() => import('@/pages/platform/PlatformProfilePage'))
const PlatformDashboardPage = lazy(() => import('@/pages/platform/PlatformDashboardPage'))
const PlatformCommandCenterPage = lazy(() => import('@/pages/platform/PlatformCommandCenterPage'))
const PlatformTenantsPage = lazy(() => import('@/pages/platform/PlatformTenantsPage'))
const PlatformTenantDetailPage = lazy(() => import('@/pages/platform/PlatformTenantDetailPage'))
const PlatformTenantGroupDetailPage = lazy(() => import('@/pages/platform/PlatformTenantGroupDetailPage'))
const PlatformOnboardingPage = lazy(() => import('@/pages/platform/PlatformOnboardingPage'))
const PlatformControlCenterPage = lazy(() => import('@/pages/platform/PlatformControlCenterPage'))
const PlatformSubscriptionsPage = lazy(() => import('@/pages/platform/PlatformSubscriptionsPage'))
const PlatformPlansPage = lazy(() => import('@/pages/platform/PlatformPlansPage'))
const PlatformServicesPage = lazy(() => import('@/pages/platform/PlatformServicesPage'))
const PlatformFeatureMatrixPage = lazy(() => import('@/pages/platform/PlatformFeatureMatrixPage'))
const PlatformRolesPage = lazy(() => import('@/pages/platform/PlatformRolesPage'))
const PlatformApprovalQueuePage = lazy(() => import('@/pages/platform/PlatformApprovalQueuePage'))
const PlatformBackupsPage = lazy(() => import('@/pages/platform/PlatformBackupsPage'))
const PlatformAnnouncementsPage = lazy(() => import('@/pages/platform/PlatformAnnouncementsPage'))
const PlatformEnvironmentsPage = lazy(() => import('@/pages/platform/PlatformEnvironmentsPage'))
const PlatformRegionsPage = lazy(() => import('@/pages/platform/PlatformRegionsPage'))
const PlatformDiscountsPage = lazy(() => import('@/pages/platform/PlatformDiscountsPage'))
const PlatformCostMarginPage = lazy(() => import('@/pages/platform/PlatformCostMarginPage'))
const PlatformSlaPage = lazy(() => import('@/pages/platform/PlatformSlaPage'))
const PlatformRateLimitsPage = lazy(() => import('@/pages/platform/PlatformRateLimitsPage'))
const CsatRatingPage = lazy(() => import('@/pages/CsatRatingPage'))
const PlatformInvoicesPage = lazy(() => import('@/pages/platform/PlatformInvoicesPage'))
const PlatformAddonsPage = lazy(() => import('@/pages/platform/PlatformAddonsPage'))
const PlatformDatabasesPage = lazy(() => import('@/pages/platform/PlatformDatabasesPage'))
const PlatformMonitoringPage = lazy(() => import('@/pages/platform/PlatformMonitoringPage'))
const PlatformUsageMonitoringPage = lazy(() => import('@/pages/platform/PlatformUsageMonitoringPage'))
const PlatformStoragePage = lazy(() => import('@/pages/platform/PlatformStoragePage'))
const PlatformDataTransferPage = lazy(() => import('@/pages/platform/PlatformDataTransferPage'))
const PlatformLogsPage = lazy(() => import('@/pages/platform/PlatformLogsPage'))
const PlatformJobsPage = lazy(() => import('@/pages/platform/PlatformJobsPage'))
const PlatformBillingPage = lazy(() => import('@/pages/platform/PlatformBillingPage'))
const PlatformEntitlementsPage = lazy(() => import('@/pages/platform/PlatformEntitlementsPage'))
const PlatformWorkflowTemplatesPage = lazy(() => import('@/pages/platform/PlatformWorkflowTemplatesPage'))
const PlatformSecurityPage = lazy(() => import('@/pages/platform/PlatformSecurityPage'))
const PlatformTrustSafetyPage = lazy(() => import('@/pages/platform/PlatformTrustSafetyPage'))
const PlatformAuditTrailPage = lazy(() => import('@/pages/platform/PlatformAuditTrailPage'))
const PlatformSupportPage = lazy(() => import('@/pages/platform/PlatformSupportPage'))
const PlatformApiWebhooksPage = lazy(() => import('@/pages/platform/PlatformApiWebhooksPage'))
const PlatformResellersPage = lazy(() => import('@/pages/platform/PlatformResellersPage'))
const PlatformRevenuePage = lazy(() => import('@/pages/platform/PlatformRevenuePage'))
const PlatformCustomerSuccessPage = lazy(() => import('@/pages/platform/PlatformCustomerSuccessPage'))
const PlatformMobilePage = lazy(() => import('@/pages/platform/PlatformMobilePage'))
const PlatformMarketplacePage = lazy(() => import('@/pages/platform/PlatformMarketplacePage'))
const PlatformInfrastructurePage = lazy(() => import('@/pages/platform/PlatformInfrastructurePage'))
const PlatformChangesPage = lazy(() => import('@/pages/platform/PlatformChangesPage'))
const PlatformSettingsPage = lazy(() => import('@/pages/platform/PlatformSettingsPage'))
const PlatformAuditLogPage = lazy(() => import('@/pages/platform/PlatformAuditLogPage'))
const PlatformSuperAdminsPage = lazy(() => import('@/pages/platform/PlatformSuperAdminsPage'))
const PlatformUserCreatePage = lazy(() => import('@/pages/platform/PlatformUserCreatePage'))
const PlatformLayout = lazy(() => import('@/components/platform/PlatformLayout'))
const SearchResultsPage = lazy(() => import('@/pages/search/SearchResultsPage'))
// Quotes – prototype v17 (list + board, quote page with revisions, full-page form)
const QuotesListV17 = lazy(() => import('@/pages/quotes/QuotesListPage'))
const QuotePageV17 = lazy(() => import('@/pages/quotes/QuotePage'))
const QuoteFormV17 = lazy(() => import('@/pages/quotes/QuoteFormV17'))
// Product & Price Books – prototype v17 (Catalogue + Price books tabs, product drawer, full-page product form)
const ProductsPageV18 = lazy(() => import('@/pages/products/ProductsPage'))
const ProductRecordV18 = lazy(() => import('@/pages/products/ProductRecordPage'))
// Forecasts – prototype v17 (period chips, KPI strip, Forecast by rep with inline manager adjustment, Composition)
const ForecastsPageV17 = lazy(() => import('@/pages/forecasts/ForecastsPage'))

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: any }> {
  state: { hasError: boolean; error?: any } = { hasError: false }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }

  componentDidCatch(error: any, info: any) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-center">
          <h2 className="text-xl font-semibold text-red-700">Something went wrong</h2>
          <p className="mt-2 text-sm text-gray-600">Refresh or contact support.</p>
          <pre className="mt-3 text-xs text-left text-gray-500">{String(this.state.error)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Role hierarchy Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const ROLE_LEVELS: Record<string, number> = {
  support: 10,
  sales: 20,
  accounts: 30,
  manager: 50,
  vp: 60,
  ceo: 70,
  admin: 100,
}

const ROLES_PAGE_ROLES = ['admin', 'ceo']
const REPORT_ENGINE_PAGE_PERMISSIONS = ['report_engine.view']
const REPORTS_PAGE_PERMISSIONS = [
  'reports.view',
  'reports.customers.view',
  'reports.leads.view',
  'reports.opportunities.view',
  'reports.tenders.view',
  'reports.quotations.view',
  'reports.workorders.view',
  'reports.emdbg.view',
  'reports.kam.view',
  'reports.travel.view',
  'reports.tada.view',
  'reports.oem.view',
  'reports.competitors.view',
]

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Full-screen loader Ã¢â‚¬â€ initial app bootstrap only Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const Loading = () => <LogoWriteLoader />

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Minimal fallback Ã¢â‚¬â€ lazy module transitions only Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const PageFallback = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 200 }}>
    <div className="loading-spinner" />
  </div>
)

// Tenant creation uses the Bidwise wizard; old form URLs open it on Onboarding & provisioning.
function NewTenantRedirect() {
  const [params] = useSearchParams()
  const group = params.get('group')
  return <Navigate to={`/platform/onboarding?new=1${group ? `&group=${group}` : ''}`} replace />
}

// The separate Configure tenant page was retired: tenant settings are edited in the tenant's Configuration tab.
function TenantEditRedirect() {
  return <Navigate to={`/platform/tenants/${useParams().id}?tab=Configuration`} replace />
}

function PlatformAuthRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = usePlatformAuthStore()

  if (!token || user?.role !== 'super_admin') {
    return <Navigate to="/platform/login" replace />
  }

  return <>{children}</>
}

function PlatformPublicRoute({ children }: { children: React.ReactNode }) {
  const { token, user } = usePlatformAuthStore()

  if (token && user?.role === 'super_admin') {
    return <Navigate to="/platform/dashboard" replace />
  }

  return <>{children}</>
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Auth guard Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function AuthRoute({ children, authReady }: { children: React.ReactNode; authReady: boolean }) {
  const { user, access_token } = useAuthStore()
  if (!authReady) return <Loading />
  if (!user || !access_token || isTokenExpired(access_token)) return <Navigate to="/login" replace />
  return <>{children}</>
}

function ForgotPasswordRoute({ hasActiveSession, authReady }: { hasActiveSession: boolean; authReady: boolean }) {
  const location = useLocation()
  const searchParams = new URLSearchParams(location.search)
  const hasPlatformResetToken = searchParams.has('platform_reset_token')
  const hasLegacyResetToken = searchParams.has('token')

  if (!authReady) return <Loading />

  if (hasPlatformResetToken) {
    return <Suspense fallback={<PageFallback />}><PlatformForgotPasswordPage /></Suspense>
  }

  if (hasActiveSession && !hasLegacyResetToken) {
    return <Navigate to="/dashboard" replace />
  }

  return <ForgotPasswordPage />
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Role guard Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function RoleRoute({ children, allowedRoles, authReady }: { children: React.ReactNode; allowedRoles: string[]; authReady: boolean }) {
  const { user, access_token } = useAuthStore()
  if (!authReady) return <Loading />
  if (!user || !access_token || isTokenExpired(access_token)) return <Navigate to="/login" replace />
  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4 p-8">
        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center text-3xl">Ã°Å¸â€â€™</div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-800">Access Restricted</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xs">You don't have permission to view this page.</p>
        </div>
        <button onClick={() => window.history.back()}
          className="px-4 py-2 text-sm text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
          Go Back
        </button>
      </div>
    )
  }
  return <>{children}</>
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Permission guard Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function PermRoute({ children, permission, fallbackRoles = [], authReady }: {
  children: React.ReactNode; permission: string; fallbackRoles?: string[]; authReady: boolean
}) {
  const { user, access_token } = useAuthStore()
  const { can, loaded } = usePermissions()
  // The permission list is cached from sign-in, so a permission granted later (e.g. a new module such as Funnel) would be
  // refused until the cache expires. Before showing "Access Restricted", re-read this user's permissions from the server once.
  const [rechecked, setRechecked] = useState<string | null>(null)
  const allowed = !!user && (fallbackRoles.includes(user.role) || can(permission))
  useEffect(() => {
    if (!authReady || !user || !access_token || !loaded || allowed || rechecked === permission) return
    let alive = true
    loadPermissions(true, true).finally(() => { if (alive) setRechecked(permission) })
    return () => { alive = false }
  }, [authReady, user, access_token, loaded, allowed, permission, rechecked])
  if (!authReady) return <Loading />
  if (!user || !access_token || isTokenExpired(access_token)) return <Navigate to="/login" replace />
  if (!allowed && (!loaded || rechecked !== permission)) return <Loading />
  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4 p-8">
        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center text-3xl" aria-hidden="true">🔒</div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-800">Access Restricted</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xs">
            You don't have permission to view this page. Contact your Admin to request access.
          </p>
        </div>
        <button onClick={() => window.history.back()}
          className="px-4 py-2 text-sm text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
          Go Back
        </button>
      </div>
    )
  }
  return <>{children}</>
}

function AnyPermRoute({ children, permissions, fallbackRoles = [], authReady }: {
  children: React.ReactNode; permissions: string[]; fallbackRoles?: string[]; authReady: boolean
}) {
  const { user, access_token } = useAuthStore()
  const { canAny } = usePermissions()
  if (!authReady) return <Loading />
  if (!user || !access_token || isTokenExpired(access_token)) return <Navigate to="/login" replace />
  if (!fallbackRoles.includes(user.role) && !canAny(permissions)) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4 p-8">
        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center text-3xl">Ã°Å¸â€â€™</div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-800">Access Restricted</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xs">
            You don't have permission to view this page. Contact your Admin to request access.
          </p>
        </div>
        <button onClick={() => window.history.back()}
          className="px-4 py-2 text-sm text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors">
          Go Back
        </button>
      </div>
    )
  }
  return <>{children}</>
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ App Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export default function App() {
  const { user, access_token, refresh_token, logout } = useAuthStore()
  const [authReady, setAuthReady] = useState(false)
  const ready = authReady

  const hasActiveSession = Boolean(user && access_token && !isTokenExpired(access_token))

  // Fetch theme from API and apply CSS variables to entire app
  useTheme()

  useEffect(() => {
    const tenantSlug = useAuthStore.getState().tenant_slug || localStorage.getItem('tenant_slug')
    if (!tenantSlug || window.location.pathname.startsWith('/platform')) return
    let active = true
    const checkMaintenance = async () => {
      // Platform Administration must remain available so super admins can
      // disable global maintenance. This is checked on every poll because a
      // user can navigate to /platform after the interval has started.
      if (window.location.pathname.startsWith('/platform')) return
      try {
        const { data } = await authApi.maintenanceStatus(tenantSlug)
        if (active && data.maintenance_mode && window.location.pathname !== '/maintenance') {
          window.location.replace('/maintenance')
        }
      } catch {
        // Leave the application available if the status check itself fails.
      }
    }
    void checkMaintenance()
    const timer = window.setInterval(() => void checkMaintenance(), 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    let active = true

    const bootstrapAuth = async () => {
      if (!user) {
        if (active) setAuthReady(true)
        return
      }

      if (access_token && !isTokenExpired(access_token)) {
        if (active) setAuthReady(true)
        return
      }

      if (refresh_token && !isTokenExpired(refresh_token)) {
        if (active) setAuthReady(false)
        try {
          await refreshAuthSession({ redirectOnFail: false })
        } catch {
          logout()
        } finally {
          if (active) setAuthReady(true)
        }
        return
      }

      logout()
      if (active) setAuthReady(true)
    }

    void bootstrapAuth()
    return () => {
      active = false
    }
  }, [access_token, logout, refresh_token, user])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || !['digitcrm-auth', 'access_token', 'refresh_token', 'tenant_slug'].includes(event.key)) {
        return
      }

      const persisted = localStorage.getItem('digitcrm-auth')
      if (!persisted) {
        const hasTokenStorage = Boolean(
          localStorage.getItem('access_token') ||
          localStorage.getItem('refresh_token') ||
          localStorage.getItem('tenant_slug')
        )
        if (hasTokenStorage) return

        useAuthStore.getState().logout()
        if (!window.location.pathname.startsWith('/login')) {
          window.location.replace('/login')
        }
        return
      }

      try {
        const parsed = JSON.parse(persisted)
        const nextState = parsed?.state || {}
        useAuthStore.setState({
          user: nextState.user ?? null,
          access_token: nextState.access_token ?? null,
          refresh_token: nextState.refresh_token ?? null,
          permissions: nextState.permissions ?? [],
          tenant_slug: nextState.tenant_slug ?? null,
          session_policy: nextState.session_policy ?? null,
        })
      } catch {
        useAuthStore.getState().logout()
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  return (
    <ToastProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/maintenance" element={<Suspense fallback={<Loading />}><MaintenancePage /></Suspense>} />
          {/* Public */}
          <Route path="/login" element={!ready ? <Loading /> : hasActiveSession ? <Navigate to="/dashboard" replace /> : <Suspense fallback={<PageFallback />}><LoginPage /></Suspense>} />
          <Route path="/forgot-password" element={<Suspense fallback={<PageFallback />}><ForgotPasswordRoute hasActiveSession={hasActiveSession} authReady={ready} /></Suspense>} />
          <Route path="/reset-password" element={<Suspense fallback={<PageFallback />}><ResetPasswordPage /></Suspense>} />
          <Route path="/csat/:token" element={<Suspense fallback={<PageFallback />}><CsatRatingPage /></Suspense>} />
          <Route path="/privacy-policy.html" element={<Suspense fallback={<PageFallback />}><PrivacyPolicyPage /></Suspense>} />
          <Route path="/privacy-policy" element={<Suspense fallback={<PageFallback />}><PrivacyPolicyPage /></Suspense>} />

          {/* Protected */}
          <Route path="/" element={<AuthRoute authReady={ready}><AppLayout /></AuthRoute>}>
            <Route index element={<Navigate to="/dashboard" replace />} />

            <Route path="dashboard" element={
              <PermRoute permission="dashboard.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DashboardPage /></Suspense>
              </PermRoute>
            } />
            <Route path="team-chat" element={
              <PermRoute permission="team_chat.use" authReady={ready}>
                <Suspense fallback={<PageFallback />}><TeamChatPage /></Suspense>
              </PermRoute>
            } />
            <Route path="customers" element={
              <PermRoute permission="customers.view" authReady={ready}>
                <Outlet />
              </PermRoute>
            }>
              <Route index element={<Suspense fallback={<PageFallback />}><CustomerListPage /></Suspense>} />
              <Route path=":id" element={<Suspense fallback={<PageFallback />}><Customer360Page /></Suspense>} />
              <Route path="new" element={
                <PermRoute permission="customers.create" authReady={ready}>
                  <Suspense fallback={<PageFallback />}><CustomerForm /></Suspense>
                </PermRoute>
              } />
              <Route path=":id/edit" element={
                <PermRoute permission="customers.update" authReady={ready}>
                  <Suspense fallback={<PageFallback />}><CustomerForm /></Suspense>
                </PermRoute>
              } />
            </Route>
            <Route path="questionnaire" element={
              <PermRoute permission="questionnaire.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><QuestionnairePage /></Suspense>
              </PermRoute>
            }>
              <Route index element={<Suspense fallback={<PageFallback />}><CustomerQuestionnaireListPage /></Suspense>} />
              <Route path="new" element={
                <PermRoute permission="questionnaire.update" authReady={ready}>
                  <Suspense fallback={<PageFallback />}><CustomerQuestionnaireEntryPage /></Suspense>
                </PermRoute>
              } />
              <Route path="new/:customerId" element={
                <PermRoute permission="questionnaire.update" authReady={ready}>
                  <Suspense fallback={<PageFallback />}><CustomerQuestionnaireEntryPage /></Suspense>
                </PermRoute>
              } />
              <Route path="builder" element={
                <PermRoute permission="questionnaire.create" authReady={ready}>
                  <Suspense fallback={<PageFallback />}><QuestionnaireFormBuilderPage /></Suspense>
                </PermRoute>
              } />
              <Route path=":customerId" element={<Suspense fallback={<PageFallback />}><CustomerQuestionnaireFormPage /></Suspense>} />
            </Route>
            {/* Leads – prototype v17 (list + board + drawer, full-page form) */}
            <Route path="leads" element={
              <PermRoute permission="leads.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><LeadsListV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="leads/pipeline" element={
              <PermRoute permission="leads.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><LeadsListV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="capture-forms" element={
              <PermRoute permission="capture_forms.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><CaptureFormsPage /></Suspense>
              </PermRoute>
            } />
            <Route path="leads/new" element={
              <PermRoute permission="leads.create" authReady={ready}>
                <Suspense fallback={<PageFallback />}><LeadFormV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="leads/:id/edit" element={
              <PermRoute permission="leads.update" authReady={ready}>
                <Suspense fallback={<PageFallback />}><LeadFormV17 /></Suspense>
              </PermRoute>
            } />
            {/* Deals – prototype v17 (list + board + drawer, full-page form) */}
            <Route path="opportunities" element={
              <PermRoute permission="opportunities.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DealsListV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="opportunities/pipeline" element={
              <PermRoute permission="opportunities.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DealsListV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="opportunities/new" element={
              <PermRoute permission="opportunities.create" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DealFormV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="opportunities/:id/edit" element={
              <PermRoute permission="opportunities.update" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DealFormV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="opportunities/:id" element={
              <PermRoute permission="opportunities.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DealsListV17 /></Suspense>
              </PermRoute>
            } />
            <Route path="leads/:id" element={
              <PermRoute permission="leads.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><LeadsListV17 /></Suspense>
              </PermRoute>
            } />
            {/* Bids & Tenders – prototype v17 (list + board, full-page form, tender page with six tabs).
                /tenders/:id/edit is the link other modules use to open a tender, so it opens the tender page too. */}
            <Route path="tenders" element={
              <PermRoute permission="tenders.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><TendersListV17 /></Suspense>
              </PermRoute>} />
            <Route path="tenders/new" element={
              <PermRoute permission="tenders.create" authReady={ready}>
                <Suspense fallback={<PageFallback />}><TenderFormV17 /></Suspense>
              </PermRoute>} />
            <Route path="tenders/:id/form" element={
              <PermRoute permission="tenders.update" authReady={ready}>
                <Suspense fallback={<PageFallback />}><TenderFormV17 /></Suspense>
              </PermRoute>} />
            <Route path="tenders/:id/edit" element={
              <PermRoute permission="tenders.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><TenderPageV17 /></Suspense>
              </PermRoute>} />
            <Route path="tenders/:id" element={
              <PermRoute permission="tenders.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><TenderPageV17 /></Suspense>
              </PermRoute>} />
            {/* Forecasts – prototype v17 */}
            <Route path="forecasts" element={
              <PermRoute permission="forecasts.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><ForecastsPageV17 /></Suspense>
              </PermRoute>} />
            {/* Product & Price Books – prototype v18: catalogue / category map / price books / change log / configuration, product record */}
            <Route path="products" element={
              <PermRoute permission="products.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><ProductsPageV18 /></Suspense>
              </PermRoute>} />
            {/* v17 full-page form routes: New product / Edit details are modals in v18 */}
            <Route path="products/new" element={<Navigate to="/products" replace />} />
            <Route path="products/:id/edit" element={<Navigate to="/products" replace />} />
            <Route path="products/:id" element={
              <PermRoute permission="products.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><ProductRecordV18 /></Suspense>
              </PermRoute>} />
            {/* Quotes – prototype v17: list & board, New quote / Edit header (full-page form), quote page */}
            <Route path="quotations" element={
              <PermRoute permission="quotations.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><QuotesListV17 /></Suspense>
              </PermRoute>} />
            <Route path="quotations/new" element={
              <PermRoute permission="quotations.create" authReady={ready}>
                <Suspense fallback={<PageFallback />}><QuoteFormV17 /></Suspense>
              </PermRoute>} />
            <Route path="quotations/:id/edit" element={
              <PermRoute permission="quotations.update" authReady={ready}>
                <Suspense fallback={<PageFallback />}><QuoteFormV17 /></Suspense>
              </PermRoute>} />
            <Route path="quotations/:id" element={
              <PermRoute permission="quotations.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><QuotePageV17 /></Suspense>
              </PermRoute>} />
            <Route path="consignees" element={<Suspense fallback={<PageFallback />}><ConsigneesPage /></Suspense>} />
            {/* Orders & Projects – prototype v17: list & board (+ drawer via ?open=<id> / ?number=<WO no.>), New order / Edit (full-page form) */}
            <Route path="workorders">
              <Route index element={<PermRoute permission="workorders.view" authReady={ready}><Suspense fallback={<PageFallback />}><OrdersListV17 /></Suspense></PermRoute>} />
              <Route path="new" element={<PermRoute permission="workorders.create" authReady={ready}><Suspense fallback={<PageFallback />}><OrderFormV17 /></Suspense></PermRoute>} />
              <Route path=":id/edit" element={<PermRoute permission="workorders.update" authReady={ready}><Suspense fallback={<PageFallback />}><OrderFormV17 /></Suspense></PermRoute>} />
            </Route>
            {/* Guarantees & Deposits – prototype v18: summary, five views, drawer via ?open=<id>, New request modal */}
            <Route path="emdbg">
              <Route index element={<PermRoute permission="emdbg.view" authReady={ready}><Suspense fallback={<PageFallback />}><GuaranteesV18 /></Suspense></PermRoute>} />
              {/* v17 full-page form routes – v18 uses the New request modal and the drawer */}
              <Route path="new" element={<Navigate to="/emdbg" replace />} />
              <Route path=":id/edit" element={<Navigate to="/emdbg" replace />} />
            </Route>
            {/* Field Sales 360 – prototype v17 (Finance & Field). The classic KAM activity workspace (planner, lists) stays at /kam/activities. */}
            <Route path="kam">
              <Route index element={<PermRoute permission="kam.view" authReady={ready}><Suspense fallback={<PageFallback />}><FieldSales360Page /></Suspense></PermRoute>} />
              <Route path="log" element={<PermRoute permission="kam.create" authReady={ready}><Suspense fallback={<PageFallback />}><FieldSalesLogActivity /></Suspense></PermRoute>} />
              <Route path="activities" element={<Suspense fallback={<PageFallback />}><KAMPage /></Suspense>} />
            </Route>
            {/* Travel & Expense – prototype v17. The classic travel list stays at /travel/classic, TA/DA claim processing at /travel/claims. */}
            <Route path="travel" element={<PermRoute permission="travel.view" authReady={ready}><Suspense fallback={<PageFallback />}><TravelExpenseV17 /></Suspense></PermRoute>} />
            <Route path="travel/new" element={<PermRoute permission="travel.create" authReady={ready}><Suspense fallback={<PageFallback />}><TripFormV17 /></Suspense></PermRoute>} />
            <Route path="travel/:id/edit" element={<PermRoute permission="travel.update" authReady={ready}><Suspense fallback={<PageFallback />}><TripFormV17 /></Suspense></PermRoute>} />
            <Route path="travel/classic" element={<Suspense fallback={<PageFallback />}><TravelTADAPage /></Suspense>} />
            <Route path="travel/claims" element={<Suspense fallback={<PageFallback />}><TADAPage /></Suspense>} />
            <Route path="tada" element={<Navigate to="/travel" replace />} />
            <Route path="rfp" element={<Suspense fallback={<PageFallback />}><RFPPage /></Suspense>} />
            <Route path="funnel" element={
              <PermRoute permission="funnel.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><FunnelAnalyticsPage /></Suspense>
              </PermRoute>
            } />
            <Route path="automation-studio" element={
              <PermRoute permission="automation.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><AutomationStudioPage /></Suspense>
              </PermRoute>
            } />
            <Route path="document-management" element={
              <PermRoute permission="document_management.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DocumentHubPage /></Suspense>
              </PermRoute>
            } />
            <Route path="document-management/classic" element={
              <PermRoute permission="document_management.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><DocumentManagementPage /></Suspense>
              </PermRoute>
            } />
            <Route path="letter-management" element={
              <PermRoute permission="letter_management.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><CorrespondencePage /></Suspense>
              </PermRoute>
            } />
            <Route path="letter-management/classic" element={
              <PermRoute permission="letter_management.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><LetterManagementPage /></Suspense>
              </PermRoute>
            } />
            <Route path="datahub" element={
              <PermRoute permission="datahub.view" fallbackRoles={ROLES_PAGE_ROLES} authReady={ready}>
                <Suspense fallback={<PageFallback />}><DataHubPage /></Suspense>
              </PermRoute>
            } />
            <Route path="audit-logs" element={
              <PermRoute permission="audit_logs.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><AuditLogPage /></Suspense>
              </PermRoute>
            } />
            <Route path="recycle-bin" element={
              <PermRoute permission="recycle_bin.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><RecycleBinPage /></Suspense>
              </PermRoute>
            } />
            <Route path="approvals" element={<ErrorBoundary><Suspense fallback={<PageFallback />}><ApprovalsV18Page /></Suspense></ErrorBoundary>} />
            <Route path="approvals/classic" element={<ErrorBoundary><Suspense fallback={<PageFallback />}><ApprovalsPage /></Suspense></ErrorBoundary>} />
            <Route path="approval-workflow" element={<Suspense fallback={<PageFallback />}><ApprovalWorkflowPage /></Suspense>} />
            <Route path="reports" element={
              <AnyPermRoute permissions={REPORT_ENGINE_PAGE_PERMISSIONS} authReady={ready}>
                <Suspense fallback={<PageFallback />}><ReportEnginePage /></Suspense>
              </AnyPermRoute>
            } />
            <Route path="reports/:reportTypeKey" element={
              <AnyPermRoute permissions={REPORT_ENGINE_PAGE_PERMISSIONS} authReady={ready}>
                <Suspense fallback={<PageFallback />}><ReportEnginePage /></Suspense>
              </AnyPermRoute>
            } />

            {/* Sidebar "Reports" (module reports, route /analytics) – prototype v17 catalogue; the earlier per-module report tabs stay at /analytics/classic */}
            <Route path="analytics" element={
              <PermRoute permission="reports.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><ReportsV17Page /></Suspense>
              </PermRoute>
            } />
            <Route path="analytics/classic" element={
              <AnyPermRoute permissions={REPORTS_PAGE_PERMISSIONS} authReady={ready}>
                <Suspense fallback={<PageFallback />}><ReportsPage /></Suspense>
              </AnyPermRoute>
            } />

            <Route path="report-engine" element={<Navigate to="/reports" replace />} />
            {/* Sidebar "Analytics" (module report_engine) – prototype v17 analytics; the report engine itself stays at /reports */}
            <Route path="intelligence/analytics" element={
              <PermRoute permission="report_engine.view" authReady={ready}>
                <Suspense fallback={<PageFallback />}><AnalyticsV17Page /></Suspense>
              </PermRoute>
            } />
            <Route path="search" element={<Suspense fallback={<PageFallback />}><SearchResultsPage /></Suspense>} />
            <Route path="alerts" element={<Suspense fallback={<PageFallback />}><AlertsPage /></Suspense>} />
            <Route path="notifications" element={<Suspense fallback={<PageFallback />}><NotificationsPage /></Suspense>} />
            <Route path="notifications/inbox" element={<Suspense fallback={<PageFallback />}><NotificationsPage /></Suspense>} />
            <Route path="calendar" element={<Suspense fallback={<PageFallback />}><CalendarTasksPage /></Suspense>} />
            <Route path="notes" element={<Suspense fallback={<PageFallback />}><NotesPinboardPage /></Suspense>} />
            <Route path="oems" element={<Suspense fallback={<PageFallback />}><OEMPage /></Suspense>}>
              <Route index element={<Suspense fallback={<PageFallback />}><PartnersOemPage /></Suspense>} />
              <Route path="classic" element={<Suspense fallback={<PageFallback />}><OEMListPage /></Suspense>} />
              <Route path="new" element={<Suspense fallback={<PageFallback />}><OEMFormPage /></Suspense>} />
              <Route path=":id/edit" element={<Suspense fallback={<PageFallback />}><OEMFormPage /></Suspense>} />
            </Route>
            <Route path="insights" element={<Suspense fallback={<PageFallback />}><InsightsPage /></Suspense>} />

            <Route path="masters" element={<Suspense fallback={<PageFallback />}><MastersV17Page /></Suspense>} />
            <Route path="masters/classic" element={<Suspense fallback={<PageFallback />}><MastersPage /></Suspense>} />
            <Route path="competitors" element={<Suspense fallback={<PageFallback />}><CompetitorsPage /></Suspense>}>
              <Route index element={<Suspense fallback={<PageFallback />}><CompetitorsIntelPage /></Suspense>} />
              <Route path="classic" element={<Suspense fallback={<PageFallback />}><CompetitorListPage /></Suspense>} />
              <Route path="new" element={<Suspense fallback={<PageFallback />}><CompetitorFormPage /></Suspense>} />
              <Route path=":id/edit" element={<Suspense fallback={<PageFallback />}><CompetitorFormPage /></Suspense>} />
            </Route>
            <Route path="settings/profile" element={<Suspense fallback={<PageFallback />}><ProfilePage /></Suspense>} />
            <Route path="backups" element={<Suspense fallback={<PageFallback />}><PlatformBackupsPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<PageFallback />}><AppSettingsPage /></Suspense>} />
            <Route path="settings/advanced" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
            <Route path="users" element={<Suspense fallback={<PageFallback />}><UsersPage /></Suspense>}>
              <Route index element={<Suspense fallback={<PageFallback />}><UsersTeamsPage /></Suspense>} />
              <Route path="classic" element={<Suspense fallback={<PageFallback />}><UserListPage /></Suspense>} />
              <Route path="new" element={<Suspense fallback={<PageFallback />}><UserFormPage /></Suspense>} />
              <Route path=":id/edit" element={<Suspense fallback={<PageFallback />}><UserFormPage /></Suspense>} />
            </Route>
            <Route path="integrations" element={<Suspense fallback={<PageFallback />}><MarketplacePage /></Suspense>} />
            <Route path="integrations/classic" element={<Suspense fallback={<PageFallback />}><IntegrationsPage /></Suspense>} />
            <Route path="workflow" element={
              <PermRoute permission="workflow.view" fallbackRoles={ROLES_PAGE_ROLES} authReady={ready}>
                <Suspense fallback={<PageFallback />}><ProcessDesignerPage /></Suspense>
              </PermRoute>
            } />

            <Route path="roles" element={
              <PermRoute permission="roles.view" fallbackRoles={ROLES_PAGE_ROLES} authReady={ready}>
                <Suspense fallback={<PageFallback />}><RolesSecurityPage /></Suspense>
              </PermRoute>
            } />
            <Route path="roles/classic" element={
              <PermRoute permission="roles.view" fallbackRoles={ROLES_PAGE_ROLES} authReady={ready}>
                <Suspense fallback={<PageFallback />}><RolesPage /></Suspense>
              </PermRoute>
            } />

            <Route path="form-builder" element={
              <PermRoute permission="form_builder.manage" authReady={ready}>
                <Suspense fallback={<PageFallback />}><StudioPage /></Suspense>
              </PermRoute>
            } />
            <Route path="form-builder/classic" element={
              <PermRoute permission="form_builder.manage" authReady={ready}>
                <Suspense fallback={<PageFallback />}><FormBuilderPage /></Suspense>
              </PermRoute>
            } />
          </Route>

          <Route path="*" element={<Navigate to="/dashboard" replace />} />

          <Route
            path="/platform/login"
            element={
              <Suspense fallback={<PageFallback />}>
                <PlatformPublicRoute>
                  <PlatformLoginPage />
                </PlatformPublicRoute>
              </Suspense>
            }
          />
          <Route path="/platform/forgot-password" element={<Suspense fallback={<PageFallback />}><PlatformForgotPasswordPage /></Suspense>} />

          <Route
            path="/platform"
            element={
              <Suspense fallback={<PageFallback />}>
                <PlatformAuthRoute>
                  <PlatformLayout />
                </PlatformAuthRoute>
              </Suspense>
            }
          >
            <Route index element={<Navigate to="/platform/dashboard" replace />} />
            <Route path="profile" element={<Suspense fallback={<PageFallback />}><PlatformProfilePage /></Suspense>} />
            <Route path="dashboard" element={<Suspense fallback={<PageFallback />}><PlatformDashboardPage /></Suspense>} />
            <Route path="command-center" element={<Suspense fallback={<PageFallback />}><PlatformCommandCenterPage /></Suspense>} />
            <Route path="announcements" element={<Suspense fallback={<PageFallback />}><PlatformAnnouncementsPage /></Suspense>} />
            <Route path="tenants" element={<Suspense fallback={<PageFallback />}><PlatformTenantsPage /></Suspense>} />
            <Route path="tenants/:id" element={<Suspense fallback={<PageFallback />}><PlatformTenantDetailPage /></Suspense>} />
            <Route path="tenant-groups/:id" element={<Suspense fallback={<PageFallback />}><PlatformTenantGroupDetailPage /></Suspense>} />
            <Route path="subscriptions" element={<Suspense fallback={<PageFallback />}><PlatformSubscriptionsPage /></Suspense>} />
            <Route path="onboarding" element={<Suspense fallback={<PageFallback />}><PlatformOnboardingPage /></Suspense>} />
            <Route path="control-center" element={<Suspense fallback={<PageFallback />}><PlatformControlCenterPage /></Suspense>} />
            <Route path="tenant-onboarding" element={<NewTenantRedirect />} />
            <Route path="tenants/new" element={<NewTenantRedirect />} />
            <Route path="tenants/:id/edit" element={<TenantEditRedirect />} />
            <Route path="plans" element={<Suspense fallback={<PageFallback />}><PlatformPlansPage /></Suspense>} />
            <Route path="services" element={<Suspense fallback={<PageFallback />}><PlatformServicesPage /></Suspense>} />
            <Route path="feature-matrix" element={<Suspense fallback={<PageFallback />}><PlatformFeatureMatrixPage /></Suspense>} />
            <Route path="super-admins" element={<Suspense fallback={<PageFallback />}><PlatformSuperAdminsPage /></Suspense>} />
            <Route path="super-admins/new" element={<Suspense fallback={<PageFallback />}><PlatformUserCreatePage /></Suspense>} />
            <Route path="super-admins/:id/edit" element={<Suspense fallback={<PageFallback />}><PlatformUserCreatePage /></Suspense>} />
            <Route path="audit" element={<Suspense fallback={<PageFallback />}><PlatformAuditTrailPage /></Suspense>} />
            <Route path="support" element={<Suspense fallback={<PageFallback />}><PlatformSupportPage /></Suspense>} />
            <Route path="sla" element={<Suspense fallback={<PageFallback />}><PlatformSlaPage /></Suspense>} />
            <Route path="api-webhooks" element={<Suspense fallback={<PageFallback />}><PlatformApiWebhooksPage /></Suspense>} />
            <Route path="rate-limits" element={<Suspense fallback={<PageFallback />}><PlatformRateLimitsPage /></Suspense>} />
            <Route path="resellers" element={<Suspense fallback={<PageFallback />}><PlatformResellersPage /></Suspense>} />
            <Route path="revenue" element={<Suspense fallback={<PageFallback />}><PlatformRevenuePage /></Suspense>} />
            <Route path="customer-success" element={<Suspense fallback={<PageFallback />}><PlatformCustomerSuccessPage /></Suspense>} />
            <Route path="mobile" element={<Suspense fallback={<PageFallback />}><PlatformMobilePage /></Suspense>} />
            <Route path="marketplace" element={<Suspense fallback={<PageFallback />}><PlatformMarketplacePage /></Suspense>} />
            <Route path="tenants/:id/audit" element={<Suspense fallback={<PageFallback />}><PlatformAuditLogPage /></Suspense>} />
            <Route path="roles" element={<Suspense fallback={<PageFallback />}><PlatformRolesPage /></Suspense>} />
            <Route path="approval-queue" element={<Suspense fallback={<PageFallback />}><PlatformApprovalQueuePage /></Suspense>} />
            <Route path="usage" element={<Navigate to="/platform/usage-monitoring" replace />} />
            <Route path="databases" element={<Suspense fallback={<PageFallback />}><PlatformDatabasesPage /></Suspense>} />
            <Route path="monitoring" element={<Suspense fallback={<PageFallback />}><PlatformMonitoringPage /></Suspense>} />
            <Route path="usage-monitoring" element={<Suspense fallback={<PageFallback />}><PlatformUsageMonitoringPage /></Suspense>} />
            <Route path="storage" element={<Suspense fallback={<PageFallback />}><PlatformStoragePage /></Suspense>} />
            <Route path="data-transfer" element={<Suspense fallback={<PageFallback />}><PlatformDataTransferPage /></Suspense>} />
            <Route path="environments" element={<Suspense fallback={<PageFallback />}><PlatformEnvironmentsPage /></Suspense>} />
            <Route path="logs" element={<Suspense fallback={<PageFallback />}><PlatformLogsPage /></Suspense>} />
            <Route path="jobs" element={<Suspense fallback={<PageFallback />}><PlatformJobsPage /></Suspense>} />
            <Route path="billing" element={<Suspense fallback={<PageFallback />}><PlatformBillingPage /></Suspense>} />
            <Route path="cost-margin" element={<Suspense fallback={<PageFallback />}><PlatformCostMarginPage /></Suspense>} />
            <Route path="plans-entitlements" element={<Suspense fallback={<PageFallback />}><PlatformEntitlementsPage /></Suspense>} />
            <Route path="workflow-templates" element={<Suspense fallback={<PageFallback />}><PlatformWorkflowTemplatesPage /></Suspense>} />
            <Route path="security" element={<Suspense fallback={<PageFallback />}><PlatformSecurityPage /></Suspense>} />
            <Route path="trust-safety" element={<Suspense fallback={<PageFallback />}><PlatformTrustSafetyPage /></Suspense>} />
            <Route path="infrastructure" element={<Suspense fallback={<PageFallback />}><PlatformInfrastructurePage /></Suspense>} />
            <Route path="regions" element={<Suspense fallback={<PageFallback />}><PlatformRegionsPage /></Suspense>} />
            <Route path="discounts" element={<Suspense fallback={<PageFallback />}><PlatformDiscountsPage /></Suspense>} />
            <Route path="invoices" element={<Suspense fallback={<PageFallback />}><PlatformInvoicesPage /></Suspense>} />
            <Route path="addons" element={<Suspense fallback={<PageFallback />}><PlatformAddonsPage /></Suspense>} />
            <Route path="changes" element={<Suspense fallback={<PageFallback />}><PlatformChangesPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<PageFallback />}><PlatformSettingsPage /></Suspense>} />
          </Route>
          
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}



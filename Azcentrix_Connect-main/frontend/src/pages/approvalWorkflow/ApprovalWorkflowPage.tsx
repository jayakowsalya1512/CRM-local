import { PageHeader } from '@/components/ui/FormComponents'
import ApprovalsTab from '@/pages/settings/ApprovalsTab'

export default function ApprovalWorkflowPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Approval Matrix"
        subtitle="Configure reusable, role-based approval flows for each module action."
        breadcrumb={['Approval Matrix']}
      />
      <ApprovalsTab standalone />
    </div>
  )
}

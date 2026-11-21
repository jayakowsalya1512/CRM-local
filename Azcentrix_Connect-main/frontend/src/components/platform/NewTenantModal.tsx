import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { platformApi, type HierarchyGroupRow, type HierarchyTenantRow, type PlatformPlan } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { CreateWizard } from '@/pages/platform/PlatformTenantsPage'
import { errMsg } from './bw'

/** The prototype "+ New tenant" wizard, opened in place from anywhere in the platform. */
export default function NewTenantModal({ presetGroup, onClose }: { presetGroup?: number | null; onClose: () => void }) {
  const navigate = useNavigate()
  const { error: showError } = useToast()
  const [data, setData] = useState<{ groups: HierarchyGroupRow[]; tenants: HierarchyTenantRow[]; plans: PlatformPlan[] } | null>(null)
  useEffect(() => {
    Promise.all([platformApi.tenantHierarchy(), platformApi.listPlans()])
      .then(([h, p]) => setData({ groups: h.data.groups, tenants: h.data.tenants, plans: p.data }))
      .catch(err => { showError(errMsg(err, 'Unable to open the tenant wizard')); onClose() })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!data) return null
  // Portal to the shell root so the modal is never trapped in a parent's stacking context (e.g. the header).
  return createPortal(
    <CreateWizard group={false} presetGroup={presetGroup} {...data} onClose={onClose} onCreated={path => { onClose(); navigate(path) }} />,
    (document.querySelector('.platform-shell') as HTMLElement | null) ?? document.body,
  )
}

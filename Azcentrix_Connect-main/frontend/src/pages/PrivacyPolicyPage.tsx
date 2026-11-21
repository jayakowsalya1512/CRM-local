import policyHtml from './crm_privacy_policy.html?raw'

export default function PrivacyPolicyPage() {
  return (
    <div className="h-screen w-screen bg-[#f5f7fb]">
      <iframe
        title="Privacy Policy"
        srcDoc={policyHtml}
        className="block h-full w-full border-0"
      />
    </div>
  )
}

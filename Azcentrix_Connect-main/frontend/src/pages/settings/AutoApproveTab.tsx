import { useEffect, useState } from "react";
import { RefreshCw, Wand2 } from "lucide-react";

import { approvalWorkflowApi } from "@/services/api";
import Card, { CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/FormComponents";

interface AutoApproveSettingRow {
  module_key: string;
  module_label: string;
  action_key: string;
  action_label: string;
  is_enabled: boolean;
}

function getErr(err: unknown) {
  return (err as any)?.response?.data?.detail || (err as any)?.message || "Something went wrong.";
}

function StatusToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative inline-flex h-6 w-12 items-center rounded-full border transition-colors ${
        enabled ? "border-emerald-300 bg-emerald-500" : "border-gray-300 bg-gray-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-7" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function AutoApproveTab() {
  const { success, error } = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<AutoApproveSettingRow[]>([]);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const { data } = await approvalWorkflowApi.getAutoApproveSettings();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      error(getErr(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggle = async (row: AutoApproveSettingRow) => {
    const key = `${row.module_key}::${row.action_key}`;
    const nextEnabled = !row.is_enabled;
    setSavingKey(key);
    try {
      const { data } = await approvalWorkflowApi.updateAutoApproveSetting({
        module_key: row.module_key,
        action_key: row.action_key,
        is_enabled: nextEnabled,
      });
      setRows((current) =>
        current.map((item) =>
          item.module_key === row.module_key && item.action_key === row.action_key
            ? { ...item, is_enabled: !!data?.is_enabled }
            : item
        )
      );
      success(`Auto approve ${data?.is_enabled ? "enabled" : "disabled"} for ${row.module_label} - ${row.action_label}`);
    } catch (err) {
      error(getErr(err));
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={<Wand2 size={16} />}
          title="Auto Approve Settings"
          subtitle="When no matching approval rule exists for a module + action, choose whether the request is auto-approved or sent through the group hierarchy for approval."
          actions={
            <button
              type="button"
              onClick={loadData}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          }
        />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/80 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-5 py-3">Module</th>
                <th className="px-5 py-3">Action</th>
                <th className="px-5 py-3">Auto Approve</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-5 py-6 text-center text-sm text-gray-400">
                    Loading...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-6 text-center text-sm text-gray-400">
                    No modules found.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const key = `${row.module_key}::${row.action_key}`;
                  return (
                    <tr key={key} className="border-b border-gray-100 last:border-0">
                      <td className="px-5 py-4 font-medium text-gray-800">{row.module_label}</td>
                      <td className="px-5 py-4 text-gray-600">{row.action_label}</td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <StatusToggle
                            enabled={row.is_enabled}
                            onToggle={() => savingKey === null && handleToggle(row)}
                          />
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              row.is_enabled ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"
                            }`}
                          >
                            {row.is_enabled ? "Auto Approve" : "Approval Required"}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

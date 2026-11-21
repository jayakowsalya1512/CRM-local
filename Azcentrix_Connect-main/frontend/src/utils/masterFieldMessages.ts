// Shared message text for required dropdowns backed by configurable Master data.
// Distinguishes "user hasn't picked a value" from "no master data exists to pick from".

export function requiredSelectMessage(
  label: string,
  options: unknown[] | null | undefined,
  opts?: { available?: boolean }
): string {
  const available = opts?.available ?? true
  if (available && (!options || options.length === 0)) {
    return `No ${label} configured. Please contact your administrator.`
  }
  return `Please select ${label}.`
}

export function noMasterDataMessage(labels: string[]): string {
  return `No ${labels.join(', ')} configured. Please contact your administrator.`
}

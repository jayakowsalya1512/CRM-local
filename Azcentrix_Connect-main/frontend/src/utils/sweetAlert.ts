import type { SweetAlertIcon } from 'sweetalert2'

type ConfirmActionOptions = {
  title: string
  text: string
  confirmButtonText: string
  cancelButtonText?: string
  icon?: SweetAlertIcon
  confirmButtonColor?: string
}

type ConfirmActionWithCheckboxOptions = ConfirmActionOptions & {
  checkboxLabel: string
  checkboxHint?: string
  checkboxChecked?: boolean
}

const ICON_COLORS: Partial<Record<SweetAlertIcon, string>> = {
  success: 'var(--color-success)',
  error: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-accent)',
  question: '#475569',
}

type SweetAlertInstance = (typeof import('sweetalert2'))['default']

let sweetAlertLoader: Promise<SweetAlertInstance> | null = null

async function getSweetAlert() {
  if (!sweetAlertLoader) {
    sweetAlertLoader = Promise.all([
      import('sweetalert2'),
      import('sweetalert2/dist/sweetalert2.min.css'),
    ]).then(([module]) => module.default)
  }

  return sweetAlertLoader
}

export async function confirmAction({
  title,
  text,
  confirmButtonText,
  cancelButtonText = 'Cancel',
  icon = 'warning',
  confirmButtonColor = '#e92a2f',
}: ConfirmActionOptions) {
  const Swal = await getSweetAlert()
  const result = await Swal.fire({
    title,
    text,
    icon,
    iconColor: ICON_COLORS[icon],
    showCancelButton: true,
    showCloseButton: false,
    confirmButtonText,
    cancelButtonText,
    reverseButtons: false,
    focusCancel: true,
    buttonsStyling: false,
    heightAuto: false,
    backdrop: 'rgba(15, 23, 42, 0.45)',
    customClass: {
      container: 'app-swal-container',
      popup: 'app-swal-popup',
      title: 'app-swal-title',
      htmlContainer: 'app-swal-text',
      icon: 'app-swal-icon',
      actions: 'app-swal-actions',
      confirmButton: 'app-swal-confirm',
      cancelButton: 'app-swal-cancel',
      closeButton: 'app-swal-close',
    },
    didOpen: (popup) => {
      popup.style.setProperty('--app-swal-confirm', confirmButtonColor)
    },
  })

  return result.isConfirmed
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export async function confirmActionWithCheckbox({
  title,
  text,
  confirmButtonText,
  cancelButtonText = 'Cancel',
  icon = 'warning',
  confirmButtonColor = '#e92a2f',
  checkboxLabel,
  checkboxHint,
  checkboxChecked = false,
}: ConfirmActionWithCheckboxOptions) {
  const Swal = await getSweetAlert()
  const checkboxId = 'app-swal-checkbox'
  const result = await Swal.fire({
    title,
    html: `
      <div class="app-swal-stack">
        <p class="app-swal-message">${escapeHtml(text)}</p>
        <label class="app-swal-check" for="${checkboxId}">
          <input id="${checkboxId}" type="checkbox" ${checkboxChecked ? 'checked' : ''} />
          <span>${escapeHtml(checkboxLabel)}</span>
        </label>
        ${checkboxHint ? `<p class="app-swal-check-hint">${escapeHtml(checkboxHint)}</p>` : ''}
      </div>
    `,
    icon,
    iconColor: ICON_COLORS[icon],
    showCancelButton: true,
    showCloseButton: false,
    confirmButtonText,
    cancelButtonText,
    reverseButtons: false,
    focusCancel: true,
    buttonsStyling: false,
    heightAuto: false,
    backdrop: 'rgba(15, 23, 42, 0.45)',
    customClass: {
      container: 'app-swal-container',
      popup: 'app-swal-popup',
      title: 'app-swal-title',
      htmlContainer: 'app-swal-text',
      icon: 'app-swal-icon',
      actions: 'app-swal-actions',
      confirmButton: 'app-swal-confirm',
      cancelButton: 'app-swal-cancel',
      closeButton: 'app-swal-close',
    },
    didOpen: (popup) => {
      popup.style.setProperty('--app-swal-confirm', confirmButtonColor)
    },
    preConfirm: () => {
      const checkbox = document.getElementById(checkboxId) as HTMLInputElement | null
      return { checked: !!checkbox?.checked }
    },
  })

  return {
    isConfirmed: result.isConfirmed,
    checked: !!result.value?.checked,
  }
}

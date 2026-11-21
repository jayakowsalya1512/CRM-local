// The message shown directly under an invalid field. Renders nothing when there is no error, so valid forms keep
// their exact layout.
export default function FieldError({ id, msg }: { id?: string; msg?: string | null }) {
  if (!msg) return null
  return <small className="fe-msg" id={id ? `${id}-err` : undefined} role="alert">{msg}</small>
}

import { Outlet } from 'react-router-dom'

// Shell: child routes render here.
// /customers         → CustomerListPage
// /customers/new     → CustomerFormPage (create)
// /customers/:id/edit → CustomerFormPage (edit)
export default function CustomersPage() {
  return <Outlet />
}

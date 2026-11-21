import { UserCog } from 'lucide-react'

export const usersMeta = {
  key: 'users',
  label: 'Users',
  icon: UserCog,
}

export const usersFields = {
  basic: [
    { field_key: 'full_name', default_label: 'Full Name' },
    { field_key: 'username', default_label: 'Username' },
    { field_key: 'email', default_label: 'Email' },
    { field_key: 'employee_code', default_label: 'Employee Code' },
    { field_key: 'phone', default_label: 'Phone' },
  ],

  role: [
    { field_key: 'role', default_label: 'Role' },
    { field_key: 'department', default_label: 'Department' },
    { field_key: 'designation', default_label: 'Designation' },
    { field_key: 'branch', default_label: 'Branch' },
  ],

  region: [
    { field_key: 'region_id', default_label: 'Region' },
    { field_key: 'state_id', default_label: 'State' },
  ],

  target: [
    { field_key: 'target', default_label: 'Target Amount' },
  ],

  
}
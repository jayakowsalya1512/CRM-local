// Open a work order in Orders & Projects: the order drawer opens on the Orders list (/workorders?open=<id>).
import type { NavigateFunction } from 'react-router-dom'

export async function openWorkOrder(navigate: NavigateFunction, woId: number) {
  navigate(`/workorders?open=${woId}`)
}

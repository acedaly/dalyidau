'use client'
import { useRowLabel } from '@payloadcms/ui'

/** Shows each menu item's label in the collapsed row instead of "Item 01". */
export const NavRowLabel = () => {
  const { data, rowNumber } = useRowLabel<{ label?: string }>()
  return <span>{data?.label || `Menu item ${String((rowNumber ?? 0) + 1).padStart(2, '0')}`}</span>
}

'use client'
import { useRowLabel } from '@payloadcms/ui'

/** Shows "old address → destination" in the collapsed row instead of "Redirect 01". */
export const RedirectRowLabel = () => {
  const { data, rowNumber } = useRowLabel<{ from?: string; to?: string; enabled?: boolean }>()
  if (!data?.from) return <span>{`Redirect ${String((rowNumber ?? 0) + 1).padStart(2, '0')}`}</span>
  return (
    <span>
      {data.from} → {data.to || '…'}
      {data.enabled === false ? ' (switched off)' : ''}
    </span>
  )
}

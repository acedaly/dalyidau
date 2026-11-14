import type { Field, GlobalBeforeChangeHook } from 'payload'

// Who made a change, kept on the document so every version in its history carries it (Payload's versions
// record when, and what; this adds who). Set by the server from the signed-in person, never from the request.

export const changedByField: Field = {
  name: 'changedBy',
  label: 'Last changed by',
  type: 'text',
  access: { create: () => false, update: () => false },
  admin: { readOnly: true, position: 'sidebar', condition: (data) => Boolean(data?.changedBy), description: 'Recorded with every save. Earlier versions, with who made them and when, are under Versions.' },
}

export const recordChangedBy: GlobalBeforeChangeHook = ({ data, req }) => {
  data.changedBy = (req.user as { email?: string } | null)?.email ?? 'system'
  return data
}

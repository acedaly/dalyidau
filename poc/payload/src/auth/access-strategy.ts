// Phase 0, experiment 3: Payload signs people in with Cloudflare Access, through the existing code.
//
// Payload's own passwords are switched off (Users.auth.disableLocalStrategy). Every request is
// re-authenticated from the Access JWT by the portal's own `authenticate` (signature, audience, issuer,
// expiry), and the role comes from the wedding database's portal_users / PORTAL_OWNER_EMAILS exactly
// as it does for the portal. Payload's users table is only a mirror keyed by email: it grants nothing.
import { getCloudflareContext } from '@opennextjs/cloudflare'
import type { AuthStrategy } from 'payload'

import type { Env } from '../../../../worker/env'
import { authenticate } from '../../../../worker/portal/auth'

export const ACCESS_STRATEGY = 'cloudflare-access'

export const accessStrategy: AuthStrategy = {
  name: ACCESS_STRATEGY,
  async authenticate({ headers, payload }) {
    const { env } = await getCloudflareContext({ async: true })
    // authenticate() reads only the Cf-Access-Jwt-Assertion header (and the request path, for its log).
    const request = new Request('https://payload.internal/admin', { headers })
    const result = await authenticate(request, env as unknown as Env)
    if (!result.ok) return { user: null }

    const { email, role, permissions } = result.user
    const found = await payload.find({ collection: 'users', where: { email: { equals: email } }, limit: 1, depth: 0, overrideAccess: true })
    let doc = found.docs[0]
    if (!doc) {
      doc = await payload.create({ collection: 'users', data: { email, portalRole: role }, overrideAccess: true, draft: false })
    } else if (doc.portalRole !== role) {
      doc = await payload.update({ collection: 'users', id: doc.id, data: { portalRole: role }, overrideAccess: true })
    }
    // The live role and permissions ride on the request's user; the stored copy is only for display.
    return { user: { ...doc, portalRole: role, permissions, collection: 'users', _strategy: ACCESS_STRATEGY } }
  },
}

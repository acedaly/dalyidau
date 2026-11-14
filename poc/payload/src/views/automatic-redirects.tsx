// Under the Redirects list: the redirects the site keeps by itself when a post, page or project is renamed
// (worker/site/redirects.ts automaticRedirects). Read-only: they follow the content they belong to.
import { type AutomaticRedirect, automaticRedirects } from '../../../../worker/site/redirects'
import { cloudflareEnv } from '../cloudflare-env'

const KIND = { post: 'Blog post', page: 'Page', project: 'Project' } as const
const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'Australia/Sydney' }).format(new Date(iso)) : '—')

export async function AutomaticRedirects() {
  let rows: AutomaticRedirect[] | null = null
  try {
    rows = await automaticRedirects((await cloudflareEnv<{ DB: D1Database }>()).DB as never)
  } catch {
    rows = null
  }
  return (
    <section aria-labelledby="daly-auto-redirects" className="daly-redirects">
      <h3 id="daly-auto-redirects">Kept automatically</h3>
      <p className="daly-redirects__lede">
        When a post, page or project is renamed, its old address keeps leading to it. These can’t be edited here: they follow the content. While something is unpublished its old
        addresses are kept but answer “not found”, and they work again when it’s published.
      </p>
      {rows === null ? (
        <p role="status">Couldn’t read the website’s redirects just now. Reload to try again.</p>
      ) : rows.length === 0 ? (
        <p role="status">None yet.</p>
      ) : (
        <div className="daly-redirects__scroll">
          <table className="daly-redirects__table">
            <thead>
              <tr>
                <th scope="col">Old address</th>
                <th scope="col">Goes to</th>
                <th scope="col">Belongs to</th>
                <th scope="col">Status</th>
                <th scope="col">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}:${row.from}`}>
                  <td>{row.from}</td>
                  <td>{row.to ?? '—'}</td>
                  <td>
                    {KIND[row.kind]}
                    {row.title ? `: ${row.title}` : ''}
                  </td>
                  <td>{row.to ? 'Redirecting (301)' : 'Kept; its content is off the site'}</td>
                  <td>{day(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

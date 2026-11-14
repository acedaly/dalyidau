'use client'

// The Republish button under "Website sync" (dashboard-site-sync.tsx): asks the server to publish again
// whatever the website has wrong, then shows what happened.
import { useRouter } from 'next/navigation'
import { useState } from 'react'

type Result = { inStep: boolean; fixed: unknown[]; failed: Array<{ title?: string; slug?: string; message: string }> }

export function RepublishButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle')
  const [message, setMessage] = useState('')

  async function republish() {
    setState('working')
    setMessage('')
    try {
      const response = await fetch('/api/globals/site-settings/republish', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`The server answered ${response.status}.`)
      const result = (await response.json()) as Result
      if (result.inStep) {
        setState('idle')
        router.refresh()
        return
      }
      setState('failed')
      setMessage(
        result.failed.length
          ? result.failed.map((f) => `${f.title || f.slug || 'An item'}: ${f.message}`).join(' ')
          : 'Some things are still out of step. Try again in a minute.',
      )
      router.refresh()
    } catch (error) {
      setState('failed')
      setMessage(`Republishing didn’t work. ${(error as Error).message} Try again in a minute.`)
    }
  }

  return (
    <div className="daly-sync__action">
      <button className="btn btn--style-primary btn--size-medium" disabled={state === 'working'} onClick={republish} type="button">
        <span className="btn__content">
          <span className="btn__label">{state === 'working' ? 'Republishing…' : 'Republish'}</span>
        </span>
      </button>
      <p aria-live="polite" className="daly-sync__message">
        {message}
      </p>
    </div>
  )
}

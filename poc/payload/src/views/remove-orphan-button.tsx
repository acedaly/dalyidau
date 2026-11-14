'use client'

// "Remove from the website" beside an item the website has but Payload has no document for
// (dashboard-site-sync.tsx). Owners only. Two presses, so it can't happen by accident; the server keeps a
// full copy of what it removes (worker/site/orphans.ts).
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function RemoveOrphanButton({ kind, siteId, title }: { kind: 'post' | 'page' | 'project'; siteId: string; title: string }) {
  const router = useRouter()
  const [step, setStep] = useState<'idle' | 'confirm' | 'working'>('idle')
  const [message, setMessage] = useState('')

  async function remove() {
    setStep('working')
    setMessage('')
    try {
      const response = await fetch('/api/globals/site-settings/remove-orphan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, siteId }),
      })
      const result = (await response.json().catch(() => null)) as { removed?: boolean; reason?: string } | null
      if (!response.ok || !result?.removed) throw new Error(result?.reason ?? `The server answered ${response.status}.`)
      router.refresh()
    } catch (error) {
      setStep('idle')
      setMessage(`It wasn’t removed. ${(error as Error).message}`)
    }
  }

  return (
    <span className="daly-sync__remove">
      {step === 'idle' ? (
        <button className="btn btn--style-secondary btn--size-small" onClick={() => setStep('confirm')} type="button">
          <span className="btn__content">
            <span className="btn__label">Remove from the website…</span>
          </span>
        </button>
      ) : (
        <>
          <button className="btn btn--style-primary btn--size-small" disabled={step === 'working'} onClick={remove} type="button">
            <span className="btn__content">
              <span className="btn__label">{step === 'working' ? 'Removing…' : `Yes, remove “${title}”`}</span>
            </span>
          </button>
          <button className="btn btn--style-secondary btn--size-small" disabled={step === 'working'} onClick={() => setStep('idle')} type="button">
            <span className="btn__content">
              <span className="btn__label">Keep it</span>
            </span>
          </button>
        </>
      )}
      <span aria-live="polite" className="daly-sync__message">
        {message}
      </span>
    </span>
  )
}

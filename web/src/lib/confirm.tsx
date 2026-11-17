import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

// Потвърждение в самото приложение. Не ползваме window.confirm: във вградени браузъри
// (напр. Simple Browser във VS Code) той не се показва и връща „Отказ“ без нищо да се случи.
type Req = { text: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }

export function useConfirm(): [(text: string, opts?: { ok?: string; danger?: boolean }) => Promise<boolean>, ReactNode] {
  const [req, setReq] = useState<Req | null>(null)
  const okBtn = useRef<HTMLButtonElement>(null)

  const ask = useCallback((text: string, opts?: { ok?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setReq({ text, ok: opts?.ok ?? 'Да', danger: opts?.danger, resolve })), [])

  const close = (v: boolean) => { req?.resolve(v); setReq(null) }

  useEffect(() => {
    if (!req) return
    okBtn.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { req.resolve(false); setReq(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [req])

  const node = req && (
    <div className="modal-backdrop confirm-backdrop" role="alertdialog" aria-modal="true" aria-label="Потвърждение" onClick={() => close(false)}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{req.text}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn outline" onClick={() => close(false)}>Отказ</button>
          <button ref={okBtn} className={req.danger ? 'btn danger-solid' : 'btn'} onClick={() => close(true)}>{req.ok}</button>
        </div>
      </div>
    </div>
  )
  return [ask, node]
}

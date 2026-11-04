import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AuditorClientMessage, AuditorServerMessage, Session } from '../contracts/messages'
import { wsUrl } from '../api/http'
import { WsClient } from '../transport/ws-client'
import type { ConnectionStatus } from '../transport/status'
import { ActivityTracker, attachActivity } from './activity'
import { dismissNotice, initialVerificationState, reduceVerification, type VerificationState } from './reducer'

type Action = { kind: 'msg'; msg: AuditorServerMessage } | { kind: 'dismiss'; id: number }

function reducer(state: VerificationState, action: Action): VerificationState {
  return action.kind === 'msg' ? reduceVerification(state, action.msg) : dismissNotice(state, action.id)
}

/** WebSocket /ws/verification + state + activity-based heartbeat. Used by the auditor and the coordinator. */
export function useVerification(session: Session, role: 'auditor' | 'coordinator', onUnauthorized: () => void) {
  const [state, dispatch] = useReducer(reducer, initialVerificationState)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [statusDetail, setStatusDetail] = useState('')
  const client = useRef<WsClient<AuditorServerMessage, AuditorClientMessage> | null>(null)
  const tracker = useRef(new ActivityTracker())
  const heartbeatMs = state.me?.heartbeatMs ?? 10_000
  const unauthorized = useRef(onUnauthorized)
  useEffect(() => {
    unauthorized.current = onUnauthorized
  }, [onUnauthorized])

  useEffect(() => {
    const ws = new WsClient<AuditorServerMessage, AuditorClientMessage>({
      url: wsUrl('/ws/verification', role === 'coordinator' ? { token: session.token, role } : { token: session.token }),
      onMessage: (msg) => dispatch({ kind: 'msg', msg }),
      onStatus: (s, info) => {
        setStatus(s)
        setStatusDetail(s === 'reconnecting' && info.delayMs !== undefined ? `(en ${Math.ceil(info.delayMs / 1000)} s)` : '')
        if (s === 'closed' && info.code === 4401) unauthorized.current()
      },
      fatalCodes: [4401],
    })
    client.current = ws
    ws.start()
    return () => ws.stop()
  }, [session.token, role])

  useEffect(() => {
    const detach = attachActivity(tracker.current)
    const timer = setInterval(() => {
      client.current?.send({ type: 'heartbeat', active: tracker.current.consume() })
    }, heartbeatMs)
    return () => {
      detach()
      clearInterval(timer)
    }
  }, [heartbeatMs])

  const send = useCallback((msg: AuditorClientMessage) => client.current?.send(msg) ?? false, [])
  const dismiss = useCallback((id: number) => dispatch({ kind: 'dismiss', id }), [])

  return { state, status, statusDetail, send, dismiss }
}

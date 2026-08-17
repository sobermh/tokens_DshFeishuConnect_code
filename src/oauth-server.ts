/**
 * Throwaway localhost HTTP server that catches one OAuth redirect. The
 * authorize URL carries `http://localhost:<port>/callback`; the browser lands
 * here with `?code=…`, the waiter resolves, and the server closes. One-shot:
 * a second concurrent login must close the previous server first.
 * @module
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'

/** A listening callback server plus the promise that yields the code. */
export interface CallbackServer {
  /** Resolves with the authorization code, rejects on denial or close. */
  code: Promise<string>
  /** Close the server; rejects the pending waiter if unresolved. */
  close: () => void
  /** Port actually bound. */
  port: number
}

/**
 * Start the one-shot callback server.
 * @param port - port to bind on localhost.
 * @returns the listening server handle.
 */
export function startCallbackServer(port: number): Promise<CallbackServer> {
  return new Promise((resolveStart, rejectStart) => {
    let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const received = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (received !== null && received !== '') {
        res.end('<html><body><h2>Feishu authorization complete — you can close this tab.</h2><h2>飞书授权完成，可以关闭此页面了。</h2></body></html>')
        settle?.resolve(received)
      } else {
        res.end('<html><body><h2>Feishu authorization failed / 授权失败。</h2></body></html>')
        settle?.reject(new Error(`Feishu OAuth callback carried no code${error === null ? '' : ` (${error})`}`))
      }
      settle = undefined
      // The single expected redirect has landed either way.
      server.close()
    })
    server.once('error', (error) => rejectStart(error))
    server.listen(port, '127.0.0.1', () => {
      resolveStart({
        code,
        port,
        close: () => {
          settle?.reject(new Error('Feishu OAuth login cancelled'))
          settle = undefined
          server.close()
        },
      })
    })
  })
}

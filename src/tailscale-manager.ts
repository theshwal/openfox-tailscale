import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileException,
  type SpawnOptions,
} from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as nodeSleep } from 'node:timers/promises'

const DEFAULT_STABILIZE_TIMEOUT_MS = 4000
const DEFAULT_REMOVAL_VERIFY_TIMEOUT_MS = 2500
const DEFAULT_POLL_MS = 200
const CANDIDATE_HTTPS_PORTS = [443, 8443, 10000, 10443, 12345]

// eslint-disable-next-line no-control-regex
const URL_REGEX = /https?:\/\/[^\s\x1b]+/g
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g

export interface TailscaleLogger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export interface PreviewResult {
  url: string
  remotePort: number
}

export interface ActivePreview extends PreviewResult {
  workdir: string
}

export interface PortEntry {
  port: number
  host: string | null
}

export interface ServeEntryMatch {
  webKey?: string
  tcpKey?: string
}

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void
export type ExecFileRunner = (
  command: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; encoding: 'utf8' },
  callback: ExecFileCallback,
) => ChildProcess
export type SpawnRunner = (command: string, args: string[], options: SpawnOptions) => ChildProcess
export type SleepRunner = (delay?: number) => Promise<unknown>
export type KillRunner = (pid: number, signal: NodeJS.Signals) => boolean | void

export interface TailscalePreviewManagerOptions {
  spawn?: SpawnRunner
  execFile?: ExecFileRunner
  sleep?: SleepRunner
  kill?: KillRunner
  logger?: TailscaleLogger
  stabilizeTimeoutMs?: number
  removalTimeoutMs?: number
  pollMs?: number
}

interface PreviewHandle extends ActivePreview {
  child: ChildProcess
}

interface PendingStart {
  cancelled: boolean
  child: ChildProcess | null
  remotePort: number | null
  done: Promise<PreviewResult> | null
}

interface StatusContainer {
  TCP?: Record<string, unknown>
  Web?: Record<string, unknown>
}

interface ServeStatus extends StatusContainer {
  Foreground?: Record<string, StatusContainer>
}

interface TailscaleStatus {
  BackendState?: string
  Self?: {
    DNSName?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, '')
}

function extractFirstUrl(raw: string): string | null {
  URL_REGEX.lastIndex = 0
  const match = URL_REGEX.exec(stripAnsi(raw))
  return match ? match[0].replace(/[.,;]+$/, '') : null
}

function asStatusContainer(value: unknown): StatusContainer | null {
  return isRecord(value) ? (value as StatusContainer) : null
}

function collectPortEntries(parent: StatusContainer | null, out: PortEntry[]): void {
  if (!parent) return

  const tcp = parent.TCP
  if (isRecord(tcp)) {
    for (const key of Object.keys(tcp)) {
      const port = Number.parseInt(key, 10)
      if (!Number.isNaN(port)) out.push({ port, host: null })
    }
  }

  const web = parent.Web
  if (isRecord(web)) {
    for (const key of Object.keys(web)) {
      const colon = key.lastIndexOf(':')
      if (colon === -1) continue
      const port = Number.parseInt(key.slice(colon + 1), 10)
      if (!Number.isNaN(port)) out.push({ port, host: key.slice(0, colon) })
    }
  }
}

export function iterateStatusPorts(status: unknown): PortEntry[] {
  if (!isRecord(status)) return []
  const typedStatus = status as ServeStatus
  const out: PortEntry[] = []

  collectPortEntries(typedStatus, out)

  const foreground = typedStatus.Foreground
  if (isRecord(foreground)) {
    for (const entry of Object.values(foreground)) {
      collectPortEntries(asStatusContainer(entry), out)
    }
  }

  return out
}

export function findEntryForPort(status: unknown, port: number): ServeEntryMatch {
  const result: ServeEntryMatch = {}

  for (const entry of iterateStatusPorts(status)) {
    if (entry.port !== port) continue
    if (entry.host) result.webKey = `${entry.host}:${entry.port}`
    else result.tcpKey = String(entry.port)
  }

  return result
}

export function pickFreeServePort(usedPorts: Iterable<number>): number {
  const used = new Set(usedPorts)

  for (const candidate of CANDIDATE_HTTPS_PORTS) {
    if (!used.has(candidate)) return candidate
  }

  for (let port = 443; port <= 65535; port += 1) {
    if (!used.has(port)) return port
  }

  throw new Error('No free HTTPS port available for Tailscale serve')
}

export class TailscalePreviewManager {
  private readonly spawn: SpawnRunner
  private readonly execFile: ExecFileRunner
  private readonly sleep: SleepRunner
  private readonly kill: KillRunner
  private readonly logger: TailscaleLogger
  private readonly stabilizeTimeoutMs: number
  private readonly removalTimeoutMs: number
  private readonly pollMs: number
  private readonly handles = new Map<string, PreviewHandle>()
  private readonly pending = new Map<string, PendingStart>()

  constructor(options: TailscalePreviewManagerOptions = {}) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.execFile =
      options.execFile ??
      ((command, args, execOptions, callback) =>
        nodeExecFile(command, args, execOptions, callback))
    this.sleep = options.sleep ?? ((delay = 0) => nodeSleep(delay))
    this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
    this.logger = options.logger ?? {
      debug() {},
      info() {},
      warn() {},
      error() {},
    }
    this.stabilizeTimeoutMs = options.stabilizeTimeoutMs ?? DEFAULT_STABILIZE_TIMEOUT_MS
    this.removalTimeoutMs = options.removalTimeoutMs ?? DEFAULT_REMOVAL_VERIFY_TIMEOUT_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
  }

  private key(workdir: string): string {
    return resolve(workdir)
  }

  isActive(workdir: string): boolean {
    return this.handles.has(this.key(workdir))
  }

  getActive(workdir: string): ActivePreview | null {
    const handle = this.handles.get(this.key(workdir))
    if (!handle) return null
    return { workdir: handle.workdir, url: handle.url, remotePort: handle.remotePort }
  }

  listActive(): ActivePreview[] {
    return Array.from(this.handles.values()).map(({ workdir, url, remotePort }) => ({
      workdir,
      url,
      remotePort,
    }))
  }

  private execText(args: string[], timeout = 4000): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      this.execFile('tailscale', args, { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolvePromise(stdout)
      })
    })
  }

  async isAvailable(): Promise<{ available: true; nodeName: string } | { available: false; reason: string }> {
    try {
      const stdout = await this.execText(['status', '--json'])
      const parsed = JSON.parse(stdout) as TailscaleStatus

      if (parsed.BackendState !== 'Running') {
        return {
          available: false,
          reason: `Tailscale backend not running (${parsed.BackendState ?? 'unknown'})`,
        }
      }

      const nodeName = parsed.Self?.DNSName?.replace(/\.$/, '')
      if (!nodeName) {
        return { available: false, reason: 'Tailscale node name not found' }
      }

      return { available: true, nodeName }
    } catch (error: unknown) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async readServeStatus(): Promise<unknown> {
    const stdout = await this.execText(['serve', 'status', '--json'])
    return JSON.parse(stdout) as unknown
  }

  private async listUsedServePorts(): Promise<number[]> {
    try {
      const status = await this.readServeStatus()
      return Array.from(new Set(iterateStatusPorts(status).map((entry) => entry.port)))
    } catch {
      return []
    }
  }

  private async waitForEntry(port: number, timeoutMs = this.stabilizeTimeoutMs): Promise<ServeEntryMatch | null> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        const found = findEntryForPort(await this.readServeStatus(), port)
        if (found.webKey || found.tcpKey) return found
      } catch {
        // Transient Tailscale status failures are retried until timeout.
      }
      await this.sleep(this.pollMs)
    }

    return null
  }

  private async waitForEntryGone(port: number, timeoutMs = this.removalTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        const found = findEntryForPort(await this.readServeStatus(), port)
        if (!found.webKey && !found.tcpKey) return true
      } catch {
        // Treat status failures as still present: cleanup must fail safe.
      }
      await this.sleep(this.pollMs)
    }

    return false
  }

  private async killChild(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null) return

    let exited = false
    const onExit = (): void => {
      exited = true
    }
    child.once('exit', onExit)

    try {
      this.kill(child.pid, 'SIGTERM')
    } catch {
      exited = true
    }

    if (!exited) await this.sleep(250)

    if (!exited) {
      try {
        this.kill(child.pid, 'SIGKILL')
      } catch {
        exited = true
      }
    }

    if (!exited) await this.sleep(250)
    child.removeListener('exit', onExit)
  }

  private async forceRemoveEntry(handle: Pick<PreviewHandle, 'remotePort'>): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      let child: ChildProcess
      try {
        child = this.spawn(
          'tailscale',
          ['serve', '--yes', `--https=${handle.remotePort}`, 'off'],
          { stdio: 'ignore', windowsHide: true },
        )
      } catch {
        resolvePromise()
        return
      }

      const finish = (): void => resolvePromise()
      child.once('exit', finish)
      child.once('error', finish)
    })

    await this.waitForEntryGone(handle.remotePort)
  }

  async start(workdir: string, targetPort: number): Promise<PreviewResult> {
    const key = this.key(workdir)
    if (this.handles.has(key) || this.pending.has(key)) {
      throw new Error('A Tailscale preview is already active or starting for this workdir')
    }

    const control: PendingStart = {
      cancelled: false,
      child: null,
      remotePort: null,
      done: null,
    }
    this.pending.set(key, control)

    const operation = this.startInternal(key, targetPort, control)
    control.done = operation

    try {
      return await operation
    } finally {
      if (this.pending.get(key) === control) {
        this.pending.delete(key)
      }
    }
  }

  private async startInternal(key: string, targetPort: number, control: PendingStart): Promise<PreviewResult> {
    let child: ChildProcess | null = null
    let remotePort: number | null = null

    try {
      if (control.cancelled) throw new Error('Tailscale preview start cancelled')

      remotePort = pickFreeServePort(await this.listUsedServePorts())
      control.remotePort = remotePort

      if (control.cancelled) throw new Error('Tailscale preview start cancelled')

      const args = ['serve', '--yes', `--https=${remotePort}`, `http://localhost:${targetPort}`]

      child = this.spawn('tailscale', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      control.child = child

      let stdoutBuffer = ''
      let stderrBuffer = ''
      let exited = false
      let exitCode: number | null = null

      child.stdout?.on('data', (data: Buffer | string) => {
        stdoutBuffer += data.toString()
      })
      child.stderr?.on('data', (data: Buffer | string) => {
        stderrBuffer += data.toString()
      })

      type EarlyExit = { kind: 'exit'; code: number | null; stderr: string }
      type Stabilized = { kind: 'status'; found: ServeEntryMatch | null }

      const earlyExit = new Promise<EarlyExit>((resolvePromise) => {
        child!.once('error', (error: Error) => {
          exited = true
          resolvePromise({ kind: 'exit', code: -1, stderr: error.message })
        })
        child!.once('exit', (code: number | null) => {
          exited = true
          exitCode = code
          resolvePromise({ kind: 'exit', code, stderr: stderrBuffer })
        })
      })

      const stabilized = this.waitForEntry(remotePort).then<Stabilized>((found) => ({
        kind: 'status',
        found,
      }))

      const outcome = await Promise.race([earlyExit, stabilized])

      if (control.cancelled) {
        throw new Error('Tailscale preview start cancelled')
      }

      if (outcome.kind === 'exit') {
        throw new Error(
          `tailscale serve exited before becoming active (code=${outcome.code ?? 'n/a'})` +
            (outcome.stderr.trim() ? `: ${outcome.stderr.trim()}` : ''),
        )
      }

      const found = outcome.found
      if (!found || (!found.webKey && !found.tcpKey)) {
        const detail = exited ? ` (process exit code=${exitCode ?? 'n/a'})` : ''
        throw new Error(`tailscale serve did not register the entry in time${detail}`)
      }

      const urlFromStdout = extractFirstUrl(stdoutBuffer)
      const urlFromStatus = found.webKey ? `https://${found.webKey}/` : null
      const url = urlFromStdout ?? urlFromStatus

      if (!url) {
        throw new Error('tailscale serve did not expose a usable HTTPS URL')
      }

      if (control.cancelled) {
        throw new Error('Tailscale preview start cancelled')
      }

      const handle: PreviewHandle = {
        child,
        remotePort,
        url,
        workdir: key,
      }
      this.handles.set(key, handle)

      this.logger.info('Tailscale preview started', { workdir: key, remotePort, url })
      return { url, remotePort }
    } catch (error: unknown) {
      if (child) {
        try {
          await this.killChild(child)
        } catch {
          // Continue with status-based targeted cleanup.
        }
      }

      if (remotePort !== null) {
        const gone = await this.waitForEntryGone(remotePort)
        if (!gone) {
          await this.forceRemoveEntry({ remotePort })
        }
      }

      throw error
    }
  }

  async stop(workdir: string): Promise<void> {
    const key = this.key(workdir)
    const pending = this.pending.get(key)

    if (pending) {
      pending.cancelled = true
      if (pending.child) {
        try {
          await this.killChild(pending.child)
        } catch {
          // startInternal will perform status-based targeted cleanup.
        }
      }
      try {
        await pending.done
      } catch {
        // Cancellation is expected; startInternal owns cleanup.
      }
    }

    const handle = this.handles.get(key)
    if (!handle) return

    this.handles.delete(key)

    try {
      await this.killChild(handle.child)
    } catch (error: unknown) {
      this.logger.warn('Failed to stop foreground Tailscale process cleanly', {
        workdir: key,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (!(await this.waitForEntryGone(handle.remotePort))) {
      await this.forceRemoveEntry(handle)
    }

    this.logger.info('Tailscale preview stopped', {
      workdir: key,
      remotePort: handle.remotePort,
    })
  }

  async stopAll(): Promise<void> {
    const workdirs = Array.from(new Set([...this.handles.keys(), ...this.pending.keys()]))
    await Promise.allSettled(workdirs.map((workdir) => this.stop(workdir)))
  }
}

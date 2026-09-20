import { execFile as nodeExecFile, spawn as nodeSpawn, } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as nodeSleep } from 'node:timers/promises';
const DEFAULT_STABILIZE_TIMEOUT_MS = 4000;
const DEFAULT_REMOVAL_VERIFY_TIMEOUT_MS = 2500;
const DEFAULT_POLL_MS = 200;
const CANDIDATE_HTTPS_PORTS = [443, 8443, 10000, 10443, 12345];
// eslint-disable-next-line no-control-regex
const URL_REGEX = /https?:\/\/[^\s\x1b]+/g;
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[A-Za-z]/g;
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function stripAnsi(value) {
    return value.replace(ANSI_REGEX, '');
}
function extractFirstUrl(raw) {
    URL_REGEX.lastIndex = 0;
    const match = URL_REGEX.exec(stripAnsi(raw));
    return match ? match[0].replace(/[.,;]+$/, '') : null;
}
function asStatusContainer(value) {
    return isRecord(value) ? value : null;
}
function collectPortEntries(parent, out) {
    if (!parent)
        return;
    const tcp = parent.TCP;
    if (isRecord(tcp)) {
        for (const key of Object.keys(tcp)) {
            const port = Number.parseInt(key, 10);
            if (!Number.isNaN(port))
                out.push({ port, host: null });
        }
    }
    const web = parent.Web;
    if (isRecord(web)) {
        for (const key of Object.keys(web)) {
            const colon = key.lastIndexOf(':');
            if (colon === -1)
                continue;
            const port = Number.parseInt(key.slice(colon + 1), 10);
            if (!Number.isNaN(port))
                out.push({ port, host: key.slice(0, colon) });
        }
    }
}
export function iterateStatusPorts(status) {
    if (!isRecord(status))
        return [];
    const typedStatus = status;
    const out = [];
    collectPortEntries(typedStatus, out);
    const foreground = typedStatus.Foreground;
    if (isRecord(foreground)) {
        for (const entry of Object.values(foreground)) {
            collectPortEntries(asStatusContainer(entry), out);
        }
    }
    return out;
}
export function findEntryForPort(status, port) {
    const result = {};
    for (const entry of iterateStatusPorts(status)) {
        if (entry.port !== port)
            continue;
        if (entry.host)
            result.webKey = `${entry.host}:${entry.port}`;
        else
            result.tcpKey = String(entry.port);
    }
    return result;
}
export function pickFreeServePort(usedPorts) {
    const used = new Set(usedPorts);
    for (const candidate of CANDIDATE_HTTPS_PORTS) {
        if (!used.has(candidate))
            return candidate;
    }
    for (let port = 443; port <= 65535; port += 1) {
        if (!used.has(port))
            return port;
    }
    throw new Error('No free HTTPS port available for Tailscale serve');
}
export class TailscalePreviewManager {
    spawn;
    execFile;
    sleep;
    kill;
    logger;
    stabilizeTimeoutMs;
    removalTimeoutMs;
    pollMs;
    handles = new Map();
    pending = new Map();
    constructor(options = {}) {
        this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
        this.execFile =
            options.execFile ??
                ((command, args, execOptions, callback) => nodeExecFile(command, args, execOptions, callback));
        this.sleep = options.sleep ?? ((delay = 0) => nodeSleep(delay));
        this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
        this.logger = options.logger ?? {
            debug() { },
            info() { },
            warn() { },
            error() { },
        };
        this.stabilizeTimeoutMs = options.stabilizeTimeoutMs ?? DEFAULT_STABILIZE_TIMEOUT_MS;
        this.removalTimeoutMs = options.removalTimeoutMs ?? DEFAULT_REMOVAL_VERIFY_TIMEOUT_MS;
        this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    }
    key(workdir) {
        return resolve(workdir);
    }
    isActive(workdir) {
        return this.handles.has(this.key(workdir));
    }
    getActive(workdir) {
        const handle = this.handles.get(this.key(workdir));
        if (!handle)
            return null;
        return { workdir: handle.workdir, url: handle.url, remotePort: handle.remotePort };
    }
    listActive() {
        return Array.from(this.handles.values()).map(({ workdir, url, remotePort }) => ({
            workdir,
            url,
            remotePort,
        }));
    }
    execText(args, timeout = 4000) {
        return new Promise((resolvePromise, reject) => {
            this.execFile('tailscale', args, { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolvePromise(stdout);
            });
        });
    }
    async isAvailable() {
        try {
            const stdout = await this.execText(['status', '--json']);
            const parsed = JSON.parse(stdout);
            if (parsed.BackendState !== 'Running') {
                return {
                    available: false,
                    reason: `Tailscale backend not running (${parsed.BackendState ?? 'unknown'})`,
                };
            }
            const nodeName = parsed.Self?.DNSName?.replace(/\.$/, '');
            if (!nodeName) {
                return { available: false, reason: 'Tailscale node name not found' };
            }
            return { available: true, nodeName };
        }
        catch (error) {
            return {
                available: false,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async readServeStatus() {
        const stdout = await this.execText(['serve', 'status', '--json']);
        return JSON.parse(stdout);
    }
    async listUsedServePorts() {
        try {
            const status = await this.readServeStatus();
            return Array.from(new Set(iterateStatusPorts(status).map((entry) => entry.port)));
        }
        catch {
            return [];
        }
    }
    async waitForEntry(port, timeoutMs = this.stabilizeTimeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const found = findEntryForPort(await this.readServeStatus(), port);
                if (found.webKey || found.tcpKey)
                    return found;
            }
            catch {
                // Transient Tailscale status failures are retried until timeout.
            }
            await this.sleep(this.pollMs);
        }
        return null;
    }
    async waitForEntryGone(port, timeoutMs = this.removalTimeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const found = findEntryForPort(await this.readServeStatus(), port);
                if (!found.webKey && !found.tcpKey)
                    return true;
            }
            catch {
                // Treat status failures as still present: cleanup must fail safe.
            }
            await this.sleep(this.pollMs);
        }
        return false;
    }
    async killChild(child) {
        if (!child.pid || child.exitCode !== null)
            return;
        let exited = false;
        const onExit = () => {
            exited = true;
        };
        child.once('exit', onExit);
        try {
            this.kill(child.pid, 'SIGTERM');
        }
        catch {
            exited = true;
        }
        if (!exited)
            await this.sleep(250);
        if (!exited) {
            try {
                this.kill(child.pid, 'SIGKILL');
            }
            catch {
                exited = true;
            }
        }
        if (!exited)
            await this.sleep(250);
        child.removeListener('exit', onExit);
    }
    async forceRemoveEntry(handle) {
        await new Promise((resolvePromise) => {
            let child;
            try {
                child = this.spawn('tailscale', ['serve', '--yes', `--https=${handle.remotePort}`, 'off'], { stdio: 'ignore', windowsHide: true });
            }
            catch {
                resolvePromise();
                return;
            }
            const finish = () => resolvePromise();
            child.once('exit', finish);
            child.once('error', finish);
        });
        await this.waitForEntryGone(handle.remotePort);
    }
    async start(workdir, targetPort) {
        const key = this.key(workdir);
        if (this.handles.has(key) || this.pending.has(key)) {
            throw new Error('A Tailscale preview is already active or starting for this workdir');
        }
        const control = {
            cancelled: false,
            child: null,
            remotePort: null,
            done: null,
        };
        this.pending.set(key, control);
        const operation = this.startInternal(key, targetPort, control);
        control.done = operation;
        try {
            return await operation;
        }
        finally {
            if (this.pending.get(key) === control) {
                this.pending.delete(key);
            }
        }
    }
    async startInternal(key, targetPort, control) {
        let child = null;
        let remotePort = null;
        try {
            if (control.cancelled)
                throw new Error('Tailscale preview start cancelled');
            remotePort = pickFreeServePort(await this.listUsedServePorts());
            control.remotePort = remotePort;
            if (control.cancelled)
                throw new Error('Tailscale preview start cancelled');
            const args = ['serve', '--yes', `--https=${remotePort}`, `http://localhost:${targetPort}`];
            child = this.spawn('tailscale', args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            control.child = child;
            let stdoutBuffer = '';
            let stderrBuffer = '';
            let exited = false;
            let exitCode = null;
            child.stdout?.on('data', (data) => {
                stdoutBuffer += data.toString();
            });
            child.stderr?.on('data', (data) => {
                stderrBuffer += data.toString();
            });
            const earlyExit = new Promise((resolvePromise) => {
                child.once('error', (error) => {
                    exited = true;
                    resolvePromise({ kind: 'exit', code: -1, stderr: error.message });
                });
                child.once('exit', (code) => {
                    exited = true;
                    exitCode = code;
                    resolvePromise({ kind: 'exit', code, stderr: stderrBuffer });
                });
            });
            const stabilized = this.waitForEntry(remotePort).then((found) => ({
                kind: 'status',
                found,
            }));
            const outcome = await Promise.race([earlyExit, stabilized]);
            if (control.cancelled) {
                throw new Error('Tailscale preview start cancelled');
            }
            if (outcome.kind === 'exit') {
                throw new Error(`tailscale serve exited before becoming active (code=${outcome.code ?? 'n/a'})` +
                    (outcome.stderr.trim() ? `: ${outcome.stderr.trim()}` : ''));
            }
            const found = outcome.found;
            if (!found || (!found.webKey && !found.tcpKey)) {
                const detail = exited ? ` (process exit code=${exitCode ?? 'n/a'})` : '';
                throw new Error(`tailscale serve did not register the entry in time${detail}`);
            }
            const urlFromStdout = extractFirstUrl(stdoutBuffer);
            const urlFromStatus = found.webKey ? `https://${found.webKey}/` : null;
            const url = urlFromStdout ?? urlFromStatus;
            if (!url) {
                throw new Error('tailscale serve did not expose a usable HTTPS URL');
            }
            if (control.cancelled) {
                throw new Error('Tailscale preview start cancelled');
            }
            const handle = {
                child,
                remotePort,
                url,
                workdir: key,
            };
            this.handles.set(key, handle);
            this.logger.info('Tailscale preview started', { workdir: key, remotePort, url });
            return { url, remotePort };
        }
        catch (error) {
            if (child) {
                try {
                    await this.killChild(child);
                }
                catch {
                    // Continue with status-based targeted cleanup.
                }
            }
            if (remotePort !== null) {
                const gone = await this.waitForEntryGone(remotePort);
                if (!gone) {
                    await this.forceRemoveEntry({ remotePort });
                }
            }
            throw error;
        }
    }
    async stop(workdir) {
        const key = this.key(workdir);
        const pending = this.pending.get(key);
        if (pending) {
            pending.cancelled = true;
            if (pending.child) {
                try {
                    await this.killChild(pending.child);
                }
                catch {
                    // startInternal will perform status-based targeted cleanup.
                }
            }
            try {
                await pending.done;
            }
            catch {
                // Cancellation is expected; startInternal owns cleanup.
            }
        }
        const handle = this.handles.get(key);
        if (!handle)
            return;
        this.handles.delete(key);
        try {
            await this.killChild(handle.child);
        }
        catch (error) {
            this.logger.warn('Failed to stop foreground Tailscale process cleanly', {
                workdir: key,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (!(await this.waitForEntryGone(handle.remotePort))) {
            await this.forceRemoveEntry(handle);
        }
        this.logger.info('Tailscale preview stopped', {
            workdir: key,
            remotePort: handle.remotePort,
        });
    }
    async stopAll() {
        const workdirs = Array.from(new Set([...this.handles.keys(), ...this.pending.keys()]));
        await Promise.allSettled(workdirs.map((workdir) => this.stop(workdir)));
    }
}

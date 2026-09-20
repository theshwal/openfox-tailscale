import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  TailscalePreviewManager,
  findEntryForPort,
  iterateStatusPorts,
  pickFreeServePort,
} from '../src/tailscale-manager.js'

const FIXTURE = {
  TCP: {
    443: { HTTPS: true },
  },
  Web: {
    'node.tailnet.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:10369' } },
    },
  },
  Foreground: {
    abc123: {
      TCP: {
        8443: { HTTPS: true },
      },
      Web: {
        'node.tailnet.ts.net:8443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:10469' } },
        },
      },
    },
  },
}

function makeExecFile(responses) {
  let index = 0
  return (_command, _args, _options, callback) => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (response.error) callback(response.error, '', '')
    else callback(null, response.stdout ?? '', response.stderr ?? '')
  }
}

function makeChild({ stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter()
  child.pid = 9999
  child.exitCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()

  if (stdout) setImmediate(() => child.stdout.emit('data', Buffer.from(stdout)))
  if (stderr) setImmediate(() => child.stderr.emit('data', Buffer.from(stderr)))
  return child
}

test('iterateStatusPorts reads root and Foreground entries', () => {
  const ports = iterateStatusPorts(FIXTURE)
  assert.deepEqual(
    [...new Set(ports.map((entry) => entry.port))].sort((a, b) => a - b),
    [443, 8443],
  )
})

test('findEntryForPort resolves a foreground Web entry', () => {
  assert.deepEqual(findEntryForPort(FIXTURE, 8443), {
    webKey: 'node.tailnet.ts.net:8443',
    tcpKey: '8443',
  })
})

test('pickFreeServePort preserves pre-existing entries', () => {
  assert.equal(pickFreeServePort([443, 8443]), 10000)
})

test('isAvailable reports a running Tailscale node', async () => {
  const manager = new TailscalePreviewManager({
    execFile: makeExecFile([
      {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'node.tailnet.ts.net.' },
        }),
      },
    ]),
  })

  assert.deepEqual(await manager.isAvailable(), {
    available: true,
    nodeName: 'node.tailnet.ts.net',
  })
})

test('start uses a free port and stop removes only its own foreground entry', async () => {
  let active = false
  const spawnCalls = []
  const foregroundChild = makeChild({ stdout: 'https://node.tailnet.ts.net:8443/\n' })

  const spawn = (command, args) => {
    spawnCalls.push([command, args])

    if (args.at(-1) === 'off') {
      const cleanupChild = makeChild()
      setImmediate(() => {
        active = false
        cleanupChild.exitCode = 0
        cleanupChild.emit('exit', 0)
      })
      return cleanupChild
    }

    setImmediate(() => {
      active = true
    })
    return foregroundChild
  }

  const execFile = (_command, args, _options, callback) => {
    if (args[0] === 'serve' && args[1] === 'status') {
      const status = active
        ? FIXTURE
        : {
            TCP: { 443: { HTTPS: true } },
            Web: {
              'node.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:10369' } },
              },
            },
          }
      callback(null, JSON.stringify(status), '')
      return
    }
    callback(new Error(`unexpected command: ${args.join(' ')}`), '', '')
  }

  const manager = new TailscalePreviewManager({
    spawn,
    execFile,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    kill: () => {
      active = false
      foregroundChild.exitCode = 0
      foregroundChild.emit('exit', 0)
    },
    stabilizeTimeoutMs: 100,
    removalTimeoutMs: 100,
    pollMs: 1,
  })

  const result = await manager.start('/tmp/project', 10469)
  assert.equal(result.remotePort, 8443)
  assert.equal(result.url, 'https://node.tailnet.ts.net:8443/')
  assert.equal(manager.isActive('/tmp/project'), true)

  await manager.stop('/tmp/project')

  assert.equal(manager.isActive('/tmp/project'), false)
  assert.equal(spawnCalls[0][0], 'tailscale')
  assert.deepEqual(spawnCalls[0][1], [
    'serve',
    '--yes',
    '--https=8443',
    'http://localhost:10469',
  ])
  assert.equal(spawnCalls.some(([, args]) => args.includes('reset')), false)
})


test('stop cancels an in-flight preview start without leaving an orphan', async () => {
  let active = false
  const spawnCalls = []
  const foregroundChild = makeChild({ stdout: 'https://node.tailnet.ts.net:8443/\n' })

  const spawn = (command, args) => {
    spawnCalls.push([command, args])
    return foregroundChild
  }

  const execFile = (_command, args, _options, callback) => {
    if (args[0] === 'serve' && args[1] === 'status') {
      const status = active
        ? FIXTURE
        : {
            TCP: { 443: { HTTPS: true } },
            Web: {
              'node.tailnet.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:10369' } },
              },
            },
          }
      callback(null, JSON.stringify(status), '')
      return
    }
    callback(new Error(`unexpected command: ${args.join(' ')}`), '', '')
  }

  const manager = new TailscalePreviewManager({
    spawn,
    execFile,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    kill: () => {
      active = false
      foregroundChild.exitCode = 0
      foregroundChild.emit('exit', 0)
    },
    stabilizeTimeoutMs: 100,
    removalTimeoutMs: 100,
    pollMs: 1,
  })

  const startResult = manager.start('/tmp/racy-project', 10469).then(
    () => null,
    (error) => error,
  )

  await new Promise((resolve) => setImmediate(resolve))
  await manager.stop('/tmp/racy-project')

  const error = await startResult
  assert.ok(error instanceof Error)
  assert.match(error.message, /cancelled|exited/)
  assert.equal(manager.isActive('/tmp/racy-project'), false)
  assert.equal(spawnCalls.some(([, args]) => args.includes('reset')), false)
})

import { TailscalePreviewManager } from './tailscale-manager.js';
let previewManager = null;
let activeContext = null;
function asString(value) {
    return typeof value === 'string' ? value : null;
}
function asPort(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}
function publishPanel(context, manager) {
    const active = manager.listActive();
    const latest = active.at(-1);
    context.publish('tailscale-preview', 'status', active.length > 0 ? 'Active' : 'Inactive');
    context.publish('tailscale-preview', 'activeCount', String(active.length));
    context.publish('tailscale-preview', 'workdir', latest?.workdir ?? '—');
    context.publish('tailscale-preview', 'url', latest?.url ?? '—');
}
function notifyError(context, title, error) {
    const message = error instanceof Error ? error.message : String(error);
    context.logger.warn(title, { error: message });
    context.notify({
        title: { en: title, fr: title },
        body: { en: message, fr: message },
        level: 'error',
    });
}
async function handleStarted(payload, context, manager) {
    const workdir = asString(payload.data?.workdir);
    const targetPort = asPort(payload.data?.port);
    const projectId = typeof payload.projectId === 'string' && payload.projectId ? payload.projectId : null;
    if (!workdir || !targetPort) {
        context.logger.warn('Ignoring devserver.started with incomplete payload', { data: payload.data });
        return;
    }
    if (!projectId) {
        context.logger.debug('Skipping Tailscale preview: OpenFox did not resolve a projectId', { workdir });
        return;
    }
    const settings = context.settings('project', projectId);
    if (settings.enabled !== true) {
        context.logger.debug('Tailscale preview disabled for project', { projectId, workdir });
        return;
    }
    if (manager.isActive(workdir)) {
        publishPanel(context, manager);
        return;
    }
    const availability = await manager.isAvailable();
    if (!availability.available) {
        context.notify({
            title: { en: 'Tailscale preview unavailable', fr: 'Aperçu Tailscale indisponible' },
            body: {
                en: availability.reason ?? 'The Tailscale CLI or daemon is unavailable.',
                fr: availability.reason ?? 'Le CLI ou le service Tailscale est indisponible.',
            },
            level: 'warning',
        });
        return;
    }
    const result = await manager.start(workdir, targetPort);
    publishPanel(context, manager);
    context.notify({
        title: { en: 'Tailscale preview ready', fr: 'Aperçu Tailscale prêt' },
        body: { en: result.url, fr: result.url },
        level: 'success',
    });
}
async function handleStopped(payload, context, manager) {
    const workdir = asString(payload.data?.workdir);
    if (!workdir)
        return;
    await manager.stop(workdir);
    publishPanel(context, manager);
}
export function register(registry) {
    const context = registry.context;
    const manager = new TailscalePreviewManager({ logger: context.logger });
    previewManager = manager;
    activeContext = context;
    registry.registerSettings({
        fields: [
            {
                key: 'enabled',
                type: 'boolean',
                scope: 'project',
                default: false,
                label: {
                    en: 'Expose dev server via Tailscale',
                    fr: 'Exposer le serveur de développement via Tailscale',
                },
                description: {
                    en: 'Automatically expose this project dev server to your tailnet when it starts.',
                    fr: 'Expose automatiquement le serveur de développement de ce projet sur votre tailnet à son démarrage.',
                },
            },
        ],
    });
    registry.registerUiAction({
        id: 'tailscale-preview-status',
        slot: 'session.header.actions',
        label: { en: 'Tailscale', fr: 'Tailscale' },
        tooltip: { en: 'Show Tailscale preview status', fr: 'Afficher l’état de l’aperçu Tailscale' },
        icon: 'external',
        visibleWhen: { hasSession: true },
        onActivate: { kind: 'openPanel', panelId: 'tailscale-preview' },
    });
    registry.registerUiPanel({
        id: 'tailscale-preview',
        title: { en: 'Tailscale Preview', fr: 'Aperçu Tailscale' },
        size: 'md',
        kind: 'declarative',
        content: [
            {
                type: 'text',
                text: {
                    en: 'Project previews are exposed only to your Tailscale tailnet. Tailscale Funnel is never used.',
                    fr: 'Les aperçus de projet sont exposés uniquement sur votre tailnet Tailscale. Tailscale Funnel n’est jamais utilisé.',
                },
                muted: true,
            },
            {
                type: 'keyValue',
                items: [
                    { key: { en: 'Status', fr: 'État' }, value: '{{status}}' },
                    { key: { en: 'Active previews', fr: 'Aperçus actifs' }, value: '{{activeCount}}' },
                    { key: { en: 'Workdir', fr: 'Répertoire' }, value: '{{workdir}}' },
                    { key: { en: 'Tailnet URL', fr: 'URL Tailnet' }, value: '{{url}}' },
                ],
            },
        ],
    });
    // OpenFox 2.0.151 predates these two hook names in the published type union.
    // The core PR adds them without changing the generic PluginHookPayload shape.
    const registerDevServerHook = registry.registerHook.bind(registry);
    registerDevServerHook('devserver.started', (payload) => {
        void handleStarted(payload, context, manager).catch((error) => {
            notifyError(context, 'Failed to start Tailscale preview', error);
            publishPanel(context, manager);
        });
    });
    registerDevServerHook('devserver.stopped', (payload) => {
        void handleStopped(payload, context, manager).catch((error) => {
            notifyError(context, 'Failed to stop Tailscale preview', error);
            publishPanel(context, manager);
        });
    });
    publishPanel(context, manager);
}
export async function deactivate() {
    const manager = previewManager;
    previewManager = null;
    if (manager) {
        await manager.stopAll();
    }
    if (activeContext && manager) {
        publishPanel(activeContext, manager);
    }
    activeContext = null;
}

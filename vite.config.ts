import type { Connect } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';
import { execFile } from 'node:child_process';
import { clawlibraryConfig } from './scripts/clawlibrary-config.mjs';
import { createOpenClawSnapshot, findSnapshotResource, resolveOpenClawPath } from './scripts/openclaw-telemetry.mjs';

const TEXT_PREVIEW_LIMIT_BYTES = 180 * 1024;
const LIVE_OVERVIEW_CACHE_TTL_MS = 20 * 1000;
const LIVE_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const LIVE_OVERVIEW_CACHE_PATH = path.join(
  clawlibraryConfig.openclaw.home,
  'cache',
  'clawlibrary-live-overview.json'
);
const LIVE_DETAIL_CACHE_ROOT = path.join(
  clawlibraryConfig.openclaw.home,
  'cache',
  'clawlibrary-resource-details'
);
const TAIL_PREVIEW_EXTENSIONS = new Set(['.txt', '.log', '.jsonl']);
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};
const TEXT_CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bash': 'text/plain; charset=utf-8',
  '.zsh': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8'
};

type PreviewKind = 'markdown' | 'json' | 'text';
type PreviewReadMode = 'full' | 'head' | 'tail';
type CachedSnapshot = Awaited<ReturnType<typeof createOpenClawSnapshot>>;

let cachedLiveOverview: CachedSnapshot | null = null;
let cachedLiveOverviewLoaded = false;
let liveOverviewRefreshPromise: Promise<CachedSnapshot> | null = null;
const cachedLiveDetailByKey = new Map<string, CachedSnapshot>();
const cachedLiveDetailLoadedKeys = new Set<string>();
const liveDetailRefreshPromisesByKey = new Map<string, Promise<CachedSnapshot>>();

function contentTypeForPath(target: string): string {
  const ext = path.extname(target).toLowerCase();
  return IMAGE_CONTENT_TYPES[ext] || TEXT_CONTENT_TYPES[ext] || 'application/octet-stream';
}

function previewKindForPath(target: string): PreviewKind | null {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.md') {
    return 'markdown';
  }
  if (ext === '.json') {
    return 'json';
  }
  if (ext in TEXT_CONTENT_TYPES) {
    return 'text';
  }
  return null;
}

async function readTextPreview(
  target: string,
  requestedMode: Exclude<PreviewReadMode, 'full'>,
  limit = TEXT_PREVIEW_LIMIT_BYTES
): Promise<{ content: string; truncated: boolean; readMode: PreviewReadMode }> {
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(limit, stat.size);
    const offset = requestedMode === 'tail'
      ? Math.max(0, stat.size - bytesToRead)
      : 0;
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, offset);
    return {
      content: buffer.toString('utf8'),
      truncated: stat.size > limit,
      readMode: stat.size > limit ? requestedMode : 'full'
    };
  } finally {
    await handle.close();
  }
}

function formatPreviewContent(kind: PreviewKind, raw: string): string {
  if (kind === 'json') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

async function buildDirectoryPreview(target: string, rawPath: string) {
  const entries = await fs.readdir(target, { withFileTypes: true });
  const readmeEntry = entries.find((entry) => entry.isFile() && /^readme(?:\.[A-Za-z0-9_-]+)?$/i.test(entry.name));

  if (readmeEntry) {
    const readmePath = path.join(target, readmeEntry.name);
    const kind = previewKindForPath(readmePath) ?? 'text';
    const preview = await readTextPreview(readmePath, 'head');
    return {
      ok: true,
      kind,
      path: rawPath,
      contentType: contentTypeForPath(readmePath),
      content: formatPreviewContent(kind, preview.content),
      truncated: preview.truncated,
      readMode: preview.readMode
    };
  }

  const childDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const childFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const runtimeHints = [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'README.md',
    'README',
    'src',
    'app.py',
    'main.py'
  ].filter((name) => childFiles.includes(name) || childDirs.includes(name));

  const summary = [
    `# ${path.basename(target)}`,
    '',
    'No README found for this directory.',
    '',
    `Path: \`${rawPath}\``,
    '',
    runtimeHints.length ? `Detected project signals: ${runtimeHints.map((entry) => `\`${entry}\``).join(', ')}` : 'Detected project signals: none',
    '',
    childDirs.length ? 'Subdirectories:' : 'Subdirectories: none',
    ...(childDirs.length ? childDirs.slice(0, 8).map((entry) => `- \`${entry}/\``) : []),
    '',
    childFiles.length ? 'Files:' : 'Files: none',
    ...(childFiles.length ? childFiles.slice(0, 10).map((entry) => `- \`${entry}\``) : [])
  ].join('\n');

  return {
    ok: true,
    kind: 'markdown' as const,
    path: rawPath,
    contentType: 'text/markdown; charset=utf-8',
    content: summary,
    truncated: false,
    readMode: 'full' as const
  };
}

async function loadCachedSnapshot(cachePath: string): Promise<CachedSnapshot | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(raw) as CachedSnapshot;
  } catch {
    return null;
  }
}

async function loadCachedLiveOverview(): Promise<void> {
  if (cachedLiveOverviewLoaded) {
    return;
  }
  cachedLiveOverviewLoaded = true;
  cachedLiveOverview = await loadCachedSnapshot(LIVE_OVERVIEW_CACHE_PATH);
}

function detailCacheKeyOf(resourceId: string): string {
  return resourceId === 'gateway' ? 'gateway+task_queues' : resourceId;
}

function detailResourceIdsFor(resourceId: string): string[] {
  return resourceId === 'gateway' ? ['gateway', 'task_queues'] : [resourceId];
}

function detailCachePathOf(cacheKey: string): string {
  return path.join(LIVE_DETAIL_CACHE_ROOT, `${cacheKey}.json`);
}

async function loadCachedLiveDetail(cacheKey: string): Promise<CachedSnapshot | null> {
  if (cachedLiveDetailLoadedKeys.has(cacheKey)) {
    return cachedLiveDetailByKey.get(cacheKey) ?? null;
  }
  cachedLiveDetailLoadedKeys.add(cacheKey);
  const snapshot = await loadCachedSnapshot(detailCachePathOf(cacheKey));
  if (snapshot) {
    cachedLiveDetailByKey.set(cacheKey, snapshot);
  }
  return snapshot;
}

async function persistLiveDetail(cacheKey: string, snapshot: CachedSnapshot): Promise<void> {
  await fs.mkdir(LIVE_DETAIL_CACHE_ROOT, { recursive: true });
  await persistCachedSnapshot(detailCachePathOf(cacheKey), snapshot);
}

async function refreshLiveDetail(cacheKey: string, resourceIds: string[]): Promise<CachedSnapshot> {
  const pending = liveDetailRefreshPromisesByKey.get(cacheKey);
  if (pending) {
    return pending;
  }
  const request = createOpenClawSnapshot({
    mock: false,
    itemResourceIds: resourceIds,
    includeExcerpt: false
  })
    .then(async (snapshot) => {
      cachedLiveDetailByKey.set(cacheKey, snapshot);
      await persistLiveDetail(cacheKey, snapshot);
      return snapshot;
    })
    .finally(() => {
      liveDetailRefreshPromisesByKey.delete(cacheKey);
    });
  liveDetailRefreshPromisesByKey.set(cacheKey, request);
  return request;
}

async function getLiveDetailSnapshot(resourceId: string): Promise<CachedSnapshot> {
  const cacheKey = detailCacheKeyOf(resourceId);
  const resourceIds = detailResourceIdsFor(resourceId);
  const cached = await loadCachedLiveDetail(cacheKey);
  if (cached && cachedSnapshotAgeMs(cached) < LIVE_DETAIL_CACHE_TTL_MS) {
    return cached;
  }
  if (cached) {
    void refreshLiveDetail(cacheKey, resourceIds);
    return cached;
  }
  return refreshLiveDetail(cacheKey, resourceIds);
}

function cachedSnapshotAgeMs(snapshot: CachedSnapshot | null): number {
  if (!snapshot?.generatedAt) {
    return Number.POSITIVE_INFINITY;
  }
  const time = new Date(snapshot.generatedAt).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : Date.now() - time;
}

async function persistCachedSnapshot(cachePath: string, snapshot: CachedSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(snapshot), 'utf8');
}

async function refreshLiveOverview(): Promise<CachedSnapshot> {
  if (liveOverviewRefreshPromise) {
    return liveOverviewRefreshPromise;
  }
  liveOverviewRefreshPromise = createOpenClawSnapshot({ mock: false, includeItems: false })
    .then(async (snapshot) => {
      cachedLiveOverview = snapshot;
      await persistCachedSnapshot(LIVE_OVERVIEW_CACHE_PATH, snapshot);
      return snapshot;
    })
    .finally(() => {
      liveOverviewRefreshPromise = null;
    });
  return liveOverviewRefreshPromise;
}

void loadCachedLiveOverview()
  .then(async () => {
    if (!cachedLiveOverview || cachedSnapshotAgeMs(cachedLiveOverview) >= LIVE_OVERVIEW_CACHE_TTL_MS) {
      await refreshLiveOverview();
    }
  })
  .catch(() => {
    // ignore warmup failures; middleware will retry on demand
  });

function telemetryMiddleware() {
  return async (req: Connect.IncomingMessage, res: Connect.ServerResponse, next: Connect.NextFunction) => {
    if (req.url?.startsWith('/api/openclaw/open') && req.method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const target = resolveOpenClawPath(body.openPath || body.path || '');
        if (!target) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'invalid path' }));
          return;
        }
        await new Promise<void>((resolve, reject) => {
          execFile('open', [target], (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.url?.startsWith('/api/openclaw/file') && req.method === 'GET') {
      try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const rawPath = requestUrl.searchParams.get('path') || '';
        const target = resolveOpenClawPath(rawPath);
        if (!target) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'invalid path' }));
          return;
        }
        const file = await fs.readFile(target);
        res.statusCode = 200;
        res.setHeader('Content-Type', contentTypeForPath(target));
        res.setHeader('Cache-Control', 'no-store');
        res.end(file);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.url?.startsWith('/api/openclaw/preview') && req.method === 'GET') {
      try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const rawPath = requestUrl.searchParams.get('path') || '';
        const target = resolveOpenClawPath(rawPath);
        if (!target) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'invalid path' }));
          return;
        }

        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(await buildDirectoryPreview(target, rawPath)));
          return;
        }

        const ext = path.extname(target).toLowerCase();
        const kind = previewKindForPath(target) ?? 'text';
        const requestedMode = TAIL_PREVIEW_EXTENSIONS.has(ext) ? 'tail' : 'head';
        const preview = await readTextPreview(target, requestedMode);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({
          ok: true,
          kind,
          path: rawPath,
          contentType: contentTypeForPath(target),
          content: formatPreviewContent(kind, preview.content),
          truncated: preview.truncated,
          readMode: preview.readMode
        }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.url?.startsWith('/api/openclaw/resource') && req.method === 'GET') {
      try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const wantsMock = requestUrl.searchParams.get('mock') === '1';
        const resourceId = requestUrl.searchParams.get('resourceId') || '';
        if (!resourceId) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'missing resourceId' }));
          return;
        }

        let snapshot: CachedSnapshot;
        if (wantsMock) {
          snapshot = await createOpenClawSnapshot({
            mock: true,
            itemResourceIds: resourceId === 'gateway' ? ['gateway', 'task_queues'] : [resourceId],
            includeExcerpt: false
          });
        } else {
          snapshot = await getLiveDetailSnapshot(resourceId);
        }

        const resource = findSnapshotResource(snapshot, resourceId);
        if (!resource) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: 'resource not found' }));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ ok: true, resource }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.url?.startsWith('/api/openclaw/processes') && req.method === 'GET') {
      try {
        // Read the exec-processes registry written by ClawBot when launching background agents
        const registryPath = path.join(clawlibraryConfig.openclaw.home, 'exec-processes.json');
        type ProcessEntry = { id: string; label: string; command: string; status: string; startedAt?: string };
        let processes: ProcessEntry[] = [];
        try {
          const raw = await fs.readFile(registryPath, 'utf8');
          const all = JSON.parse(raw) as ProcessEntry[];
          processes = all.filter((p) => p.status === 'running');
        } catch {
          // file doesn't exist — return empty list
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ ok: true, processes }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (!req.url?.startsWith('/api/openclaw/snapshot')) {
      next();
      return;
    }

    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const wantsMock = requestUrl.searchParams.get('mock') === '1';
      let snapshot: CachedSnapshot;
      if (wantsMock) {
        snapshot = await createOpenClawSnapshot({ mock: true, includeItems: false });
      } else {
        await loadCachedLiveOverview();
        if (cachedLiveOverview && cachedSnapshotAgeMs(cachedLiveOverview) < LIVE_OVERVIEW_CACHE_TTL_MS) {
          snapshot = cachedLiveOverview;
        } else if (cachedLiveOverview) {
          void refreshLiveOverview();
          snapshot = cachedLiveOverview;
        } else {
          snapshot = await refreshLiveOverview();
        }
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(wantsMock ? snapshot : {
        ...snapshot,
        resources: snapshot.resources.map(({ items, ...resource }) => resource)
      }));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
}

export default defineConfig({
  plugins: [
    {
      name: 'openclaw-telemetry-bridge',
      configureServer(server) {
        server.middlewares.use(telemetryMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(telemetryMiddleware());
      }
    }
  ],
  build: {
    emptyOutDir: false
  },
  server: {
    host: clawlibraryConfig.server.host,
    port: clawlibraryConfig.server.port
  }
});

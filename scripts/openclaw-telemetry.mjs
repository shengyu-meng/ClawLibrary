import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { clawlibraryConfig } from './clawlibrary-config.mjs';

const OPENCLAW_ROOT = clawlibraryConfig.openclaw.home;
const WORKSPACE_ROOT = clawlibraryConfig.openclaw.workspace;
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const CACHE_ROOT = path.join(OPENCLAW_ROOT, 'cache');
const WORKSPACE_TREE_CACHE_PATH = path.join(CACHE_ROOT, 'clawlibrary-workspace-tree.json');

const RESOURCE_META = {
  document: { label: 'Documents Archive', source: 'workspace/**/* heuristic document scan' },
  images: { label: 'Images', source: 'workspace/**/* heuristic image scan' },
  memory: { label: 'Memory', source: 'workspace/**/* heuristic memory scan' },
  skills: { label: 'Skills', source: 'workspace/**/* SKILL.md + .openclaw/skills' },
  gateway: { label: 'Interface Gateway', source: '.openclaw runtime + workspace/**/* heuristic config scan' },
  log: { label: 'Log', source: '.openclaw/logs + workspace/**/* heuristic log scan' },
  mcp: { label: 'Code Lab', source: 'workspace/**/* heuristic codebase scan' },
  schedule: { label: 'Scheduler Deck', source: '.openclaw/cron/jobs.json + workspace/**/* heuristic schedule scan' },
  alarm: { label: 'Errors', source: '.openclaw/delivery-queue/failed + error logs' },
  agent: { label: 'Run Dock', source: '.openclaw/agents + .openclaw/subagents/runs.json + .openclaw/tasks/task-queue.json' },
  task_queues: { label: 'Task Queues', source: '.openclaw/tasks/task-queue.json + .openclaw/delivery-queue' },
  break_room: { label: 'Break Room', source: 'crew/break-room' }
};

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.DS_Store',
  'user-data',
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  'playwright-report',
  'test-results'
]);

const ITEM_CACHE_TTL_MS = 30 * 1000;
const PERSISTENT_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
const itemCache = new Map();
const WORKSPACE_SCAN_MAX_DEPTH = 8;
const WORKSPACE_RESOURCE_ITEM_LIMIT = 120;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const DOCUMENT_TEXT_EXTENSIONS = new Set(['.md', '.txt', '.pdf']);
const DOCUMENT_STRUCTURED_EXTENSIONS = new Set(['.json', '.jsonl', '.yaml', '.yml', '.csv']);
const LOG_EXTENSIONS = new Set(['.log', '.txt', '.json', '.jsonl']);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.md', '.txt', '.csv']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.sh']);
const WORKSPACE_SCAN_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_TEXT_EXTENSIONS,
  ...DOCUMENT_STRUCTURED_EXTENSIONS,
  ...CONFIG_EXTENSIONS,
  ...CODE_EXTENSIONS,
  '.log'
]);
const DEFAULT_WORKSPACE_TOP_LEVEL_DIRS = new Set([
  'downloads',
  'uploads',
  'temp',
  'tmp',
  'projects',
  'project',
  'output',
  'memory'
]);
const DOCUMENT_HINT_PATTERNS = [
  /(^|\/)(docs?|writing|articles?|blogs?|posts?|drafts?|wechat|weibo|knowledge|insights?|reports?|plans?|proposals?|guides?|notes?|exploration)(\/|$)/i,
  /(^|\/)(readme|todo|changelog|summary|research)(\/|$)/i
];
const MEMORY_HINT_PATTERNS = [
  /(^|\/)(memory|memo(ry)?|diary|journal|notes?|persona|context)(\/|$)/i,
  /(^|\/)(memory|user|soul)\.md$/i,
  /(^|\/)\d{4}-\d{2}-\d{2}\.md$/i
];
const IMAGE_HINT_PATTERNS = [
  /(^|\/)(art|avatars?|images?|illustrations?|assets?|sprites?|characters?|icons?|media|gallery|public|static|generated|covers?|posters?)(\/|$)/i,
  /(sprite|character|avatar|cover|thumbnail|poster|illustration|concept|layout)/i
];
const IMAGE_NOISE_PATTERNS = [
  /(^|\/)(playwright-report|test-results|coverage|snapshots?)(\/|$)/i,
  /(diff|snapshot|trace)/i
];
const LOG_HINT_PATTERNS = [
  /(^|\/)(logs?|trace|debug|output)(\/|$)/i,
  /(stderr|stdout|console|terminal|error|trace|debug|runtime)\./i
];
const GATEWAY_HINT_PATTERNS = [
  /(^|\/)(config|configs|settings?|providers?|models?|auth|devices?|gateway|mcp|connections?)(\/|$)/i,
  /(config|provider|model|auth|device|gateway|mcp|connection)/i
];
const SCHEDULE_HINT_PATTERNS = [
  /(^|\/)(schedule(d)?|cron|jobs?|calendar)(\/|$)/i,
  /(schedule|scheduled|cron|jobs?|calendar)/i
];
const LOW_SIGNAL_PATTERNS = [
  /(^|\/)(tmp|temp|scratch|sandbox)(?:\/|$|-)/i,
  /(^|\/)(cache|caches)(?:\/|$|-)/i,
  /(^|\/)(backup|backups|runtime|state|archives?)(?:\/|$|-)/i,
  /(^|\/)(playwright-report|test-results|coverage|snapshots?)(\/|$)/i
];
const CONFIG_NOISE_PATTERNS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock|uv\.lock|poetry\.lock)$/i,
  /(^|\/)(package\.json|tsconfig.*\.json|jsconfig\.json|vite\.config|vitest\.config|jest\.config|eslint\.config|prettier\.config|pyproject\.toml|requirements\.txt)$/i
];

const lastSignatureByResource = new Map();
const eventLog = [];

function flattenWorkspaceTreeEntries(node) {
  if (!node) {
    return [];
  }
  const entries = [...(node.directEntries ?? [])];
  for (const child of Object.values(node.children ?? {})) {
    entries.push(...flattenWorkspaceTreeEntries(child));
  }
  return entries;
}

function persistentCachePath(namespace, cacheKey) {
  const digest = createHash('sha1').update(String(cacheKey || namespace)).digest('hex').slice(0, 12);
  return path.join(CACHE_ROOT, `${namespace}-${digest}.json`);
}

async function loadPersistentCache(namespace, cacheKey) {
  try {
    const raw = await fs.readFile(persistentCachePath(namespace, cacheKey), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function savePersistentCache(namespace, cacheKey, payload) {
  try {
    await fs.mkdir(CACHE_ROOT, { recursive: true });
    await fs.writeFile(persistentCachePath(namespace, cacheKey), JSON.stringify(payload), 'utf8');
  } catch {
    // ignore cache persistence failures
  }
}

function clampEventLog() {
  while (eventLog.length > 24) {
    eventLog.shift();
  }
}

function toIso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function relPath(targetPath) {
  if (!targetPath) {
    return '';
  }
  const normalized = path.resolve(targetPath);
  if (normalized.startsWith(path.resolve(WORKSPACE_ROOT))) {
    return path.relative(WORKSPACE_ROOT, normalized).replaceAll(path.sep, '/');
  }
  if (normalized.startsWith(path.resolve(OPENCLAW_ROOT))) {
    return `.openclaw/${path.relative(OPENCLAW_ROOT, normalized).replaceAll(path.sep, '/')}`;
  }
  return normalized.replaceAll(path.sep, '/');
}

export function resolveOpenClawPath(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith('.openclaw/')) {
    return path.join(OPENCLAW_ROOT, raw.slice('.openclaw/'.length));
  }

  if (raw.startsWith('skills/')) {
    return path.join(WORKSPACE_ROOT, raw);
  }

  if (raw.startsWith('workspace/')) {
    return path.join(WORKSPACE_ROOT, raw.slice('workspace/'.length));
  }

  if (raw.startsWith('crew/')) {
    return WORKSPACE_ROOT;
  }

  return path.join(WORKSPACE_ROOT, raw);
}

function item(id, title, pathValue, updatedAt, meta = '', openPath = pathValue, sizeBytes = 0) {
  return {
    id,
    title,
    path: pathValue,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    sizeBytes,
    meta,
    openPath,
    folderPath: pathValue.includes('/') ? pathValue.split('/').slice(0, -1).join('/') : pathValue,
    excerpt: '',
    thumbnailPath: '',
    stats: []
  };
}

async function safeTextRead(targetPath, limit = 4000) {
  try {
    return await fs.readFile(targetPath, 'utf8').then((text) => text.slice(0, limit));
  } catch {
    return '';
  }
}

async function safeTailTextRead(targetPath, limit = 4000) {
  try {
    const handle = await fs.open(targetPath, 'r');
    try {
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - limit);
      const buffer = Buffer.alloc(Math.min(limit, stat.size));
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function summarizeText(raw) {
  const cleaned = String(raw || '')
    .replace(/^---[\s\S]*?---/, ' ')
    .replace(/[#>*`\-\[\]\(\)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 180);
}

function summarizeLogText(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) || lines.at(-2) || '').slice(0, 180);
}

function extractMeaningfulText(value, depth = 0) {
  if (depth > 5 || value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractMeaningfulText(entry, depth + 1);
      if (text) {
        return text;
      }
    }
    return '';
  }

  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'caption', 'message', 'detail', 'error', 'lastError', 'blocked_reason', 'description', 'goal']) {
      const text = extractMeaningfulText(value[key], depth + 1);
      if (text) {
        return text;
      }
    }

    for (const entry of Object.values(value)) {
      const text = extractMeaningfulText(entry, depth + 1);
      if (text) {
        return text;
      }
    }
  }

  return '';
}

function summarizeJsonLinesText(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      const extracted = extractMeaningfulText(parsed);
      if (extracted) {
        return summarizeText(extracted);
      }
    } catch {
      // ignore malformed line
    }
  }

  return summarizeLogText(raw);
}

function cleanMarkdownLine(line) {
  return String(line || '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, '')
    .replace(/[*_`>#]/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeDeliveryMarkdown(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('|'))
    .filter((line) => !/^[:|\-\s]+$/.test(line));

  if (lines.length === 0) {
    return '';
  }

  const firstLine = cleanMarkdownLine(lines[0]).replace(/^\[(.*?)\]$/, '$1');
  const detailLine = lines
    .slice(1)
    .map((line) => cleanMarkdownLine(line))
    .find((line) => line && line !== firstLine && line.length > 12 && !/^(60秒执行摘要|执行摘要|摘要)$/i.test(line));

  if (firstLine && detailLine) {
    return `${firstLine} · ${detailLine}`.slice(0, 180);
  }

  return (firstLine || detailLine || summarizeText(raw)).slice(0, 180);
}

function extractFrontmatterValue(raw, field) {
  const text = String(raw || '');
  const match = text.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---/);
  if (!match) {
    return '';
  }
  const lines = match[1].split(/\r?\n/);
  const prefix = `${field}:`;
  const line = lines.find((entry) => entry.trim().toLowerCase().startsWith(prefix));
  if (!line) {
    return '';
  }
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
}

function summarizeDocumentText(raw) {
  const description = extractFrontmatterValue(raw, 'description') || extractFrontmatterValue(raw, 'summary');
  if (description) {
    return description.slice(0, 180);
  }

  const text = String(raw || '').replace(/^---[\s\S]*?---/, '');
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^date:/i.test(line))
    .filter((line) => !line.startsWith('|'))
    .filter((line) => !/^[:|\-\s]+$/.test(line))
    .filter((line) => line !== '```');

  const title = rawLines
    .find((line) => /^#{1,6}\s+/.test(line));
  const cleanTitle = title ? cleanMarkdownLine(title.replace(/^#{1,6}\s+/, '')) : '';

  const details = rawLines
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^- \[[ xX]\]/.test(line))
    .map((line) => cleanMarkdownLine(line))
    .filter(Boolean)
    .filter((line) => line !== cleanTitle);

  const detail = details.find((line) => line.length > 18) || details[0] || '';

  if (cleanTitle && detail) {
    return `${cleanTitle} · ${detail}`.slice(0, 180);
  }

  return (cleanTitle || detail || '').slice(0, 180);
}

function summarizeSkillText(raw) {
  const description = extractFrontmatterValue(raw, 'description');
  if (description) {
    return description.slice(0, 180);
  }

  const text = String(raw || '')
    .replace(/^---[\s\S]*?---/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .find((line) => line.length > 24);
  return String(text || '').slice(0, 180);
}

function taskPauseSignalText(task) {
  const latestAttempt = Array.isArray(task?.strategies_tried) && task.strategies_tried.length > 0
    ? task.strategies_tried[task.strategies_tried.length - 1]
    : null;

  return [
    task?.blocked_reason,
    task?.user_action_required,
    latestAttempt?.strategy,
    latestAttempt?.result
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function taskDisplayStatus(task) {
  const status = String(task?.status || 'task').toLowerCase();
  if (status !== 'blocked') {
    return status;
  }

  return /(paused|pause|user request|resume|for now)/.test(taskPauseSignalText(task))
    ? 'paused'
    : 'blocked';
}

function taskTitle(task, id) {
  const status = taskDisplayStatus(task);
  const label = String(id || 'task');
  if (status === 'blocked') {
    return `Blocked Task · ${label}`;
  }
  if (status === 'paused') {
    return `Paused Task · ${label}`;
  }
  if (status === 'pending') {
    return `Pending Task · ${label}`;
  }
  if (status === 'running' || status === 'active') {
    return `Running Task · ${label}`;
  }
  if (status === 'completed' || status === 'done') {
    return `Completed Task · ${label}`;
  }
  return `Task · ${label}`;
}

function taskStatusPriority(task) {
  const status = taskDisplayStatus(task);
  if (status === 'blocked') {
    return 0;
  }
  if (status === 'pending') {
    return 1;
  }
  if (status === 'paused') {
    return 2;
  }
  if (status === 'running' || status === 'active') {
    return 3;
  }
  if (status === 'failed' || status === 'error') {
    return 4;
  }
  if (status === 'completed' || status === 'done') {
    return 5;
  }
  return 6;
}

function taskStatusTone(task) {
  const status = taskDisplayStatus(task);
  if (status === 'blocked') return 'danger';
  if (status === 'paused') return 'cool';
  if (status === 'pending') return 'warm';
  if (status === 'completed' || status === 'done') return 'calm';
  if (status === 'running' || status === 'active') return 'active';
  return 'muted';
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function blockedRoutingDetail(blockedTasks) {
  return blockedTasks === 1
    ? '1 blocked task needs routing'
    : `${blockedTasks} blocked tasks need routing`;
}

function thumbnailForPath(rel) {
  const lower = String(rel || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].some((ext) => lower.endsWith(ext))) {
    return `/api/openclaw/file?path=${encodeURIComponent(rel)}`;
  }
  return '';
}

function hostnameOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).host || '';
  } catch {
    return '';
  }
}

function summarizeSessionKey(sessionKey) {
  const raw = String(sessionKey || '');
  const parts = raw.split(':');
  if (raw === 'agent:main:main') {
    return {
      title: 'Main Session',
      excerpt: 'interactive local main-agent session'
    };
  }

  const topicIndex = parts.indexOf('topic');
  if (parts.includes('telegram') && topicIndex !== -1 && parts[topicIndex + 1]) {
    return {
      title: `Telegram Topic ${parts[topicIndex + 1]}`,
      excerpt: `telegram group session · topic ${parts[topicIndex + 1]}`
    };
  }

  if (parts.includes('telegram') && parts.includes('slash')) {
    return {
      title: 'Telegram Slash',
      excerpt: `telegram slash session · ${parts.at(-1) || 'direct'}`
    };
  }

  if (parts.includes('telegram') && parts.includes('group')) {
    return {
      title: 'Telegram Group',
      excerpt: `telegram group session · ${parts.at(-1) || 'group'}`
    };
  }

  if (parts.includes('cron')) {
    return {
      title: 'Cron Session',
      excerpt: `scheduled agent run · ${(parts.at(-1) || '').slice(0, 8)}`
    };
  }

  if (parts.includes('codex')) {
    return {
      title: 'Codex Session',
      excerpt: raw.replace(/:/g, ' · ').slice(0, 180)
    };
  }

  return {
    title: 'Agent Session',
    excerpt: raw.replace(/:/g, ' · ').slice(0, 180)
  };
}

async function collectSessionItems(sessionSources, limit = 8) {
  const collected = [];

  for (const source of sessionSources) {
    const sessionIndex = await safeJsonRead(source.indexPath, {});
    const entries = Object.entries(sessionIndex || {});
    if (entries.length === 0) {
      continue;
    }

    const transcripts = (await safeReadDir(source.dirPath))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.jsonl'))
      .filter((name) => !name.includes('.reset.') && !name.includes('.deleted.'));

    for (const [sessionKey, info] of entries) {
      if (!info || typeof info !== 'object') {
        continue;
      }

      const sessionId = String(info.sessionId || '');
      const updatedAt = Number(info.updatedAt || info.lastUpdatedAt || 0);
      const matchedTranscript = sessionId
        ? transcripts.find((name) => name.startsWith(sessionId))
        : '';
      const targetPath = matchedTranscript
        ? relPath(path.join(source.dirPath, matchedTranscript))
        : relPath(source.indexPath);
      const summary = summarizeSessionKey(sessionKey);
      const next = item(
        `${source.id}-${sessionId || sessionKey}`,
        `${source.label} · ${summary.title}`,
        targetPath,
        updatedAt,
        source.meta,
        targetPath
      );
      next.folderPath = matchedTranscript ? relPath(source.dirPath) : relPath(path.dirname(source.indexPath));
      next.excerpt = matchedTranscript
        ? `${summary.excerpt} · transcript available`
        : `${summary.excerpt} · indexed in sessions.json`;
      collected.push(next);
    }
  }

  return collected
    .sort((left, right) => {
      const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
      const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

function matchesAnyPattern(value, patterns = []) {
  return patterns.some((pattern) => pattern.test(String(value || '')));
}

function isStructuredDocumentExt(ext) {
  return DOCUMENT_STRUCTURED_EXTENSIONS.has(ext);
}

function isLikelyDocumentCandidate(entry) {
  if (!(DOCUMENT_TEXT_EXTENSIONS.has(entry.ext) || isStructuredDocumentExt(entry.ext))) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, LOW_SIGNAL_PATTERNS)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, IMAGE_NOISE_PATTERNS)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, MEMORY_HINT_PATTERNS)) {
    return false;
  }
  if (DOCUMENT_TEXT_EXTENSIONS.has(entry.ext)) {
    return true;
  }
  if (matchesAnyPattern(entry.lowerRel, CONFIG_NOISE_PATTERNS)) {
    return false;
  }
  return matchesAnyPattern(entry.lowerRel, DOCUMENT_HINT_PATTERNS);
}

function isLikelyMemoryCandidate(entry) {
  if (!(DOCUMENT_TEXT_EXTENSIONS.has(entry.ext) || DOCUMENT_STRUCTURED_EXTENSIONS.has(entry.ext))) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, LOW_SIGNAL_PATTERNS)) {
    return false;
  }
  return matchesAnyPattern(entry.lowerRel, MEMORY_HINT_PATTERNS);
}

function isLikelyImageCandidate(entry) {
  if (!IMAGE_EXTENSIONS.has(entry.ext)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, LOW_SIGNAL_PATTERNS)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, IMAGE_NOISE_PATTERNS) && !matchesAnyPattern(entry.lowerRel, IMAGE_HINT_PATTERNS)) {
    return false;
  }
  return true;
}

function isLikelyLogCandidate(entry) {
  if (!LOG_EXTENSIONS.has(entry.ext)) {
    return false;
  }
  return entry.ext === '.log' || matchesAnyPattern(entry.lowerRel, LOG_HINT_PATTERNS);
}

function isLikelyGatewayConfigCandidate(entry) {
  if (!CONFIG_EXTENSIONS.has(entry.ext)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, LOW_SIGNAL_PATTERNS)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, CONFIG_NOISE_PATTERNS)) {
    return false;
  }
  return matchesAnyPattern(entry.lowerRel, GATEWAY_HINT_PATTERNS);
}

function isLikelyScheduleCandidate(entry) {
  if (!CONFIG_EXTENSIONS.has(entry.ext)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, LOW_SIGNAL_PATTERNS)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, CONFIG_NOISE_PATTERNS)) {
    return false;
  }
  return matchesAnyPattern(entry.lowerRel, SCHEDULE_HINT_PATTERNS);
}

function isLikelyCodeCandidate(entry) {
  if (!CODE_EXTENSIONS.has(entry.ext)) {
    return false;
  }
  if (matchesAnyPattern(entry.lowerRel, LOW_SIGNAL_PATTERNS)) {
    return false;
  }
  if (entry.lowerRel.includes('/skills/') || entry.lowerRel.startsWith('skills/') || entry.lowerRel.includes('/.openclaw/skills/')) {
    return false;
  }
  return /(^|\/)(project|projects|src|scripts|config|app|server|client)(\/|$)/i.test(entry.lowerRel);
}

function summarizeCandidateEntries(entries) {
  if (!entries.length) {
    return {
      exists: false,
      itemCount: 0,
      latestMs: 0,
      latestPath: ''
    };
  }

  const latest = entries.reduce((currentLatest, entry) => entry.updatedAt > currentLatest.updatedAt ? entry : currentLatest, entries[0]);
  return {
    exists: true,
    itemCount: entries.length,
    latestMs: latest.updatedAt,
    latestPath: latest.path
  };
}

function dedupeItems(items, limit = items.length) {
  const seen = new Set();
  const next = [];
  for (const entry of items) {
    const key = `${entry.path}|${entry.title}|${entry.meta}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(entry);
    if (next.length >= limit) {
      break;
    }
  }
  return next;
}

function topLevelDirOf(pathValue) {
  const segments = String(pathValue || '')
    .split('/')
    .filter(Boolean);
  return segments[0]?.toLowerCase() || '';
}

function scoreItemByKeywords(entry, keywords = [], weightedRules = []) {
  const haystack = [
    entry.title,
    entry.path,
    entry.meta,
    entry.excerpt
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = Number(entry.userPriorityBoost || 0);

  score += keywords.reduce((currentScore, keyword) => {
    const normalized = String(keyword || '').toLowerCase();
    return haystack.includes(normalized) ? currentScore + 1 : currentScore;
  }, 0);

  for (const rule of weightedRules) {
    const [matcher, weight] = rule;
    if (typeof matcher === 'string') {
      if (haystack.includes(matcher.toLowerCase())) {
        score += weight;
      }
      continue;
    }
    if (matcher instanceof RegExp && matcher.test(haystack)) {
      score += weight;
    }
  }

  return score;
}

function prioritizeItems(items, keywords = [], limit = items.length, weightedRules = []) {
  return [...items]
    .sort((left, right) => {
      const scoreDelta = scoreItemByKeywords(right, keywords, weightedRules) - scoreItemByKeywords(left, keywords, weightedRules);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
      const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

function pathIsWithin(basePath, targetPath) {
  const normalizedBase = String(basePath || '').replace(/\/+$/, '');
  const normalizedTarget = String(targetPath || '').replace(/\/+$/, '');
  if (!normalizedBase || !normalizedTarget) {
    return false;
  }
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
}

async function safeStat(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function safeReadDir(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readGitBranch(repoPath) {
  try {
    const head = (await fs.readFile(path.join(repoPath, '.git', 'HEAD'), 'utf8')).trim();
    if (head.startsWith('ref:')) {
      return head.split('/').at(-1) || 'main';
    }
    return head.slice(0, 7) || 'detached';
  } catch {
    return 'unknown';
  }
}

async function collectGitRepositories(targets, { maxDepth = 3, limit = 10 } = {}) {
  const repos = [];
  const visited = new Set();
  const cacheKey = JSON.stringify({ kind: 'git-repos', targets, maxDepth, limit });
  const cached = itemCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < ITEM_CACHE_TTL_MS) {
    return structuredClone(cached.items);
  }
  const persisted = await loadPersistentCache('clawlibrary-git-repos', cacheKey);
  if (persisted?.key === cacheKey && now - persisted.ts < PERSISTENT_SCAN_CACHE_TTL_MS) {
    itemCache.set(cacheKey, { ts: now, items: structuredClone(persisted.items) });
    return structuredClone(persisted.items);
  }

  async function visit(targetPath, depth) {
    const resolved = path.resolve(targetPath);
    if (visited.has(resolved) || depth > maxDepth) {
      return;
    }
    visited.add(resolved);

    const stat = await safeStat(resolved);
    if (!stat?.isDirectory()) {
      return;
    }

    const base = path.basename(resolved);
    if (depth > 0 && (IGNORED_DIRS.has(base) || matchesAnyPattern(relPath(resolved).toLowerCase(), LOW_SIGNAL_PATTERNS))) {
      return;
    }

    const gitDir = path.join(resolved, '.git');
    const gitStat = await safeStat(gitDir);
    if (gitStat?.isDirectory()) {
      const branch = await readGitBranch(resolved);
      const packageStat = await safeStat(path.join(resolved, 'package.json'));
      const readmeStat = await safeStat(path.join(resolved, 'README.md'));
      const rel = relPath(resolved);
      const next = item(`repo-${repos.length}`, path.basename(resolved), rel, stat.mtimeMs, 'git repository');
      next.folderPath = rel;
      next.excerpt = `${branch} branch${packageStat ? ' · package.json' : ''}${readmeStat ? ' · README' : ''} · self-maintained codebase`;
      next.stats = [
        { label: 'branch', value: branch, tone: 'active' },
        { label: 'readme', value: readmeStat ? 'yes' : 'no', tone: readmeStat ? 'cool' : 'muted' }
      ];
      repos.push(next);
      return;
    }

    const children = (await safeReadDir(resolved)).filter((child) => !child.name.startsWith('.'));
    await Promise.all(children.map((child) => visit(path.join(resolved, child.name), depth + 1)));
  }

  for (const target of targets) {
    await visit(target, 0);
    if (repos.length >= limit) {
      break;
    }
  }

  const items = repos
    .sort((left, right) => (right.updatedAt ? new Date(right.updatedAt).getTime() : 0) - (left.updatedAt ? new Date(left.updatedAt).getTime() : 0))
    .slice(0, limit);
  itemCache.set(cacheKey, { ts: now, items: structuredClone(items) });
  await savePersistentCache('clawlibrary-git-repos', cacheKey, { key: cacheKey, ts: now, items });
  return items;
}

async function collectRunnableProjects(targets, { maxDepth = 3, limit = 10 } = {}) {
  const projects = [];
  const visited = new Set();
  const cacheKey = JSON.stringify({ kind: 'app-projects', targets, maxDepth, limit });
  const cached = itemCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < ITEM_CACHE_TTL_MS) {
    return structuredClone(cached.items);
  }
  const persisted = await loadPersistentCache('clawlibrary-app-projects', cacheKey);
  if (persisted?.key === cacheKey && now - persisted.ts < PERSISTENT_SCAN_CACHE_TTL_MS) {
    itemCache.set(cacheKey, { ts: now, items: structuredClone(persisted.items) });
    return structuredClone(persisted.items);
  }

  async function visit(targetPath, depth) {
    const resolved = path.resolve(targetPath);
    if (visited.has(resolved) || depth > maxDepth || projects.length >= limit) {
      return;
    }
    visited.add(resolved);

    const stat = await safeStat(resolved);
    if (!stat?.isDirectory()) {
      return;
    }

    const base = path.basename(resolved);
    if (depth > 0 && (IGNORED_DIRS.has(base) || matchesAnyPattern(relPath(resolved).toLowerCase(), LOW_SIGNAL_PATTERNS))) {
      return;
    }

    const gitStat = await safeStat(path.join(resolved, '.git'));
    if (gitStat?.isDirectory()) {
      return;
    }

    const packageStat = await safeStat(path.join(resolved, 'package.json'));
    const pyprojectStat = await safeStat(path.join(resolved, 'pyproject.toml'));
    const requirementsStat = await safeStat(path.join(resolved, 'requirements.txt'));
    const mainStat = await safeStat(path.join(resolved, 'main.py'));
    const appStat = await safeStat(path.join(resolved, 'app.py'));
    const srcStat = await safeStat(path.join(resolved, 'src'));

    const hasRuntimeShape = packageStat || pyprojectStat || requirementsStat || mainStat || appStat;
    const hasSourceTree = srcStat?.isDirectory() || mainStat || appStat;

    if (depth > 0 && hasRuntimeShape && hasSourceTree) {
      const rel = relPath(resolved);
      const next = item(`runnable-${projects.length}`, path.basename(resolved), rel, stat.mtimeMs, 'app project');
      next.folderPath = rel;
      next.excerpt = [
        packageStat ? 'package.json' : '',
        pyprojectStat ? 'pyproject.toml' : '',
        requirementsStat ? 'requirements.txt' : '',
        srcStat?.isDirectory() ? 'src/' : '',
        mainStat ? 'main.py' : '',
        appStat ? 'app.py' : ''
      ].filter(Boolean).join(' · ') || 'standalone app project';
      next.stats = [
        { label: 'stack', value: packageStat ? 'node' : (pyprojectStat || requirementsStat || mainStat || appStat) ? 'python' : 'app', tone: 'warm' },
        { label: 'src', value: srcStat?.isDirectory() ? 'yes' : 'lite', tone: 'cool' }
      ];
      projects.push(next);
      return;
    }

    const children = (await safeReadDir(resolved)).filter((child) => !child.name.startsWith('.'));
    await Promise.all(children.map((child) => visit(path.join(resolved, child.name), depth + 1)));
  }

  for (const target of targets) {
    await visit(target, 0);
    if (projects.length >= limit) {
      break;
    }
  }

  const items = projects
    .sort((left, right) => (right.updatedAt ? new Date(right.updatedAt).getTime() : 0) - (left.updatedAt ? new Date(left.updatedAt).getTime() : 0))
    .slice(0, limit);
  itemCache.set(cacheKey, { ts: now, items: structuredClone(items) });
  await savePersistentCache('clawlibrary-app-projects', cacheKey, { key: cacheKey, ts: now, items });
  return items;
}

async function safeJsonRead(targetPath, fallback) {
  try {
    const raw = await fs.readFile(targetPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function collectRecursiveEntries(
  targets,
  {
    maxDepth = 4,
    includeDirs = false,
    limit = 24,
    pathIncludes = [],
    pathExcludes = [],
    exts = []
  } = {}
) {
  const cacheKey = JSON.stringify({
    targets,
    maxDepth,
    includeDirs,
    limit,
    pathIncludes,
    pathExcludes,
    exts
  });
  const cached = itemCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < ITEM_CACHE_TTL_MS) {
    return structuredClone(cached.items);
  }
  const persisted = await loadPersistentCache('clawlibrary-recursive-entries', cacheKey);
  if (persisted?.key === cacheKey && now - persisted.ts < PERSISTENT_SCAN_CACHE_TTL_MS) {
    itemCache.set(cacheKey, { ts: now, items: structuredClone(persisted.items) });
    return structuredClone(persisted.items);
  }

  const entries = [];
  const loweredIncludes = pathIncludes.map((value) => value.toLowerCase());
  const loweredExcludes = pathExcludes.map((value) => value.toLowerCase());
  const loweredExts = exts.map((value) => value.toLowerCase());

  async function visit(targetPath, depth) {
    if (depth > maxDepth) {
      return;
    }

    const stat = await safeStat(targetPath);
    if (!stat) {
      return;
    }

    const rel = relPath(targetPath);
    const lowerRel = rel.toLowerCase();

    if (loweredExcludes.some((value) => lowerRel.includes(value))) {
      return;
    }

    if (stat.isDirectory()) {
      const base = path.basename(targetPath);
      if (IGNORED_DIRS.has(base) || matchesAnyPattern(lowerRel, LOW_SIGNAL_PATTERNS)) {
        return;
      }

      if (includeDirs && loweredIncludes.every((value) => lowerRel.includes(value))) {
        entries.push({
          id: `${rel}-dir`,
          title: base,
          path: rel,
          updatedAt: stat.mtimeMs,
          sizeBytes: 0,
          meta: 'dir',
          openPath: rel
        });
      }

      const children = (await safeReadDir(targetPath)).filter((child) => !child.name.startsWith('.'));
      await Promise.all(children.map((child) => visit(path.join(targetPath, child.name), depth + 1)));
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    if (loweredExts.length > 0 && !loweredExts.includes(ext)) {
      return;
    }

    if (loweredIncludes.length > 0 && !loweredIncludes.some((value) => lowerRel.includes(value))) {
      return;
    }

    entries.push({
      id: rel,
      title: path.basename(targetPath),
      path: rel,
      updatedAt: stat.mtimeMs,
      sizeBytes: stat.size,
      meta: ext.replace('.', '') || 'file',
      openPath: rel
    });
  }

  for (const targetPath of targets) {
    await visit(targetPath, 0);
  }

  const deduped = new Map();
  for (const entry of entries) {
    if (!deduped.has(entry.path)) {
      deduped.set(entry.path, entry);
    }
  }

  const items = await hydrateIndexedEntries(
    [...deduped.values()].sort((left, right) => right.updatedAt - left.updatedAt),
    limit
  );
  itemCache.set(cacheKey, { ts: now, items: structuredClone(items) });
  await savePersistentCache('clawlibrary-recursive-entries', cacheKey, { key: cacheKey, ts: now, items });
  return items;
}

async function hydrateIndexedEntries(entries, limit = entries.length, { includeExcerpt = true } = {}) {
  return Promise.all([...entries]
    .slice(0, limit)
    .map(async (entry) => {
      const next = item(entry.id, entry.title, entry.path, entry.updatedAt, entry.meta, entry.openPath, entry.sizeBytes || 0);
      const abs = resolveOpenClawPath(entry.path);
      const ext = path.extname(entry.path).toLowerCase();
      if (includeExcerpt && ['.md', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.csv'].includes(ext) && abs) {
        const raw = ext === '.txt' || ext === '.log' || ext === '.jsonl'
          ? await safeTailTextRead(abs)
          : await safeTextRead(abs);
        if (ext === '.md') {
          next.excerpt = summarizeDocumentText(raw);
        } else if (ext === '.txt' || ext === '.log') {
          next.excerpt = summarizeLogText(raw);
        } else if (ext === '.jsonl') {
          next.excerpt = summarizeJsonLinesText(raw);
        } else {
          next.excerpt = summarizeText(raw);
        }
      }
      next.thumbnailPath = thumbnailForPath(entry.path);
      return next;
    }));
}

async function scanWorkspaceFiles({ maxDepth = WORKSPACE_SCAN_MAX_DEPTH } = {}) {
  const cacheKey = JSON.stringify({ kind: 'workspace-files', maxDepth });
  const cached = itemCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < ITEM_CACHE_TTL_MS) {
    return structuredClone(cached.items);
  }
  let persistedTree = null;
  try {
    const raw = await fs.readFile(WORKSPACE_TREE_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.key === cacheKey) {
      persistedTree = parsed.tree ?? null;
    }
  } catch {
    persistedTree = null;
  }

  async function visit(targetPath, depth, cachedNode = null) {
    if (depth > maxDepth) {
      return { directEntries: [], children: {}, signature: '' };
    }

    const stat = await safeStat(targetPath);
    if (!stat?.isDirectory()) {
      return { directEntries: [], children: {}, signature: '' };
    }

    if (depth > 0) {
      const base = path.basename(targetPath).toLowerCase();
      const rel = relPath(targetPath).toLowerCase();
      if (IGNORED_DIRS.has(base) || matchesAnyPattern(rel, LOW_SIGNAL_PATTERNS)) {
        return { directEntries: [], children: {}, signature: '' };
      }
    }

    const children = (await safeReadDir(targetPath)).filter((child) => !child.name.startsWith('.'));
    const childDescriptors = await Promise.all(children.map(async (child) => {
      const childPath = path.join(targetPath, child.name);
      const childStat = await safeStat(childPath);
      return childStat ? {
        name: child.name,
        isDirectory: child.isDirectory(),
        mtimeMs: childStat.mtimeMs,
        size: childStat.size
      } : null;
    }));

    const signature = createHash('sha1')
      .update(JSON.stringify(childDescriptors.filter(Boolean)))
      .digest('hex');

    const canReuseDirectEntries = cachedNode && cachedNode.signature === signature;
    const directEntries = canReuseDirectEntries ? [...(cachedNode.directEntries ?? [])] : [];
    const nextChildren = {};

    for (const child of children) {
      const childPath = path.join(targetPath, child.name);
      if (child.isDirectory()) {
        nextChildren[child.name] = await visit(childPath, depth + 1, cachedNode?.children?.[child.name] ?? null);
        continue;
      }

      if (canReuseDirectEntries) {
        continue;
      }

      const childStat = await safeStat(childPath);
      if (!childStat) {
        continue;
      }
      const ext = path.extname(childPath).toLowerCase();
      if (!WORKSPACE_SCAN_EXTENSIONS.has(ext)) {
        continue;
      }
      const rel = relPath(childPath);
      const lowerRel = rel.toLowerCase();
      const topLevel = topLevelDirOf(rel);
      directEntries.push({
        id: rel,
        title: path.basename(childPath),
        path: rel,
        openPath: rel,
        updatedAt: childStat.mtimeMs,
        sizeBytes: childStat.size,
        meta: ext.replace('.', '') || 'file',
        ext,
        base: path.basename(childPath).toLowerCase(),
        lowerRel,
        topLevel,
        userPriorityBoost: topLevel && !DEFAULT_WORKSPACE_TOP_LEVEL_DIRS.has(topLevel) ? 6 : 0
      });
    }

    return {
      signature,
      directEntries,
      children: nextChildren
    };
  }

  const tree = await visit(WORKSPACE_ROOT, 0, persistedTree);
  const entries = flattenWorkspaceTreeEntries(tree);
  itemCache.set(cacheKey, { ts: now, items: structuredClone(entries) });
  await savePersistentCache('clawlibrary-workspace-files', cacheKey, { key: cacheKey, ts: now, items: entries });
  await savePersistentCache('clawlibrary-workspace-tree', cacheKey, { key: cacheKey, ts: now, tree });
  try {
    await fs.mkdir(CACHE_ROOT, { recursive: true });
    await fs.writeFile(WORKSPACE_TREE_CACHE_PATH, JSON.stringify({ key: cacheKey, ts: now, tree }), 'utf8');
  } catch {
    // ignore tree cache persistence failures
  }
  return entries;
}

async function collectSkillEntries(skillRoots, limit = 36) {
  const cacheKey = JSON.stringify({ kind: 'skills', skillRoots, limit });
  const cached = itemCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < ITEM_CACHE_TTL_MS) {
    return structuredClone(cached.items);
  }
  const persisted = await loadPersistentCache('clawlibrary-skills', cacheKey);
  if (persisted?.key === cacheKey && now - persisted.ts < PERSISTENT_SCAN_CACHE_TTL_MS) {
    itemCache.set(cacheKey, { ts: now, items: structuredClone(persisted.items) });
    return structuredClone(persisted.items);
  }

  const collected = [];

  async function visit(dir, depth = 0) {
    if (depth > 3) {
      return;
    }
    const stat = await safeStat(dir);
    if (!stat || !stat.isDirectory()) {
      return;
    }
    const base = path.basename(dir);
    if (IGNORED_DIRS.has(base) || (depth > 0 && matchesAnyPattern(relPath(dir).toLowerCase(), LOW_SIGNAL_PATTERNS))) {
      return;
    }

    const skillFile = path.join(dir, 'SKILL.md');
    const skillStat = await safeStat(skillFile);
    if (skillStat?.isFile()) {
      const rel = relPath(skillFile);
      const folderRel = relPath(dir);
      const raw = await safeTextRead(skillFile);
      const title = path.basename(dir);
      const entry = item(`skill-${folderRel}`, title, folderRel, skillStat.mtimeMs, 'skill', rel, skillStat.size);
      entry.folderPath = folderRel;
      entry.excerpt = summarizeSkillText(raw);
      collected.push(entry);
      return;
    }

    const children = (await safeReadDir(dir)).filter((child) => child.isDirectory() && !child.name.startsWith('.'));
    await Promise.all(children.map((child) => visit(path.join(dir, child.name), depth + 1)));
  }

  for (const root of skillRoots) {
    await visit(root, 0);
  }

  const items = collected
    .sort((left, right) => {
      const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
      const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, limit);

  itemCache.set(cacheKey, { ts: now, items: structuredClone(items) });
  await savePersistentCache('clawlibrary-skills', cacheKey, { key: cacheKey, ts: now, items });
  return items;
}

async function findRecentSkillInvocation(skillItems, sessionDirs, { windowMs = ACTIVE_WINDOW_MS, transcriptLimit = 12 } = {}) {
  const transcripts = [];
  for (const dirPath of sessionDirs) {
    const stat = await safeStat(dirPath);
    if (!stat?.isDirectory()) {
      continue;
    }
    const entries = (await safeReadDir(dirPath))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
    for (const entry of entries) {
      const abs = path.join(dirPath, entry.name);
      const fileStat = await safeStat(abs);
      if (!fileStat?.isFile()) {
        continue;
      }
      transcripts.push({
        path: relPath(abs),
        updatedAt: new Date(fileStat.mtimeMs).toISOString()
      });
    }
  }
  transcripts.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const knownSkills = [...skillItems]
    .map((item) => ({ label: item.title, needle: item.title.toLowerCase() }))
    .sort((left, right) => right.needle.length - left.needle.length);

  for (const transcript of transcripts.slice(0, transcriptLimit)) {
    const updatedAtMs = transcript.updatedAt ? new Date(transcript.updatedAt).getTime() : 0;
    if (!updatedAtMs || Date.now() - updatedAtMs > windowMs) {
      continue;
    }
    const abs = resolveOpenClawPath(transcript.path);
    const tail = abs ? await safeTailTextRead(abs, 48000) : '';
    if (!tail) {
      continue;
    }
    const lower = tail.toLowerCase();
    const matchedSkill = knownSkills.find((skill) =>
      lower.includes(`${skill.needle}/skill.md`)
      || lower.includes(`/skills/${skill.needle}/`)
      || lower.includes(`/${skill.needle}/skill.md`)
      || lower.includes(skill.needle)
    );
    if (!matchedSkill) {
      continue;
    }
    return {
      latestMs: updatedAtMs,
      label: matchedSkill.label,
      path: transcript.path,
      detail: `invoked ${matchedSkill.label}`
    };
  }

  return null;
}

async function findRecentCronRunInfo(runsDir, { windowMs = ACTIVE_WINDOW_MS, fileLimit = 8 } = {}) {
  const stat = await safeStat(runsDir);
  if (!stat?.isDirectory()) {
    return null;
  }
  const runFiles = [];
  for (const entry of (await safeReadDir(runsDir)).filter((item) => item.isFile() && item.name.endsWith('.jsonl'))) {
    const abs = path.join(runsDir, entry.name);
    const fileStat = await safeStat(abs);
    if (!fileStat?.isFile()) {
      continue;
    }
    runFiles.push({
      path: relPath(abs),
      updatedAt: new Date(fileStat.mtimeMs).toISOString()
    });
  }
  runFiles.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

  for (const entry of runFiles.slice(0, fileLimit)) {
    const abs = resolveOpenClawPath(entry.path);
    const raw = abs ? await safeTailTextRead(abs, 32000) : '';
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const payload = JSON.parse(line);
        const occurredAt = Number(payload.runAtMs || payload.ts || 0);
        if (!occurredAt || Date.now() - occurredAt > windowMs) {
          continue;
        }
        const summary = summarizeText(payload.summary || payload.jobId || path.basename(entry.path));
        return {
          latestMs: occurredAt,
          detail: `latest run ${summary}`,
          path: entry.path,
          jobId: String(payload.jobId || path.basename(entry.path, '.jsonl')),
          status: String(payload.status || payload.action || 'run')
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function collectDeliveryEntries(dirPath, { failed = false, limit = 8 } = {}) {
  const entries = await collectRecursiveEntries([dirPath], {
    maxDepth: 2,
    limit,
    pathExcludes: failed ? [] : ['delivery-queue/failed'],
    exts: ['.json']
  });

  const results = [];
  for (const entry of entries) {
    const abs = resolveOpenClawPath(entry.path);
    const payload = abs ? await safeJsonRead(abs, {}) : {};
    const next = { ...entry };
    const shortId = String(payload.id || entry.title).slice(0, 8);
    next.title = `${failed ? 'Failed Delivery' : 'Delivery Queue'} · ${shortId}`;
    const payloadText = Array.isArray(payload.payloads)
      ? String(payload.payloads.find((item) => typeof item?.text === 'string')?.text || payload.payloads.find((item) => typeof item?.caption === 'string')?.caption || '')
      : String(payload.payloads?.text || payload.payloads?.caption || payload.payload?.text || payload.payload?.caption || payload.detail || payload.error || '');
    const failureText = extractMeaningfulText(payload.lastError || payload.error || payload.detail || payload.reason);
    const channel = payload.channel ? `${payload.channel}` : '';
    const summaryText = summarizeDeliveryMarkdown(payloadText);
    const content = [
      failed ? failureText : '',
      summaryText || extractMeaningfulText(payload)
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 180);
    next.excerpt = `${channel ? `${channel} · ` : ''}${content}`.trim() || (failed ? 'failed delivery artifact' : 'delivery queue item');
    next.meta = failed ? 'failed delivery' : 'delivery queue';
    results.push(next);
  }
  return results;
}

async function newestFiles(targets, limit = 5) {
  const collected = [];

  for (const targetPath of targets) {
    const stat = await safeStat(targetPath);
    if (!stat) {
      continue;
    }

    if (stat.isDirectory()) {
      const entries = (await safeReadDir(targetPath)).filter((entry) => !entry.name.startsWith('.'));
      for (const entry of entries) {
        const entryPath = path.join(targetPath, entry.name);
        const entryStat = await safeStat(entryPath);
        if (!entryStat) {
          continue;
        }
        collected.push({
          title: entry.name,
          path: relPath(entryPath),
          updatedAt: entryStat.mtimeMs,
          meta: entry.isDirectory() ? 'dir' : 'file'
        });
      }
      continue;
    }

    collected.push({
      title: path.basename(targetPath),
      path: relPath(targetPath),
      updatedAt: stat.mtimeMs,
      meta: 'file'
    });
  }

  return collected
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
    .map((entry, index) => item(`${entry.path}-${index}`, entry.title, entry.path, entry.updatedAt, entry.meta));
}

async function latestFromTargets(targets) {
  let latestMs = 0;
  let latestPath = '';
  let itemCount = 0;
  let exists = false;

  for (const targetPath of targets) {
    const stat = await safeStat(targetPath);
    if (!stat) {
      continue;
    }
    exists = true;

    if (stat.isDirectory()) {
      const entries = (await safeReadDir(targetPath))
        .filter((entry) => !entry.name.startsWith('.'))
        .slice(0, 80);
      itemCount += entries.length;

      for (const entry of entries) {
        const entryPath = path.join(targetPath, entry.name);
        const entryStat = await safeStat(entryPath);
        if (!entryStat) {
          continue;
        }
        if (entryStat.mtimeMs > latestMs) {
          latestMs = entryStat.mtimeMs;
          latestPath = entryPath;
        }
      }
      if (stat.mtimeMs > latestMs) {
        latestMs = stat.mtimeMs;
        latestPath = targetPath;
      }
      continue;
    }

    itemCount += 1;
    if (stat.mtimeMs > latestMs) {
      latestMs = stat.mtimeMs;
      latestPath = targetPath;
    }
  }

  return {
    exists,
    itemCount,
    latestMs,
    latestPath
  };
}

async function buildLiveResources({ itemResourceIds = null, includeExcerpt = true } = {}) {
  const now = Date.now();
  const shouldIncludeItemsFor = (resourceId) => itemResourceIds === null || itemResourceIds.has(resourceId);
  const workspaceFiles = await scanWorkspaceFiles();
  const documentCandidates = workspaceFiles.filter(isLikelyDocumentCandidate);
  const imageCandidates = workspaceFiles.filter(isLikelyImageCandidate);
  const memoryCandidates = workspaceFiles.filter(isLikelyMemoryCandidate);
  const workspaceLogCandidates = workspaceFiles.filter(isLikelyLogCandidate);
  const workspaceGatewayCandidates = workspaceFiles.filter(isLikelyGatewayConfigCandidate);
  const workspaceScheduleCandidates = workspaceFiles.filter(isLikelyScheduleCandidate);
  const workspaceCodeCandidates = workspaceFiles.filter(isLikelyCodeCandidate);

  const docsScan = summarizeCandidateEntries(documentCandidates);
  const imagesScan = summarizeCandidateEntries(imageCandidates);
  const memoryScan = summarizeCandidateEntries(memoryCandidates);
  const workspaceLogScan = summarizeCandidateEntries(workspaceLogCandidates);
  const workspaceGatewayScan = summarizeCandidateEntries(workspaceGatewayCandidates);
  const workspaceScheduleScan = summarizeCandidateEntries(workspaceScheduleCandidates);
  const workspaceCodeScan = summarizeCandidateEntries(workspaceCodeCandidates);

  const openclawConfigPath = path.join(OPENCLAW_ROOT, 'openclaw.json');
  const openclawConfig = await safeJsonRead(openclawConfigPath, {});
  const gatewayProviders = Object.entries(openclawConfig.models?.providers || {});
  const gatewayAgents = Object.keys(openclawConfig.agents || {});
  const pairedDevicesPath = path.join(OPENCLAW_ROOT, 'devices', 'paired.json');
  const pendingDevicesPath = path.join(OPENCLAW_ROOT, 'devices', 'pending.json');
  const pairedDevices = await safeJsonRead(pairedDevicesPath, {});
  const pendingDevices = await safeJsonRead(pendingDevicesPath, {});
  const pairedDeviceList = Object.values(pairedDevices || {});
  const pendingDeviceList = Object.values(pendingDevices || {});
  const gatewayScan = await latestFromTargets([
    openclawConfigPath,
    pairedDevicesPath,
    pendingDevicesPath,
    path.join(OPENCLAW_ROOT, 'gateway.log'),
    path.join(OPENCLAW_ROOT, 'logs', 'gateway.log')
  ]);

  const rootLogEntries = (await safeReadDir(path.join(OPENCLAW_ROOT, 'logs'))).filter((entry) => entry.isFile());
  const logScan = await latestFromTargets([
    path.join(OPENCLAW_ROOT, 'logs'),
    path.join(OPENCLAW_ROOT, 'gateway.log')
  ]);

  const mcpConfigPath = path.join(WORKSPACE_ROOT, 'config', 'mcporter.json');
  const mcpConfig = await safeJsonRead(mcpConfigPath, {});
  const gatewayMcpScan = await latestFromTargets([
    mcpConfigPath,
    path.join(OPENCLAW_ROOT, 'skills', 'mcp-builder')
  ]);
  const mcpCount = Object.keys(mcpConfig.mcpServers || {}).length;

  const cronJobsPath = path.join(OPENCLAW_ROOT, 'cron', 'jobs.json');
  const cronJobs = await safeJsonRead(cronJobsPath, {});
  const enabledJobs = Array.isArray(cronJobs.jobs) ? cronJobs.jobs.filter((job) => job && job.enabled) : [];
  const scheduleScan = await latestFromTargets([
    cronJobsPath,
    path.join(WORKSPACE_ROOT, 'tmp', 'zsxq-scheduled-ready.txt'),
    path.join(WORKSPACE_ROOT, 'tmp', 'zsxq-scheduled-draft.txt')
  ]);
  const recentCronRun = await findRecentCronRunInfo(path.join(OPENCLAW_ROOT, 'cron', 'runs'));

  const queuePath = path.join(OPENCLAW_ROOT, 'tasks', 'task-queue.json');
  const queueJson = await safeJsonRead(queuePath, {});
  const queueTasks = Array.isArray(queueJson.tasks) ? queueJson.tasks : [];
  const blockedTasks = queueTasks.filter((task) => taskDisplayStatus(task) === 'blocked').length;
  const pausedTasks = queueTasks.filter((task) => taskDisplayStatus(task) === 'paused').length;
  const pendingTasks = queueTasks.filter((task) => task.status === 'pending').length;
  const taskQueueScan = await latestFromTargets([
    queuePath,
    path.join(OPENCLAW_ROOT, 'delivery-queue')
  ]);

  const failedDeliveryDir = path.join(OPENCLAW_ROOT, 'delivery-queue', 'failed');
  const failedDeliveryEntries = (await safeReadDir(failedDeliveryDir)).filter((entry) => entry.isFile());
  const failedDeliveries = failedDeliveryEntries.length;
  const failedDeliveryTimestamps = await Promise.all(failedDeliveryEntries.map(async (entry) => {
    try {
      const stats = await fs.stat(path.join(failedDeliveryDir, entry.name));
      return stats.mtimeMs;
    } catch {
      return 0;
    }
  }));
  const recentFailedDeliveries = failedDeliveryTimestamps.filter((timestamp) => timestamp > 0 && now - timestamp < ACTIVE_WINDOW_MS).length;
  const alarmScan = await latestFromTargets([
    failedDeliveryDir,
    path.join(OPENCLAW_ROOT, 'logs', 'gateway.err.log')
  ]);

  const agentDirs = (await safeReadDir(path.join(OPENCLAW_ROOT, 'agents'))).filter((entry) => entry.isDirectory()).length;
  const subagentRuns = await safeJsonRead(path.join(OPENCLAW_ROOT, 'subagents', 'runs.json'), { runs: {} });
  const agentRunCount = subagentRuns && typeof subagentRuns.runs === 'object' ? Object.keys(subagentRuns.runs).length : 0;
  const activeAgents = subagentRuns && typeof subagentRuns.runs === 'object'
    ? Object.entries(subagentRuns.runs)
        .filter(([, run]) => run && !run.endedAt && !run.outcome)
        .slice(0, 6)
        .map(([id, run]) => ({ id, label: run.label ?? run.task?.slice(0, 40) ?? id, status: 'running' }))
    : [];
  const mainSessionIndexPath = path.join(OPENCLAW_ROOT, 'agents', 'main', 'sessions', 'sessions.json');
  const codexSessionIndexPath = path.join(OPENCLAW_ROOT, 'agents', 'codex', 'sessions', 'sessions.json');
  const mainSessions = await safeJsonRead(mainSessionIndexPath, {});
  const codexSessions = await safeJsonRead(codexSessionIndexPath, {});
  const mainSessionCount = Object.keys(mainSessions || {}).length;
  const codexSessionCount = Object.keys(codexSessions || {}).length;
  const agentScan = await latestFromTargets([
    path.join(OPENCLAW_ROOT, 'agents'),
    path.join(OPENCLAW_ROOT, 'subagents', 'runs.json'),
    mainSessionIndexPath,
    codexSessionIndexPath
  ]);
  const documentItems = shouldIncludeItemsFor('document')
    ? await hydrateIndexedEntries(prioritizeItems(documentCandidates, [
      'writing',
      'wechat',
      'weibo',
      'docs',
      'knowledge',
      'report',
      'plan',
      'proposal',
      'readme',
      'clawlibrary',
      'openclaw'
    ], WORKSPACE_RESOURCE_ITEM_LIMIT, [
      [/project\/clawlibrary/i, 2],
      [/(^|\/)(writing|wechat|weibo|articles?|posts?|drafts?|blogs?)(\/|$)/i, 14],
      [/(^|\/)(docs?|knowledge|insights?|reports?|plans?|proposals?|guides?|notes?|exploration)(\/|$)/i, 5],
      [/(final|article|post|draft|wechat|weibo)/i, 6],
      [/(readme|todo|changelog|summary|report|proposal|plan)/i, 4],
      [/(clawlibrary|openclaw|lobster|ll3)/i, 3],
      [/(^|\/)(qa|snapshots?)(\/|$)/i, -6],
      ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -4]),
      ...CONFIG_NOISE_PATTERNS.map((pattern) => [pattern, -12])
    ]), WORKSPACE_RESOURCE_ITEM_LIMIT, { includeExcerpt })
    : [];
  const imageItems = shouldIncludeItemsFor('images')
    ? await hydrateIndexedEntries(prioritizeItems(imageCandidates, [
      'image',
      'art',
      'avatar',
      'illustration',
      'asset',
      'sprite',
      'character',
      'generated',
      'clawlibrary',
      'openclaw'
    ], WORKSPACE_RESOURCE_ITEM_LIMIT, [
      [/project\/clawlibrary/i, 8],
      [/(^|\/)(art|avatars?|images?|illustrations?|assets?|sprites?|characters?|icons?|media|public|static|generated)(\/|$)/i, 6],
      [/(lobster|claw|openclaw|ll3|layout|sprite|character|avatar|pixel)/i, 4],
      [/(^|\/)(writing|knowledge|project|skills)(\/|$)/i, 2],
      ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -8]),
      ...IMAGE_NOISE_PATTERNS.map((pattern) => [pattern, -8])
    ]), WORKSPACE_RESOURCE_ITEM_LIMIT, { includeExcerpt })
    : [];
  const memoryItems = shouldIncludeItemsFor('memory')
    ? await hydrateIndexedEntries(prioritizeItems(memoryCandidates, [
      'memory',
      'user.md',
      'soul.md',
      'diary',
      'journal',
      'note',
      'context'
    ], WORKSPACE_RESOURCE_ITEM_LIMIT, [
      [/memory\.md/i, 8],
      [/(user|soul)\.md/i, 7],
      [/\d{4}-\d{2}-\d{2}\.md/i, 6],
      [/(diary|journal|note|context|persona)/i, 4],
      ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -4])
    ]), WORKSPACE_RESOURCE_ITEM_LIMIT, { includeExcerpt })
    : [];
  const rawSkillItems = await collectSkillEntries([
    WORKSPACE_ROOT,
    path.join(OPENCLAW_ROOT, 'skills')
  ], WORKSPACE_RESOURCE_ITEM_LIMIT);
  const skillItems = shouldIncludeItemsFor('skills')
    ? prioritizeItems(rawSkillItems, [
      'skills/',
      'nano-banana',
      'playwright',
      'sprite',
      'image',
      'art',
      'coding'
    ], WORKSPACE_RESOURCE_ITEM_LIMIT, [
      [/nano-banana-pro/i, 8],
      [/playwright/i, 7],
      [/(codex|coding|orchestrator|subagent|sub-agent)/i, 6],
      [/(sprite|image|art|illustrat|gif|pixel)/i, 5],
      [/(browser|automation|cua|web-proxy)/i, 4],
      [/(clawlibrary|lobster|openclaw)/i, 3],
      ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -4])
    ])
    : [];
  const skillsScan = {
    exists: rawSkillItems.length > 0,
    itemCount: rawSkillItems.length,
    latestMs: rawSkillItems.reduce((latest, current) => Math.max(latest, current.updatedAt ? new Date(current.updatedAt).getTime() : 0), 0),
    latestPath: rawSkillItems[0]?.path ?? ''
  };
  const recentSkillInvocation = await findRecentSkillInvocation(rawSkillItems, [
    path.join(OPENCLAW_ROOT, 'agents', 'main', 'sessions'),
    path.join(OPENCLAW_ROOT, 'agents', 'codex', 'sessions')
  ]);
  const workspaceGatewayConfigItems = shouldIncludeItemsFor('gateway')
    ? await hydrateIndexedEntries(prioritizeItems(workspaceGatewayCandidates, [
    'config',
    'gateway',
    'provider',
    'model',
    'auth',
    'device',
    'mcp'
  ], 12, [
    [/mcporter\.json/i, 9],
    [/(^|\/)(config|configs|settings?|providers?|models?|auth|devices?|gateway|mcp|connections?)(\/|$)/i, 7],
    [/(config|gateway|provider|model|auth|device|mcp)/i, 5],
    [/(clawlibrary|openclaw)/i, 2],
    ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -4]),
    ...CONFIG_NOISE_PATTERNS.map((pattern) => [pattern, -10])
  ]), 12, { includeExcerpt })
    : [];
  const gatewayItems = [
    (() => {
      const next = item('gateway-config', 'OpenClaw Config', '.openclaw/openclaw.json', gatewayScan.latestMs, 'config');
      next.excerpt = `${gatewayProviders.length} model providers · ${gatewayAgents.length} configured agents`;
      next.stats = [
        { label: 'providers', value: String(gatewayProviders.length), tone: 'cool' },
        { label: 'agents', value: String(gatewayAgents.length), tone: 'active' }
      ];
      return next;
    })(),
    (() => {
      const next = item('gateway-auth', 'Auth Profiles', '.openclaw/agents/main/agent/auth-profiles.json', gatewayScan.latestMs, 'auth');
      next.excerpt = 'Local account sessions and provider bindings';
      return next;
    })(),
    (() => {
      const next = item('gateway-models', 'Model Registry', '.openclaw/agents/main/agent/models.json', gatewayScan.latestMs, 'models');
      next.excerpt = 'Active model/provider registry used by the main agent';
      return next;
    })(),
    (() => {
      const next = item('gateway-devices', '.openclaw devices', '.openclaw/devices', gatewayScan.latestMs, 'devices');
      next.excerpt = `${pairedDeviceList.length} paired · ${pendingDeviceList.length} pending`;
      next.stats = [
        { label: 'paired', value: String(pairedDeviceList.length), tone: 'active' },
        { label: 'pending', value: String(pendingDeviceList.length), tone: 'warm' }
      ];
      return next;
    })(),
    ...gatewayProviders.slice(0, 6).map(([providerId, provider], index) => {
      const next = item(`gateway-provider-${index}`, `Provider · ${providerId}`, '.openclaw/openclaw.json', gatewayScan.latestMs, 'provider');
      if (provider && typeof provider === 'object') {
        const host = hostnameOf(provider.baseUrl);
        const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
        const apiKind = provider.api ? `${provider.api}` : 'api unknown';
        next.excerpt = `${modelCount} models${host ? ` · ${host}` : ''} · ${apiKind}`.slice(0, 180);
        next.stats = [
          { label: 'models', value: String(modelCount), tone: 'cool' }
        ];
      }
      return next;
    }),
    ...pairedDeviceList
      .sort((left, right) => {
        const leftTime = left?.tokens?.operator?.lastUsedAtMs || left?.approvedAtMs || left?.createdAtMs || 0;
        const rightTime = right?.tokens?.operator?.lastUsedAtMs || right?.approvedAtMs || right?.createdAtMs || 0;
        return rightTime - leftTime;
      })
      .slice(0, 4)
      .map((device, index) => {
        const next = item(`gateway-device-${index}`, `Device · ${device.clientId || `paired-${index}`}`, '.openclaw/devices/paired.json', device?.tokens?.operator?.lastUsedAtMs || device?.approvedAtMs || gatewayScan.latestMs, 'paired device');
        const scopeCount = Array.isArray(device.scopes) ? device.scopes.length : Array.isArray(device.approvedScopes) ? device.approvedScopes.length : 0;
        next.excerpt = `${device.clientMode || 'unknown'} · ${device.platform || 'unknown'} · ${scopeCount} scopes`;
        next.stats = [
          { label: 'scopes', value: String(scopeCount), tone: 'cool' }
        ];
        return next;
      })
  ];
  const workspaceLogItems = shouldIncludeItemsFor('log')
    ? await hydrateIndexedEntries(prioritizeItems(workspaceLogCandidates, [
    'log',
    'debug',
    'trace',
    'error',
    'gateway',
    'runtime'
  ], 48, [
    [/(^|\/)(logs?|trace|debug|output)(\/|$)/i, 8],
    [/(stderr|stdout|console|terminal|error|trace|debug|runtime)/i, 6],
    [/(clawlibrary|openclaw|gateway)/i, 2],
    ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -3])
  ]), 48, { includeExcerpt })
    : [];
  const rootWorkspaceLogItems = shouldIncludeItemsFor('log') ? await collectRecursiveEntries([
    path.join(OPENCLAW_ROOT, 'logs')
  ], {
    maxDepth: 3,
    limit: 24,
    exts: ['.log', '.txt', '.json', '.jsonl']
  }) : [];
  const logItems = dedupeItems([
    ...workspaceLogItems,
    ...rootWorkspaceLogItems
  ], WORKSPACE_RESOURCE_ITEM_LIMIT);
  const gatewayMcpItems = Object.entries(mcpConfig.mcpServers || {}).slice(0, 6).map(([name, detail], index) => {
    const next = item(`mcp-${index}`, name, 'workspace/config/mcporter.json', gatewayMcpScan.latestMs, 'mcp server');
    if (detail && typeof detail === 'object') {
      const transport = detail.command ? 'stdio' : detail.url ? 'http' : 'unknown';
      next.excerpt = `${transport} transport${detail.command ? ` · ${detail.command}` : ''}${detail.url ? ` · ${detail.url}` : ''}`.slice(0, 180);
      next.stats = [
        { label: 'transport', value: transport, tone: transport === 'http' ? 'cool' : 'violet' }
        ];
      }
      return next;
    });
  const scheduleItems = enabledJobs.slice(0, 6).map((job, index) => {
    const next = item(`cron-${index}`, job.name || job.id || `job-${index}`, '.openclaw/cron/jobs.json', job.updatedAtMs || scheduleScan.latestMs, job.schedule?.kind || 'job');
    const scheduleLabel = job.schedule?.kind === 'cron'
      ? `cron ${job.schedule?.expr || ''}`
      : job.schedule?.kind === 'every'
        ? `every ${job.schedule?.everyMs || ''}ms`
        : job.schedule?.kind || 'schedule';
    next.excerpt = `${scheduleLabel} · ${String(job.payload?.text || job.payload?.message || '').slice(0, 140)}`;
    return next;
  });
  const scheduleFiles = await collectRecursiveEntries([
    path.join(OPENCLAW_ROOT, 'cron'),
    path.join(WORKSPACE_ROOT, 'tmp')
  ], {
    maxDepth: 3,
    limit: 10,
    pathIncludes: ['schedule', 'cron', 'scheduled'],
    exts: ['.json', '.txt', '.md']
  });
  const workspaceScheduleItems = shouldIncludeItemsFor('schedule')
    ? await hydrateIndexedEntries(prioritizeItems(workspaceScheduleCandidates, [
    'schedule',
    'scheduled',
    'cron',
    'job',
    'calendar'
  ], 10, [
    [/(^|\/)(schedule(d)?|cron|jobs?|calendar)(\/|$)/i, 8],
    [/(schedule|scheduled|cron|jobs?|calendar)/i, 6],
    ...LOW_SIGNAL_PATTERNS.map((pattern) => [pattern, -2]),
      ...CONFIG_NOISE_PATTERNS.map((pattern) => [pattern, -8])
  ]), 10, { includeExcerpt })
    : [];
  const scheduleRunItems = recentCronRun
    ? [(() => {
      const next = item('cron-run-latest', 'Latest Run', recentCronRun.path, recentCronRun.latestMs, 'cron run');
      next.excerpt = recentCronRun.detail;
      next.stats = [
        { label: 'status', value: recentCronRun.status, tone: recentCronRun.status === 'ok' ? 'calm' : 'warm' }
      ];
      return next;
    })()]
    : [];
  const alarmFiles = await collectDeliveryEntries(failedDeliveryDir, { failed: true, limit: 6 });
  const prioritizedQueueTasks = [...queueTasks].sort((left, right) => {
    const priorityDelta = taskStatusPriority(left) - taskStatusPriority(right);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const leftTime = new Date(left.started_at || left.added_at || 0).getTime();
    const rightTime = new Date(right.started_at || right.added_at || 0).getTime();
    return rightTime - leftTime;
  });
  const alarmItems = [
    ...prioritizedQueueTasks.filter((task) => taskDisplayStatus(task) === 'blocked').slice(0, 4).map((task, index) => {
      const next = item(`blocked-${index}`, taskTitle(task, task.id || index), '.openclaw/tasks/task-queue.json', taskQueueScan.latestMs, 'blocked');
      next.excerpt = String(task.blocked_reason || task.description || task.goal || 'blocked task').slice(0, 180);
      return next;
    }),
    ...alarmFiles
  ].slice(0, 8);
  const queuedDeliveryItems = await collectDeliveryEntries(path.join(OPENCLAW_ROOT, 'delivery-queue'), { failed: false, limit: 8 });
  const taskItems = [
    ...prioritizedQueueTasks.slice(0, 8).map((task, index) => {
      const next = item(`task-${index}`, taskTitle(task, task.id || `task-${index}`), '.openclaw/tasks/task-queue.json', taskQueueScan.latestMs, taskDisplayStatus(task));
      next.excerpt = String(task.blocked_reason || task.description || task.goal || task.user_action_required || '').slice(0, 180);
      return next;
    }),
    ...queuedDeliveryItems
  ].slice(0, 12);
  const gatewayQueueItems = prioritizedQueueTasks.slice(0, 4).map((task, index) => {
    const next = item(`gateway-queue-${index}`, taskTitle(task, task.id || `queue-${index}`), '.openclaw/tasks/task-queue.json', taskQueueScan.latestMs, 'queue task');
    next.excerpt = String(task.blocked_reason || task.description || task.goal || task.user_action_required || 'queue signal').slice(0, 180);
    return next;
  });
  const gatewayRuntimeItems = [
    (() => {
      const next = item('gateway-runtime', 'Agent Runtime', '.openclaw/agents/main/sessions/sessions.json', agentScan.latestMs, 'runtime');
      next.excerpt = `${mainSessionCount + codexSessionCount} sessions · ${agentRunCount} subagent runs`;
      next.stats = [
        { label: 'sessions', value: String(mainSessionCount + codexSessionCount), tone: 'cool' },
        { label: 'subagents', value: String(agentRunCount), tone: 'violet' }
      ];
      return next;
    })(),
    (() => {
      const next = item('gateway-queue-overview', 'Queue Overview', '.openclaw/tasks/task-queue.json', taskQueueScan.latestMs, 'queue overview');
      next.excerpt = `${blockedTasks} blocked · ${pausedTasks} paused · ${pendingTasks} pending · ${queuedDeliveryItems.length} deliveries`;
      next.stats = [
        { label: 'blocked', value: String(blockedTasks), tone: blockedTasks > 0 ? 'danger' : 'muted' },
        { label: 'paused', value: String(pausedTasks), tone: pausedTasks > 0 ? 'cool' : 'muted' },
        { label: 'pending', value: String(pendingTasks), tone: pendingTasks > 0 ? 'warm' : 'muted' },
        { label: 'deliveries', value: String(queuedDeliveryItems.length), tone: 'cool' }
      ];
      return next;
    })()
  ];
  const gatewayMergedItems = [
    ...gatewayItems,
    ...workspaceGatewayConfigItems,
    ...gatewayMcpItems,
    ...gatewayRuntimeItems,
    ...gatewayQueueItems
  ];
  const dedupedGatewayItems = dedupeItems(gatewayMergedItems, 20);
  const codeLabRepoItems = await collectGitRepositories([
    WORKSPACE_ROOT
  ], {
    maxDepth: 4,
    limit: 14
  });
  const runnableProjectItems = await collectRunnableProjects([
    WORKSPACE_ROOT
  ], {
    maxDepth: 4,
    limit: 12
  });
  const codeLabSourceItems = dedupeItems([
    ...codeLabRepoItems,
    ...runnableProjectItems.filter((project) => !codeLabRepoItems.some((repo) => repo.path === project.path))
  ], 18);
  const codeActivityItems = shouldIncludeItemsFor('mcp')
    ? await hydrateIndexedEntries(prioritizeItems(workspaceCodeCandidates, [
      'project/',
      'src/',
      'scripts/',
      'main.',
      'app.',
      'server',
      'client'
    ], 8, [
      [/(^|\/)(project|projects)(\/|$)/i, 8],
      [/(^|\/)(src|scripts|server|client)(\/|$)/i, 6],
      [/\.(ts|tsx|js|jsx|py|rs|go|sh)$/i, 5],
      [/dist\//i, -10]
    ]), 8, { includeExcerpt })
    : [];
  const standaloneCodeItems = codeActivityItems.filter((entry) =>
    !codeLabSourceItems.some((sourceItem) => pathIsWithin(sourceItem.path, entry.path))
  );
  const codeLabItems = shouldIncludeItemsFor('mcp')
    ? dedupeItems([
      ...codeLabSourceItems,
      ...standaloneCodeItems
    ], 18)
    : [];
  const codeLabLatestSourceMs = codeLabSourceItems.reduce((latest, current) => {
    const time = current.updatedAt ? new Date(current.updatedAt).getTime() : 0;
    return Math.max(latest, time);
  }, 0);
  const codeActivityMs = Math.max(
    workspaceCodeScan.latestMs || 0,
    codeActivityItems.reduce((latest, current) => Math.max(latest, current.updatedAt ? new Date(current.updatedAt).getTime() : 0), 0)
  );
  const scheduleMergedItems = dedupeItems([
    ...scheduleRunItems,
    ...scheduleItems,
    ...workspaceScheduleItems,
    ...scheduleFiles
  ], 16);
  const combinedGatewayLatestMs = Math.max(
    gatewayScan.latestMs || 0,
    taskQueueScan.latestMs || 0,
    agentScan.latestMs || 0,
    gatewayMcpScan.latestMs || 0,
    workspaceGatewayScan.latestMs || 0
  );
  const combinedGatewayLatestPath = blockedTasks > 0
    ? ''
    : taskQueueScan.latestPath
      ? relPath(taskQueueScan.latestPath)
      : workspaceGatewayScan.latestPath
        ? workspaceGatewayScan.latestPath
        : gatewayScan.latestPath
          ? relPath(gatewayScan.latestPath)
          : gatewayMcpScan.latestPath
            ? relPath(gatewayMcpScan.latestPath)
            : '';
  const combinedLogLatestMs = Math.max(logScan.latestMs || 0, workspaceLogScan.latestMs || 0);
  const combinedLogLatestPath = workspaceLogScan.latestMs >= (logScan.latestMs || 0)
    ? workspaceLogScan.latestPath
    : logScan.latestPath
      ? relPath(logScan.latestPath)
      : '';
  const combinedScheduleLatestMs = Math.max(scheduleScan.latestMs || 0, workspaceScheduleScan.latestMs || 0);
  const combinedScheduleLatestPath = workspaceScheduleScan.latestMs >= (scheduleScan.latestMs || 0)
    ? workspaceScheduleScan.latestPath
    : scheduleScan.latestPath
      ? relPath(scheduleScan.latestPath)
      : '';
  const runningTasks = queueTasks.filter((task) => task.status === 'running' || task.status === 'active').length;
  const completedTasks = queueTasks.filter((task) => task.status === 'completed' || task.status === 'done').length;
  const parallelTaskItems = prioritizedQueueTasks
    .filter((task) => ['running', 'active', 'pending', 'blocked', 'paused', 'completed', 'done'].includes(taskDisplayStatus(task)))
    .slice(0, 6)
    .map((task, index) => {
      const next = item(`agent-task-${index}`, taskTitle(task, task.id || `task-${index}`), '.openclaw/tasks/task-queue.json', taskQueueScan.latestMs, taskDisplayStatus(task));
      next.excerpt = String(task.blocked_reason || task.description || task.goal || task.user_action_required || 'parallel task').slice(0, 180);
      next.stats = [
        { label: 'status', value: taskDisplayStatus(task), tone: taskStatusTone(task) }
      ];
      return next;
    });
  const agentItems = [
    (() => {
      const next = item('agent-overview', 'Parallel Runs', '.openclaw/tasks/task-queue.json', taskQueueScan.latestMs, 'running');
      next.excerpt = `${runningTasks} running · ${pendingTasks} pending · ${blockedTasks} blocked · ${pausedTasks} paused · ${completedTasks} completed`;
      next.stats = [
        { label: 'blocked', value: String(blockedTasks), tone: blockedTasks > 0 ? 'danger' : 'muted' },
        { label: 'paused', value: String(pausedTasks), tone: pausedTasks > 0 ? 'cool' : 'muted' },
        { label: 'pending', value: String(pendingTasks), tone: pendingTasks > 0 ? 'warm' : 'muted' },
        { label: 'running', value: String(runningTasks), tone: 'active' },
        { label: 'done', value: String(completedTasks), tone: 'calm' }
      ];
      return next;
    })(),
    ...(await collectSessionItems([
      {
        id: 'main-session',
        label: 'Main Agent',
        meta: 'session transcript',
        indexPath: mainSessionIndexPath,
        dirPath: path.join(OPENCLAW_ROOT, 'agents', 'main', 'sessions')
      },
      {
        id: 'codex-session',
        label: 'Codex',
        meta: 'session transcript',
        indexPath: codexSessionIndexPath,
        dirPath: path.join(OPENCLAW_ROOT, 'agents', 'codex', 'sessions')
      }
    ], 8)),
    ...Object.keys(subagentRuns.runs || {}).slice(0, 4).map((runId, index) => {
      const next = item(`run-${index}`, `Subagent Run · ${runId}`, '.openclaw/subagents/runs.json', agentScan.latestMs, 'subagent run');
      next.excerpt = 'captured in .openclaw/subagents/runs.json';
      next.stats = [
        { label: 'run', value: `#${index + 1}`, tone: 'violet' }
      ];
      return next;
    }),
    ...parallelTaskItems
  ].slice(0, 14);

  const liveResources = [
    {
      id: 'document',
      label: RESOURCE_META.document.label,
      status: !docsScan.exists ? 'offline' : now - docsScan.latestMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: docsScan.itemCount,
      lastAccessAt: toIso(docsScan.latestMs),
      summary: `${docsScan.itemCount} indexed documents`,
      detail: docsScan.latestPath ? `latest ${docsScan.latestPath}` : 'no document activity',
      source: RESOURCE_META.document.source,
      items: documentItems
    },
    {
      id: 'images',
      label: RESOURCE_META.images.label,
      status: !imagesScan.exists ? 'offline' : now - imagesScan.latestMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: imagesScan.itemCount,
      lastAccessAt: toIso(imagesScan.latestMs),
      summary: `${imagesScan.itemCount} indexed image assets`,
      detail: imagesScan.latestPath ? `latest ${imagesScan.latestPath}` : 'no image activity',
      source: RESOURCE_META.images.source,
      items: imageItems
    },
    {
      id: 'memory',
      label: RESOURCE_META.memory.label,
      status: !memoryScan.exists ? 'offline' : now - memoryScan.latestMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: memoryScan.itemCount,
      lastAccessAt: toIso(memoryScan.latestMs),
      summary: `${memoryScan.itemCount} indexed memory notes`,
      detail: memoryScan.latestPath ? `latest ${memoryScan.latestPath}` : 'no memory activity',
      source: RESOURCE_META.memory.source,
      items: memoryItems
    },
    {
      id: 'skills',
      label: RESOURCE_META.skills.label,
      status: !skillsScan.exists
        ? 'offline'
        : (recentSkillInvocation && now - recentSkillInvocation.latestMs < ACTIVE_WINDOW_MS)
          || now - skillsScan.latestMs < ACTIVE_WINDOW_MS
          ? 'active'
          : 'idle',
      itemCount: skillsScan.itemCount,
      lastAccessAt: toIso(Math.max(skillsScan.latestMs || 0, recentSkillInvocation?.latestMs || 0)),
      summary: `${skillsScan.itemCount} discovered skills`,
      detail: recentSkillInvocation?.detail
        ?? (skillsScan.latestPath ? `latest ${skillsScan.latestPath}` : 'no skill activity'),
      source: RESOURCE_META.skills.source,
      items: skillItems
    },
    {
      id: 'gateway',
      label: RESOURCE_META.gateway.label,
      status: blockedTasks > 0
        ? 'alert'
        : (!gatewayScan.exists && !taskQueueScan.exists && !agentScan.exists)
          ? 'offline'
          : [gatewayScan.latestMs, taskQueueScan.latestMs, agentScan.latestMs, gatewayMcpScan.latestMs, workspaceGatewayScan.latestMs].some((value) => value && now - value < ACTIVE_WINDOW_MS)
            ? 'active'
            : 'idle',
      itemCount: Math.max(
        gatewayProviders.length + gatewayAgents.length + pairedDeviceList.length + pendingDeviceList.length + queueTasks.length + mainSessionCount + codexSessionCount + agentRunCount + mcpCount + workspaceGatewayScan.itemCount,
        dedupedGatewayItems.length
      ),
      lastAccessAt: toIso(combinedGatewayLatestMs),
      summary: `${gatewayProviders.length} providers · ${workspaceGatewayScan.itemCount} workspace configs · ${mcpCount} MCP nodes · ${queueTasks.length} queue tasks`,
      detail: blockedTasks > 0
        ? pausedTasks > 0
          ? `${blockedRoutingDetail(blockedTasks)} · ${countPhrase(pausedTasks, 'paused task')}`
          : blockedRoutingDetail(blockedTasks)
        : pausedTasks > 0
          ? countPhrase(pausedTasks, 'paused task')
        : combinedGatewayLatestPath
          ? `latest ${combinedGatewayLatestPath}`
            : 'gateway idle',
      source: RESOURCE_META.gateway.source,
      items: dedupedGatewayItems
    },
    {
      id: 'log',
      label: RESOURCE_META.log.label,
      status: !combinedLogLatestMs ? 'offline' : now - combinedLogLatestMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: workspaceLogScan.itemCount + rootLogEntries.length,
      lastAccessAt: toIso(combinedLogLatestMs),
      summary: `${workspaceLogScan.itemCount + rootLogEntries.length} indexed logs`,
      detail: combinedLogLatestPath ? `latest ${combinedLogLatestPath}` : 'no log activity',
      source: RESOURCE_META.log.source,
      items: logItems
    },
    {
      id: 'mcp',
      label: RESOURCE_META.mcp.label,
      status: codeLabSourceItems.length === 0 ? 'offline' : now - codeActivityMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: codeLabSourceItems.length + standaloneCodeItems.length,
      lastAccessAt: toIso(Math.max(codeLabLatestSourceMs || 0, codeActivityMs || 0)),
      summary: `${codeLabRepoItems.length} git repos · ${Math.max(0, codeLabSourceItems.length - codeLabRepoItems.length)} app projects${standaloneCodeItems.length > 0 ? ` · ${standaloneCodeItems.length} loose files` : ''}`,
      detail: (now - codeActivityMs < ACTIVE_WINDOW_MS && workspaceCodeScan.latestPath)
        ? `latest ${workspaceCodeScan.latestPath}`
        : codeActivityItems[0]?.path
        ? `latest ${codeActivityItems[0].path}`
        : codeLabSourceItems[0]?.path
          ? `latest ${codeLabSourceItems[0].path}`
          : 'no code lab activity',
      source: RESOURCE_META.mcp.source,
      items: codeLabItems
    },
    {
      id: 'schedule',
      label: RESOURCE_META.schedule.label,
      status: !combinedScheduleLatestMs && !recentCronRun?.latestMs
        ? 'offline'
        : now - Math.max(combinedScheduleLatestMs || 0, recentCronRun?.latestMs || 0) < ACTIVE_WINDOW_MS
          ? 'active'
          : 'idle',
      itemCount: enabledJobs.length + workspaceScheduleScan.itemCount,
      lastAccessAt: toIso(Math.max(combinedScheduleLatestMs || 0, recentCronRun?.latestMs || 0)),
      summary: `${enabledJobs.length} enabled jobs · ${workspaceScheduleScan.itemCount} schedule artifacts`,
      detail: recentCronRun?.detail ?? (combinedScheduleLatestPath ? `latest ${combinedScheduleLatestPath}` : 'no schedule activity'),
      source: RESOURCE_META.schedule.source,
      items: scheduleMergedItems
    },
    {
      id: 'alarm',
      label: RESOURCE_META.alarm.label,
      status: recentFailedDeliveries > 0 || blockedTasks > 0 ? 'alert' : !alarmScan.exists ? 'offline' : now - alarmScan.latestMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: failedDeliveries + blockedTasks,
      lastAccessAt: toIso(alarmScan.latestMs),
      summary: `${failedDeliveries} failed deliveries · ${blockedTasks} blocked tasks`,
      detail: recentFailedDeliveries > 0 || blockedTasks > 0
        ? 'failed deliveries or blocked tasks present'
        : failedDeliveries > 0
          ? `${failedDeliveries} historical failed deliveries`
          : 'alarm clear',
      source: RESOURCE_META.alarm.source,
      items: alarmItems
    },
    {
      id: 'agent',
      label: RESOURCE_META.agent.label,
      status: runningTasks > 0
        ? 'active'
        : agentItems.length === 0
        ? 'offline'
        : now - Math.max(agentScan.latestMs || 0, taskQueueScan.latestMs || 0) < ACTIVE_WINDOW_MS
          ? 'active'
          : 'idle',
      itemCount: runningTasks + pendingTasks + blockedTasks + pausedTasks + agentRunCount + mainSessionCount + codexSessionCount,
      lastAccessAt: toIso(Math.max(agentScan.latestMs || 0, taskQueueScan.latestMs || 0)),
      summary: `${runningTasks} running · ${pendingTasks} pending · ${blockedTasks} blocked · ${pausedTasks} paused · ${agentRunCount} subagent runs`,
      detail: runningTasks > 0 ? `${runningTasks} tasks currently running` : agentItems[1]?.path ? `latest ${agentItems[1].path}` : 'no active run dock activity',
      source: RESOURCE_META.agent.source,
      items: agentItems
    },
    {
      id: 'task_queues',
      label: RESOURCE_META.task_queues.label,
      status: blockedTasks > 0 ? 'alert' : !taskQueueScan.exists ? 'offline' : now - taskQueueScan.latestMs < ACTIVE_WINDOW_MS ? 'active' : 'idle',
      itemCount: queueTasks.length + queuedDeliveryItems.length,
      lastAccessAt: toIso(taskQueueScan.latestMs),
      summary: `${queueTasks.length} tasks · ${pendingTasks} pending · ${queuedDeliveryItems.length} deliveries`,
      detail: blockedTasks > 0
        ? pausedTasks > 0
          ? `${countPhrase(blockedTasks, 'blocked task')} · ${countPhrase(pausedTasks, 'paused task')}`
          : countPhrase(blockedTasks, 'blocked task')
        : pausedTasks > 0
          ? countPhrase(pausedTasks, 'paused task')
          : queuedDeliveryItems.length > 0
            ? `${queuedDeliveryItems.length} queued delivery artifacts`
            : taskQueueScan.latestPath
              ? `latest ${relPath(taskQueueScan.latestPath)}`
              : 'queue idle',
      source: RESOURCE_META.task_queues.source,
      items: taskItems
    }
  ];

  let focus = null;
  const alertResource = liveResources.find((resource) => resource.status === 'alert');
  if (alertResource) {
    focus = {
      resourceId: alertResource.id,
      label: alertResource.label,
      occurredAt: alertResource.lastAccessAt,
      detail: alertResource.detail,
      reason: 'alert has priority'
    };
  } else {
    if (runningTasks > 0) {
      focus = {
        resourceId: 'agent',
        label: RESOURCE_META.agent.label,
        occurredAt: toIso(now),
        detail: countPhrase(runningTasks, 'running task'),
        reason: 'running task'
      };
    } else if (pendingTasks > 0) {
      focus = {
        resourceId: 'task_queues',
        label: RESOURCE_META.task_queues.label,
        occurredAt: toIso(now),
        detail: countPhrase(pendingTasks, 'pending task'),
        reason: 'pending task'
      };
    } else {
      focus = {
        resourceId: 'break_room',
        label: RESOURCE_META.break_room.label,
        occurredAt: toIso(now),
        detail: 'no active work, lobster cooling claws',
        reason: 'no active work'
      };
    }
  }

  liveResources.push({
    id: 'break_room',
    label: RESOURCE_META.break_room.label,
    status: focus.resourceId === 'break_room' ? 'active' : 'idle',
    itemCount: 4,
    lastAccessAt: focus.resourceId === 'break_room' ? focus.occurredAt : null,
    summary: `${blockedTasks === 0 && failedDeliveries === 0 ? 'healthy' : 'attention needed'} · ${liveResources.filter((resource) => resource.status === 'active' || resource.status === 'alert').length} live signals · maintenance board ready`,
    detail: focus.resourceId === 'break_room' ? focus.detail : 'ready for fallback',
    source: RESOURCE_META.break_room.source,
    items: [
      (() => {
        const next = item('break-health', 'System Health', '.openclaw/openclaw.json', now, 'health');
        next.excerpt = `${blockedTasks} blocked tasks · ${pausedTasks} paused tasks · ${failedDeliveries} failed deliveries · ${liveResources.filter((resource) => resource.status === 'active' || resource.status === 'alert').length} active rooms`;
        return next;
      })(),
      (() => {
        const next = item('break-maintenance', 'Maintenance Board', '.openclaw/tasks/task-queue.json', now, 'maintenance');
        next.excerpt = `${blockedTasks} blocked · ${pausedTasks} paused · ${pendingTasks} pending · ${queuedDeliveryItems.length} delivery artifacts waiting for the next safe pass`;
        return next;
      })(),
      (() => {
        const next = item('break-breathe', 'Cooldown Lounge', '.openclaw/logs', now, 'recovery');
        next.excerpt = focus.resourceId === 'break_room'
          ? focus.detail
          : `${liveResources.filter((resource) => resource.status === 'active' || resource.status === 'alert').length} live rooms humming · quiet fallback mode ready`;
        return next;
      })(),
      (() => {
        const next = item('break-upgrade-watch', 'Upgrade Watch', 'package.json', now, 'upgrade');
        next.excerpt = 'review core package versions, Vite/TypeScript drift, and toolchain upgrades during low-pressure windows';
        return next;
      })()
    ]
  });

  return {
    resources: liveResources,
    focus,
    activeAgents
  };
}

function maybeAppendEvents(resources) {
  for (const resource of resources) {
    if (resource.id === 'break_room') {
      continue;
    }
    const signature = `${resource.status}|${resource.itemCount}|${resource.lastAccessAt ?? ''}|${resource.detail}`;
    const previous = lastSignatureByResource.get(resource.id);
    lastSignatureByResource.set(resource.id, signature);
    if (!previous || previous === signature) {
      continue;
    }
    eventLog.push({
      id: `${resource.id}-${Date.now()}`,
      resourceId: resource.id,
      label: resource.label,
      occurredAt: resource.lastAccessAt || new Date().toISOString(),
      detail: resource.detail,
      status: resource.status,
      source: resource.source
    });
  }
  clampEventLog();
}

function buildMockSnapshot() {
  const generatedAt = '2026-03-06T13:40:00.000Z';
  return {
    mode: 'mock',
    generatedAt,
    resources: [
      {
        id: 'document', label: 'Documents Archive', status: 'active', itemCount: 14, lastAccessAt: '2026-03-06T13:28:00.000Z',
        summary: '14 document items', detail: 'latest README.md', source: 'workspace/docs',
        items: [
          item('mock-doc-1', 'README.md', 'README.md', generatedAt, 'readme'),
          item('mock-doc-2', 'asset-contract-v2-openclaw-partitions.md', 'docs/asset-contract-v2-openclaw-partitions.md', generatedAt, 'document'),
          item('mock-doc-3', 'work-output.protocol.json', 'src/data/work-output.protocol.json', generatedAt, 'data')
        ]
      },
      {
        id: 'images', label: 'Images', status: 'idle', itemCount: 9, lastAccessAt: '2026-03-06T12:55:00.000Z',
        summary: '9 image assets', detail: 'latest art/prototypes', source: 'workspace/art',
        items: [
          (() => {
            const next = item('mock-img-1', 'scene-floor.png', 'public/assets/packs/default/2026-03-09/scene-floor.png', generatedAt, 'base art');
            next.thumbnailPath = thumbnailForPath(next.path);
            return next;
          })(),
          (() => {
            const next = item('mock-img-2', 'scene-objects.png', 'public/assets/packs/default/2026-03-09/scene-objects.png', generatedAt, 'room layer');
            next.thumbnailPath = thumbnailForPath(next.path);
            return next;
          })()
        ]
      },
      {
        id: 'memory', label: 'Memory', status: 'idle', itemCount: 6, lastAccessAt: '2026-03-06T12:42:00.000Z',
        summary: '6 memory notes', detail: 'latest memory/2026-03-06.md', source: 'workspace/memory',
        items: [
          item('mock-mem-1', '2026-03-06.md', 'memory/2026-03-06.md', generatedAt, 'daily note'),
          item('mock-mem-2', 'MEMORY.md', 'MEMORY.md', generatedAt, 'durable memory')
        ]
      },
      {
        id: 'skills', label: 'Skills', status: 'active', itemCount: 21, lastAccessAt: '2026-03-06T13:20:00.000Z',
        summary: '21 skill folders', detail: 'latest workspace/skills', source: 'workspace/skills',
        items: [
          item('mock-skill-1', 'nano-banana-pro', 'skills/nano-banana-pro', generatedAt, 'skill'),
          item('mock-skill-2', 'structured-task-runner', 'workspace/skills/structured-task-runner', generatedAt, 'skill')
        ]
      },
      {
        id: 'gateway', label: 'Interface Gateway', status: 'idle', itemCount: 7, lastAccessAt: '2026-03-06T12:31:00.000Z',
        summary: '3 integrations · 3 MCP nodes · 4 queue signals', detail: '1 paused task', source: '.openclaw/openclaw.json + .openclaw/tasks/task-queue.json + .openclaw/agents + workspace/config/mcporter.json',
        items: [
          (() => {
            const next = item('mock-gateway-1', 'OpenClaw Config', '.openclaw/openclaw.json', generatedAt, 'config');
            next.stats = [
              { label: 'providers', value: '3', tone: 'cool' },
              { label: 'agents', value: '2', tone: 'active' }
            ];
            return next;
          })(),
          (() => {
            const next = item('mock-gateway-2', 'Queue Overview', '.openclaw/tasks/task-queue.json', generatedAt, 'queue overview');
            next.stats = [
              { label: 'blocked', value: '0', tone: 'muted' },
              { label: 'paused', value: '1', tone: 'cool' },
              { label: 'pending', value: '2', tone: 'warm' },
              { label: 'deliveries', value: '1', tone: 'cool' }
            ];
            return next;
          })(),
          (() => {
            const next = item('mock-gateway-3', 'Agent Runtime', '.openclaw/agents/main/sessions/sessions.json', generatedAt, 'runtime');
            next.stats = [
              { label: 'sessions', value: '2', tone: 'cool' },
              { label: 'subagents', value: '1', tone: 'violet' }
            ];
            return next;
          })(),
          (() => {
            const next = item('mock-gateway-4', 'mcporter.json', 'workspace/config/mcporter.json', generatedAt, 'mcp server');
            next.stats = [{ label: 'transport', value: 'stdio', tone: 'violet' }];
            return next;
          })()
        ]
      },
      {
        id: 'log', label: 'Log', status: 'idle', itemCount: 7, lastAccessAt: '2026-03-06T12:08:00.000Z',
        summary: '7 log files', detail: 'latest workspace/logs', source: '.openclaw/logs',
        items: [item('mock-log-1', 'openclaw-telemetry.mjs', 'scripts/openclaw-telemetry.mjs', generatedAt, 'log file')]
      },
      {
        id: 'mcp', label: 'Code Lab', status: 'idle', itemCount: 2, lastAccessAt: '2026-03-06T11:48:00.000Z',
        summary: '1 git repo · 1 app project', detail: 'latest project/Star-Office-UI', source: 'workspace/project',
        items: [
          (() => {
            const next = item('mock-mcp-1', 'Star-Office-UI', 'project/Star-Office-UI', generatedAt, 'git repository');
            next.stats = [
              { label: 'branch', value: 'main', tone: 'active' },
              { label: 'readme', value: 'yes', tone: 'cool' }
            ];
            return next;
          })(),
          (() => {
            const next = item('mock-mcp-2', 'Claw Utility', 'project/ClawUtility', generatedAt, 'app project');
            next.stats = [
              { label: 'stack', value: 'node', tone: 'warm' },
              { label: 'src', value: 'yes', tone: 'cool' }
            ];
            return next;
          })()
        ]
      },
      {
        id: 'schedule', label: 'Scheduler Deck', status: 'idle', itemCount: 5, lastAccessAt: '2026-03-06T11:22:00.000Z',
        summary: '5 enabled jobs', detail: 'latest .openclaw/cron/jobs.json', source: '.openclaw/cron/jobs.json',
        items: [item('mock-schedule-1', 'Task Runner Dispatcher', '.openclaw/cron/jobs.json', generatedAt, 'cron job')]
      },
      {
        id: 'alarm', label: 'Alarm', status: 'idle', itemCount: 0, lastAccessAt: '2026-03-06T10:55:00.000Z',
        summary: '0 active alerts', detail: 'alarm clear', source: '.openclaw/delivery-queue/failed',
        items: [item('mock-alarm-1', 'alarm clear', '.openclaw/delivery-queue/failed', generatedAt, 'alert state')]
      },
      {
        id: 'agent', label: 'Run Dock', status: 'active', itemCount: 6, lastAccessAt: '2026-03-06T12:02:00.000Z',
        summary: '1 running · 2 pending · 0 blocked · 1 paused · 2 subagent runs', detail: '1 tasks currently running', source: '.openclaw/agents + .openclaw/subagents/runs.json + .openclaw/tasks/task-queue.json',
        items: [
          (() => {
            const next = item('mock-agent-1', 'Parallel Runs', '.openclaw/tasks/task-queue.json', generatedAt, 'running');
            next.stats = [
              { label: 'running', value: '1', tone: 'active' },
              { label: 'pending', value: '2', tone: 'warm' },
              { label: 'blocked', value: '0', tone: 'muted' },
              { label: 'paused', value: '1', tone: 'cool' },
              { label: 'done', value: '3', tone: 'calm' }
            ];
            return next;
          })(),
          (() => {
            const next = item('mock-agent-2', 'Main Agent · Session', '.openclaw/agents/main/sessions/sessions.json', generatedAt, 'session transcript');
            next.stats = [{ label: 'lane', value: 'main', tone: 'cool' }];
            return next;
          })(),
          (() => {
            const next = item('mock-agent-3', 'Codex · Session', '.openclaw/agents/codex/sessions/sessions.json', generatedAt, 'session transcript');
            next.stats = [{ label: 'lane', value: 'codex', tone: 'cool' }];
            return next;
          })(),
          (() => {
            const next = item('mock-agent-4', 'Subagent Run · img-polish', '.openclaw/subagents/runs.json', generatedAt, 'subagent run');
            next.stats = [{ label: 'run', value: '#1', tone: 'violet' }];
            return next;
          })()
        ]
      },
      {
        id: 'task_queues', label: 'Task Queues', status: 'idle', itemCount: 4, lastAccessAt: '2026-03-06T12:12:00.000Z',
        summary: '4 queue tasks', detail: '1 paused task', source: '.openclaw/tasks/task-queue.json',
        items: [item('mock-taskq-1', 'Paused Task · T-01', '.openclaw/tasks/task-queue.json', generatedAt, 'paused')]
      },
      {
        id: 'break_room', label: 'Break Room', status: 'idle', itemCount: 4, lastAccessAt: null,
        summary: 'healthy · 2 live signals · maintenance board ready', detail: 'ready for fallback', source: 'crew/break-room',
        items: [
          (() => {
            const next = item('mock-break-1', 'System Health', '.openclaw/openclaw.json', generatedAt, 'health');
            next.excerpt = '0 blocked tasks · 1 paused task · 0 failed deliveries · 2 active rooms';
            return next;
          })(),
          (() => {
            const next = item('mock-break-2', 'Maintenance Board', '.openclaw/tasks/task-queue.json', generatedAt, 'maintenance');
            next.excerpt = '0 blocked · 1 paused · 2 pending · 1 delivery artifact waiting for the next pass';
            return next;
          })(),
          (() => {
            const next = item('mock-break-3', 'Cooldown Lounge', '.openclaw/logs', generatedAt, 'recovery');
            next.excerpt = 'quiet fallback mode ready';
            return next;
          })(),
          (() => {
            const next = item('mock-break-4', 'Upgrade Watch', 'package.json', generatedAt, 'upgrade');
            next.excerpt = 'review package drift during low-pressure windows';
            return next;
          })()
        ]
      }
    ],
    recentEvents: [],
    focus: {
      resourceId: 'document',
      label: 'Documents Archive',
      occurredAt: '2026-03-06T13:28:00.000Z',
      detail: 'latest docs/tasks/TODO-2026-03-06.md',
      reason: 'deterministic QA snapshot'
    },
    activeAgents: []
  };
}

function stripSnapshotItems(snapshot) {
  return {
    ...snapshot,
    resources: snapshot.resources.map(({ items, ...resource }) => resource)
  };
}

export function findSnapshotResource(snapshot, resourceId) {
  return snapshot.resources.find((resource) => resource.id === resourceId) ?? null;
}

export async function createOpenClawSnapshot({ mock = false, includeItems = true, itemResourceIds = null, includeExcerpt = true } = {}) {
  if (mock) {
    const snapshot = buildMockSnapshot();
    return includeItems ? snapshot : stripSnapshotItems(snapshot);
  }

  const generatedAt = new Date().toISOString();
  const requestedItemResourceIds = includeItems
    ? (itemResourceIds ? new Set(itemResourceIds) : null)
    : new Set();
  const { resources, focus, activeAgents } = await buildLiveResources({ itemResourceIds: requestedItemResourceIds, includeExcerpt });
  maybeAppendEvents(resources);

  const snapshot = {
    mode: 'live',
    generatedAt,
    resources,
    recentEvents: eventLog.slice(-12),
    focus,
    activeAgents
  };
  return includeItems ? snapshot : stripSnapshotItems(snapshot);
}

import Phaser from 'phaser';
import appConfig from '../clawlibrary.config.json';
import { LibraryScene } from './runtime/scene/LibraryScene';
import type { ActiveExecProcess, GrowthState, OpenClawResourceItem, OpenClawSnapshot, ResourcePartitionId } from './core/types';
import type { UiLocale } from './ui/locale';
import { resourceLabel, uiText } from './ui/locale';
import { PARTITION_CSS_COLORS } from './ui/palette';

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;
const TELEMETRY_POLL_MS = appConfig.telemetry.pollMs;
const MODAL_PREFS_STORAGE_KEY = 'clawlibrary-modal-prefs-v2';
const UI_LOCALE_STORAGE_KEY = 'clawlibrary-ui-locale-v1';
const INFO_PANEL_STORAGE_KEY = 'clawlibrary-info-panel-visible-v1';
const DEBUG_PANEL_STORAGE_KEY = 'clawlibrary-debug-panel-visible-v1';
const ACTOR_VARIANT_STORAGE_KEY = 'clawlibrary-actor-variant-v1';
const MENU_RESOURCE_IDS: ResourcePartitionId[] = [
  'skills',
  'memory',
  'document',
  'images',
  'gateway',
  'schedule',
  'agent',
  'mcp',
  'log',
  'alarm',
  'break_room'
];
const MERGED_RESOURCE_IDS = new Set<ResourcePartitionId>(['task_queues']);
const EXTERNAL_KIND_MENU_RESOURCE_IDS = new Set<ResourcePartitionId>(['gateway', 'document', 'memory', 'break_room']);
const RESOURCE_UI_ALIAS: Partial<Record<ResourcePartitionId, ResourcePartitionId>> = {
  task_queues: 'gateway'
};
const DEFAULT_UI_LOCALE = (appConfig.ui.defaultLocale === 'zh' ? 'zh' : 'en') as UiLocale;

const scene = new LibraryScene();

async function loadUiFonts(): Promise<void> {
  if (!('fonts' in document)) {
    return;
  }
  await Promise.allSettled([
    document.fonts.load('400 20px "VT323"')
  ]);
}

await loadUiFonts();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  transparent: true,
  audio: {
    // AudioContext requires a user gesture before it can start.
    // We resume it on the first pointerdown so the browser doesn't block it.
    // (noAudio: true was set here before — it silenced the console warning but killed all sound)
    context: (() => {
      const ctx = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
      const resume = () => { void ctx.resume(); };
      window.addEventListener('pointerdown', resume, { once: true });
      return ctx;
    })()
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: BASE_WIDTH,
    height: BASE_HEIGHT
  },
  input: {
    activePointers: 3
  },
  scene: [scene]
});

if (import.meta.env.DEV) {
  (window as typeof window & {
    __clawlibraryDebug?: {
      game: Phaser.Game;
      getScene: () => LibraryScene;
    };
  }).__clawlibraryDebug = {
    game,
    getScene: () => (game.scene.isActive('LibraryScene') ? (game.scene.getScene('LibraryScene') as LibraryScene) : scene)
  };
}

const state: GrowthState = {
  assetsCount: 0,
  skillsCount: 0,
  textOutputs: 0
};

const forceMock = new URLSearchParams(window.location.search).get('mock') === '1';

const cycleThemeButton = document.getElementById('cycle-theme');
const toggleActorSkinButton = document.getElementById('toggle-actor-skin') as HTMLButtonElement | null;
const toggleLocaleButton = document.getElementById('toggle-locale') as HTMLButtonElement | null;
const toggleDebugButton = document.getElementById('toggle-debug') as HTMLButtonElement | null;
const hudTitleMain = document.getElementById('hud-title-main');
const hudTitleSub = document.getElementById('hud-title-sub');
const hudStats = document.getElementById('hud-stats');
const hudActivityTitle = document.getElementById('hud-activity-title');
const hudActorStatus = document.getElementById('hud-actor-status');
const hudActivityItems = document.getElementById('hud-activity-items');
const toggleInfoPanelButton = document.getElementById('toggle-info-panel') as HTMLButtonElement | null;
const menuPanelStamp = document.getElementById('menu-panel-stamp');
const menuPanelSub = document.getElementById('menu-panel-sub');
const resourceMenu = document.getElementById('resource-menu');
const gatewayCategoryMenu = document.getElementById('gateway-category-menu');
const assetModal = document.getElementById('asset-modal');
const assetModalTitle = document.getElementById('asset-modal-title');
const assetModalSub = document.getElementById('asset-modal-sub');
const assetModalFeedback = document.getElementById('asset-modal-feedback');
const assetModalContext = document.getElementById('asset-modal-context');
const assetModalSummary = document.getElementById('asset-modal-summary');
const assetModalItems = document.getElementById('asset-modal-items');
const assetModalClose = document.getElementById('asset-modal-close');
const assetModalCopyContext = document.getElementById('asset-modal-copy-context') as HTMLButtonElement | null;
const assetModalSort = document.getElementById('asset-modal-sort') as HTMLSelectElement | null;
const assetModalKind = document.getElementById('asset-modal-kind') as HTMLSelectElement | null;
const assetModalView = document.getElementById('asset-modal-view') as HTMLButtonElement | null;
const assetModalSearch = document.getElementById('asset-modal-search') as HTMLInputElement | null;
const previewModal = document.getElementById('preview-modal');
const previewModalTitle = document.getElementById('preview-modal-title');
const previewModalSub = document.getElementById('preview-modal-sub');
const previewModalNote = document.getElementById('preview-modal-note');
const previewModalBody = document.getElementById('preview-modal-body');
const previewModalClose = document.getElementById('preview-modal-close') as HTMLButtonElement | null;
const previewModalFolder = document.getElementById('preview-modal-folder') as HTMLButtonElement | null;
const debugOverlay = document.getElementById('debug-overlay');

type ModalSortMode = 'priority' | 'date-desc' | 'date-asc' | 'size-desc' | 'size-asc';
type ModalViewMode = 'list' | 'grid';
type ResourceModalPreference = {
  sortMode: ModalSortMode;
  viewMode: ModalViewMode;
};
type PreviewKind = 'image' | 'markdown' | 'json' | 'text';
type PreviewReadMode = 'full' | 'head' | 'tail';
type PreviewPayload = {
  kind: PreviewKind;
  path: string;
  contentType: string;
  url?: string;
  content?: string;
  truncated?: boolean;
  readMode?: PreviewReadMode;
};
type PreviewState =
  | {
      status: 'idle';
      item: null;
      payload: null;
      error: '';
    }
  | {
      status: 'loading' | 'ready' | 'error';
      item: OpenClawResourceItem;
      payload: PreviewPayload | null;
      error: string;
    };
type MenuAnchorSource = 'menu' | 'scene';
type MenuAnchor = {
  x: number;
  y: number;
  source: MenuAnchorSource;
  scenePoint?: {
    x: number;
    y: number;
  };
};
type ResourceSelectEvent = {
  resourceId: ResourcePartitionId;
  anchor?: { x: number; y: number };
};
type RecentActivityGroup = {
  resourceId: ResourcePartitionId;
  label: string;
  events: OpenClawSnapshot['recentEvents'];
  latestAt: string;
};
type ResourceDetailResponse = {
  ok: boolean;
  resource?: OpenClawSnapshot['resources'][number];
  error?: string;
};
type DebugPoint = {
  clientX: number | null;
  clientY: number | null;
  sceneX: number | null;
  sceneY: number | null;
  insideStage: boolean;
};

let lastSnapshot: OpenClawSnapshot | null = null;
let prevActiveAgentIds = new Set<string>();
let prevActiveProcessIds = new Set<string>();
const resourceDetailItemsById = new Map<ResourcePartitionId, OpenClawResourceItem[]>();
const resourceDetailLoadedById = new Set<ResourcePartitionId>();
const resourceDetailRequestsById = new Map<ResourcePartitionId, Promise<void>>();
const resourceDetailErrorsById = new Map<ResourcePartitionId, string>();
let selectedResourceId: ResourcePartitionId | null = null;
let modalVisible = false;
let categoryMenuVisible = false;
let categoryMenuResourceId: ResourcePartitionId | null = null;
let sceneEventsBound = false;
let modalSortMode: ModalSortMode = 'priority';
let modalViewMode: ModalViewMode = 'list';
let modalKindFilter = 'all';
let modalSearchQuery = '';
let modalPrefsByResource: Partial<Record<ResourcePartitionId, ResourceModalPreference>> = {};
let modalFeedbackTimer: number | null = null;
let uiLocale: UiLocale = DEFAULT_UI_LOCALE;
let infoPanelVisible = appConfig.ui.defaultInfoPanelVisible;
let debugPanelVisible = appConfig.ui.defaultDebugVisible;
let pendingCategoryMenuAnchor: MenuAnchor | null = null;
let categoryMenuRequestId = 0;
let actorVariantId = appConfig.actor.defaultVariantId;
let selectedActivityGroupId: ResourcePartitionId | null = null;
let debugPointer: DebugPoint = {
  clientX: null,
  clientY: null,
  sceneX: null,
  sceneY: null,
  insideStage: false
};
let debugLastClick: DebugPoint = {
  clientX: null,
  clientY: null,
  sceneX: null,
  sceneY: null,
  insideStage: false
};
let previewState: PreviewState = {
  status: 'idle',
  item: null,
  payload: null,
  error: ''
};
let previewRequestId = 0;

function clockOf(value: string | null | undefined): string {
  if (!value) {
    return '--:--';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function uiResourceId(resourceId: ResourcePartitionId): ResourcePartitionId {
  return RESOURCE_UI_ALIAS[resourceId] ?? resourceId;
}

function mergedResourceStatus(
  ...statuses: Array<OpenClawSnapshot['resources'][number]['status'] | undefined>
): OpenClawSnapshot['resources'][number]['status'] {
  if (statuses.includes('alert')) return 'alert';
  if (statuses.includes('active')) return 'active';
  if (statuses.every((status) => status === 'offline')) return 'offline';
  return 'idle';
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestTime = -Infinity;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isNaN(time) || time <= latestTime) continue;
    latestTime = time;
    latestValue = value;
  }
  return latestValue;
}

function detailResourceIdsFor(resourceId: ResourcePartitionId): ResourcePartitionId[] {
  return resourceId === 'gateway' ? ['gateway', 'task_queues'] : [resourceId];
}

function hasLoadedResourceDetail(resourceId: ResourcePartitionId): boolean {
  return detailResourceIdsFor(resourceId).every((id) => resourceDetailLoadedById.has(id));
}

function itemsForResourceId(resourceId: ResourcePartitionId): OpenClawResourceItem[] {
  return resourceDetailItemsById.get(resourceId) ?? [];
}

async function loadResourceDetail(targetResourceId: ResourcePartitionId): Promise<void> {
  if (resourceDetailLoadedById.has(targetResourceId)) {
    return;
  }
  const pending = resourceDetailRequestsById.get(targetResourceId);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    const query = forceMock ? '&mock=1' : '';
    const response = await fetch(`/api/openclaw/resource?resourceId=${encodeURIComponent(targetResourceId)}${query}`, {
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const payload = (await response.json()) as ResourceDetailResponse;
    if (!payload.ok || !payload.resource) {
      throw new Error(payload.error || 'resource detail unavailable');
    }
    resourceDetailItemsById.set(targetResourceId, payload.resource.items ?? []);
    resourceDetailLoadedById.add(targetResourceId);
    resourceDetailErrorsById.delete(targetResourceId);
  })()
    .catch((error) => {
      resourceDetailErrorsById.set(targetResourceId, error instanceof Error ? error.message : String(error));
      throw error;
    })
    .finally(() => {
      resourceDetailRequestsById.delete(targetResourceId);
    });

  resourceDetailRequestsById.set(targetResourceId, request);
  return request;
}

async function ensureResourceDetail(resourceId: ResourcePartitionId): Promise<void> {
  const detailIds = detailResourceIdsFor(resourceId);
  await Promise.all(detailIds.map((id) => loadResourceDetail(id)));
}

function resourcesForUi(): OpenClawSnapshot['resources'] {
  if (!lastSnapshot) {
    return [];
  }

  const resourceMap = new Map(lastSnapshot.resources.map((resource) => [resource.id, resource] as const));
  const gateway = resourceMap.get('gateway');
  const queue = resourceMap.get('task_queues');

  return lastSnapshot.resources.flatMap((resource) => {
    if (MERGED_RESOURCE_IDS.has(resource.id)) {
      return [];
    }
    if (resource.id !== 'gateway' || !gateway) {
      return [{
        ...resource,
        items: itemsForResourceId(resource.id)
      }];
    }
    if (!queue) {
      return [{
        ...gateway,
        items: itemsForResourceId('gateway')
      }];
    }

    const queueItems = itemsForResourceId('task_queues');
    const gatewayItems = itemsForResourceId('gateway');
    const mergedGateway = {
      ...gateway,
      label: resourceLabel('gateway', uiLocale),
      status: mergedResourceStatus(gateway.status, queue.status),
      itemCount: gateway.itemCount + queue.itemCount,
      lastAccessAt: latestIso(gateway.lastAccessAt, queue.lastAccessAt),
      summary: `${gateway.itemCount} integrations · ${queue.itemCount} queue signals`,
      detail: queue.status === 'alert'
        ? queue.detail
        : gateway.detail,
      source: `${gateway.source} + ${queue.source}`,
      items: [...gatewayItems, ...queueItems.slice(0, 6)]
    };

    return [mergedGateway];
  });
}

function resourceForUi(resourceId: ResourcePartitionId): OpenClawSnapshot['resources'][number] | null {
  const targetId = uiResourceId(resourceId);
  return resourcesForUi().find((resource) => resource.id === targetId) ?? null;
}

function clientPointFromScenePoint(point: { x: number; y: number }): { x: number; y: number } {
  const canvas = document.querySelector('#app canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return {
      x: Math.round(window.innerWidth * 0.5),
      y: Math.round(window.innerHeight * 0.4)
    };
  }
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width * (point.x / BASE_WIDTH)),
    y: Math.round(rect.top + rect.height * (point.y / BASE_HEIGHT))
  };
}

function invalidateCategoryMenuRequest(): number {
  categoryMenuRequestId += 1;
  return categoryMenuRequestId;
}

function resetCategoryMenuDom(): void {
  if (!gatewayCategoryMenu) {
    return;
  }
  gatewayCategoryMenu.classList.add('hidden');
  gatewayCategoryMenu.setAttribute('aria-hidden', 'true');
  gatewayCategoryMenu.removeAttribute('data-layout');
  gatewayCategoryMenu.style.removeProperty('--gateway-center-x');
  gatewayCategoryMenu.style.removeProperty('--gateway-center-y');
  gatewayCategoryMenu.innerHTML = '';
}

function resolveMenuAnchor(anchor: MenuAnchor | null): MenuAnchor | null {
  if (!anchor || anchor.source !== 'scene' || !anchor.scenePoint) {
    return anchor;
  }
  return {
    ...anchor,
    ...clientPointFromScenePoint(anchor.scenePoint)
  };
}

function scenePointFromClientPoint(point: { x: number; y: number }): DebugPoint {
  const canvas = document.querySelector('#app canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return {
      clientX: point.x,
      clientY: point.y,
      sceneX: null,
      sceneY: null,
      insideStage: false
    };
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return {
      clientX: point.x,
      clientY: point.y,
      sceneX: null,
      sceneY: null,
      insideStage: false
    };
  }
  const normalizedX = (point.x - rect.left) / rect.width;
  const normalizedY = (point.y - rect.top) / rect.height;
  return {
    clientX: Math.round(point.x),
    clientY: Math.round(point.y),
    sceneX: Math.round(normalizedX * BASE_WIDTH),
    sceneY: Math.round(normalizedY * BASE_HEIGHT),
    insideStage: normalizedX >= 0 && normalizedX <= 1 && normalizedY >= 0 && normalizedY <= 1
  };
}

function resourceUsesExternalKindMenu(resourceId: ResourcePartitionId): boolean {
  return EXTERNAL_KIND_MENU_RESOURCE_IDS.has(resourceId);
}

function kindGroupsForResource(resourceId: ResourcePartitionId): Array<{ id: string; label: string; count: number }> {
  const resource = resourceForUi(resourceId);
  if (!resource) {
    return [];
  }
  return kindGroupsOf(resourceId, resource.items ?? []).slice(0, 6);
}

function kindMenuLabelForResource(resourceId: ResourcePartitionId, kindId: string): string {
  if (resourceId === 'document') {
    if (kindId === 'Task Docs') return uiLocale === 'zh' ? '任务文档' : 'Tasks';
    if (kindId === 'Readmes') return uiLocale === 'zh' ? '说明文档' : 'Readmes';
    if (kindId === 'Reports') return uiLocale === 'zh' ? '报告' : 'Reports';
    if (kindId === 'Plans') return uiLocale === 'zh' ? '计划' : 'Plans';
    if (kindId === 'Data Files') return uiLocale === 'zh' ? '数据' : 'Data';
    if (kindId === 'Documents') return uiLocale === 'zh' ? '文档' : 'Docs';
  }

  if (resourceId === 'memory') {
    if (kindId === 'Daily Notes') return uiLocale === 'zh' ? '日记' : 'Daily';
    if (kindId === 'Core Memory') return uiLocale === 'zh' ? '核心记忆' : 'Core';
    if (kindId === 'Finance Memory') return uiLocale === 'zh' ? '财务记忆' : 'Finance';
    if (kindId === 'Memory Notes') return uiLocale === 'zh' ? '笔记' : 'Notes';
  }

  if (resourceId === 'gateway') {
    if (kindId === 'Queue Status') return uiLocale === 'zh' ? '队列' : 'Queue';
    if (kindId === 'Connections') return uiLocale === 'zh' ? '连接' : 'Connect';
  }

  if (resourceId === 'break_room') {
    if (kindId === 'Upgrade Watch') return uiLocale === 'zh' ? '升级' : 'Upgrade';
  }

  if (resourceId === 'agent') {
    if (kindId === 'Parallel Runs') return uiLocale === 'zh' ? '并行运行' : 'Parallel Runs';
    if (kindId === 'Sessions') return uiLocale === 'zh' ? '会话' : 'Sessions';
    if (kindId === 'Subagent Runs') return uiLocale === 'zh' ? '子代理运行' : 'Subagent Runs';
    if (kindId === 'Task Status') return uiLocale === 'zh' ? '任务状态' : 'Task Status';
    if (kindId === 'Agent State') return uiLocale === 'zh' ? '运行状态' : 'Agent State';
  }

  if (resourceId === 'task_queues') {
    if (kindId === 'Blocked Tasks') return uiLocale === 'zh' ? '阻塞任务' : 'Blocked Tasks';
    if (kindId === 'Paused Tasks') return uiLocale === 'zh' ? '已暂停任务' : 'Paused Tasks';
    if (kindId === 'Pending Tasks') return uiLocale === 'zh' ? '待处理任务' : 'Pending Tasks';
    if (kindId === 'Running Tasks') return uiLocale === 'zh' ? '运行中任务' : 'Running Tasks';
    if (kindId === 'Completed Tasks') return uiLocale === 'zh' ? '已完成任务' : 'Completed Tasks';
    if (kindId === 'Deliveries') return uiLocale === 'zh' ? '投递项' : 'Deliveries';
  }

  if (resourceId === 'alarm') {
    if (kindId === 'Blocked Tasks') return uiLocale === 'zh' ? '阻塞任务' : 'Blocked Tasks';
    if (kindId === 'Failed Deliveries') return uiLocale === 'zh' ? '失败投递' : 'Failed Deliveries';
  }

  return kindId;
}

function categoryMenuPanelPosition(
  resourceId: ResourcePartitionId,
  count: number,
  anchor: MenuAnchor | null
): { left: number; top: number; width: number } {
  const width = window.innerWidth <= 700 ? 148 : 164;
  const itemHeight = window.innerWidth <= 700 ? 42 : 46;
  const panelHeight = count * itemHeight + Math.max(0, count - 1) * 6 + 12;
  const margin = window.innerWidth <= 700 ? 12 : 18;

  if (anchor) {
    const preferredLeft = anchor.source === 'menu'
      ? anchor.x - width - 14
      : anchor.x + 14;
    const left = anchor.source === 'scene'
      ? Math.min(Math.max(preferredLeft, margin), window.innerWidth - margin - width)
      : Math.min(Math.max(preferredLeft, margin), window.innerWidth - margin - width);
    const top = Math.min(
      Math.max(anchor.y - 18, margin),
      window.innerHeight - margin - panelHeight
    );
    return { left, top, width };
  }

  const button = resourceMenu?.querySelector(`button[data-resource-id="${resourceId}"]`);
  if (button instanceof HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    const left = Math.max(margin, rect.left - width - 12);
    const top = Math.min(
      Math.max(rect.top, margin),
      window.innerHeight - margin - panelHeight
    );
    return { left, top, width };
  }

  return {
    left: Math.max(margin, Math.round(window.innerWidth * 0.72) - width),
    top: Math.round(window.innerHeight * 0.28),
    width
  };
}

function clampCategoryMenuCenter(center: { x: number; y: number }, radius: number): { x: number; y: number } {
  const horizontalPad = radius + (window.innerWidth <= 700 ? 60 : 76);
  const verticalPad = radius + (window.innerWidth <= 700 ? 34 : 40);
  const margin = window.innerWidth <= 700 ? 14 : 22;
  return {
    x: Math.min(Math.max(center.x, margin + horizontalPad), window.innerWidth - margin - horizontalPad),
    y: Math.min(Math.max(center.y, margin + verticalPad), window.innerHeight - margin - verticalPad)
  };
}

function categoryMenuPetalLayout(
  count: number,
  anchor: MenuAnchor
): { center: { x: number; y: number }; radius: number; arcStartDeg: number; arcSweepDeg: number } {
  const radius = window.innerWidth <= 700 ? (count <= 3 ? 62 : 72) : count <= 3 ? 70 : 82;
  const center = clampCategoryMenuCenter({ x: anchor.x, y: anchor.y }, radius);
  return {
    center,
    radius,
    arcStartDeg: -90,
    arcSweepDeg: 360
  };
}

function closeCategoryMenu(): void {
  invalidateCategoryMenuRequest();
  categoryMenuVisible = false;
  categoryMenuResourceId = null;
  pendingCategoryMenuAnchor = null;
  resetCategoryMenuDom();
  syncResourceControls();
}

function openResourceKind(resourceId: ResourcePartitionId, kindId: string): void {
  closePreviewModal();
  closeCategoryMenu();
  if (selectedResourceId !== resourceId) {
    resetModalFilters();
    applyModalDefaultsForResource(resourceId);
  }
  selectedResourceId = resourceId;
  modalKindFilter = kindId;
  modalVisible = true;
  void ensureResourceDetail(resourceId)
    .then(() => {
      if (selectedResourceId === resourceId && modalVisible) {
        renderRoomModal();
      }
    })
    .catch(() => {
      renderRoomModal();
    });
  renderRoomModal();
  syncResourceControls();
}

async function openResourceKindMenu(resourceId: ResourcePartitionId, anchor: MenuAnchor | null = null): Promise<void> {
  const requestId = invalidateCategoryMenuRequest();
  closePreviewModal();
  if (selectedResourceId !== resourceId) {
    resetModalFilters();
    applyModalDefaultsForResource(resourceId);
  }
  selectedResourceId = resourceId;
  categoryMenuVisible = false;
  categoryMenuResourceId = null;
  pendingCategoryMenuAnchor = anchor;
  resetCategoryMenuDom();
  syncResourceControls();
  if (!hasLoadedResourceDetail(resourceId) && (resourceForUi(resourceId)?.itemCount ?? 0) > 0) {
    try {
      await ensureResourceDetail(resourceId);
    } catch {
      if (requestId !== categoryMenuRequestId) {
        return;
      }
      modalVisible = true;
      renderRoomModal();
      syncResourceControls();
      return;
    }
    if (requestId !== categoryMenuRequestId) {
      return;
    }
  }
  const groups = kindGroupsForResource(resourceId);
  if (groups.length === 0) {
    modalVisible = true;
    renderRoomModal();
    syncResourceControls();
    return;
  }
  if (groups.length === 1) {
    openResourceKind(resourceId, groups[0].id);
    return;
  }
  if (!gatewayCategoryMenu) {
    modalVisible = true;
    renderRoomModal();
    syncResourceControls();
    return;
  }

  const resolvedAnchor = resolveMenuAnchor(pendingCategoryMenuAnchor ?? anchor);
  pendingCategoryMenuAnchor = resolvedAnchor;
  if (resolvedAnchor?.source === 'scene') {
    const { center, radius, arcStartDeg, arcSweepDeg } = categoryMenuPetalLayout(groups.length, resolvedAnchor);
    gatewayCategoryMenu.dataset.layout = 'petal';
    gatewayCategoryMenu.style.setProperty('--gateway-center-x', `${center.x}px`);
    gatewayCategoryMenu.style.setProperty('--gateway-center-y', `${center.y}px`);
    gatewayCategoryMenu.innerHTML = groups.map((group, index) => {
      const angleStep = groups.length === 1 ? 0 : arcSweepDeg / Math.max(groups.length - 1, 1);
      const angle = (arcSweepDeg >= 360
        ? arcStartDeg + (360 / groups.length) * index
        : arcStartDeg + angleStep * index) * (Math.PI / 180);
      const x = Math.round(Math.cos(angle) * radius);
      const y = Math.round(Math.sin(angle) * radius);
      return `
        <button
          class="gateway-category-chip petal"
          type="button"
          data-kind-id="${escapeHtml(group.id)}"
          style="--offset-x:${x}px; --offset-y:${y}px;"
        >
          <span>${escapeHtml(kindMenuLabelForResource(resourceId, group.id))}</span>
          <strong>${escapeHtml(String(group.count))}</strong>
        </button>
      `;
    }).join('');
  } else {
    const panel = categoryMenuPanelPosition(resourceId, groups.length, resolvedAnchor);
    gatewayCategoryMenu.dataset.layout = 'list';
    gatewayCategoryMenu.innerHTML = `
      <div class="gateway-category-panel" style="left:${panel.left}px; top:${panel.top}px; width:${panel.width}px;">
        ${groups.map((group) => `
          <button
            class="gateway-category-chip"
            type="button"
            data-kind-id="${escapeHtml(group.id)}"
          >
            <span>${escapeHtml(kindMenuLabelForResource(resourceId, group.id))}</span>
            <strong>${escapeHtml(String(group.count))}</strong>
          </button>
        `).join('')}
      </div>
    `;
  }
  categoryMenuVisible = true;
  categoryMenuResourceId = resourceId;
  gatewayCategoryMenu.classList.remove('hidden');
  gatewayCategoryMenu.setAttribute('aria-hidden', 'false');
  modalVisible = false;
  syncResourceControls();
}

function getSelectedResource() {
  if (!lastSnapshot) {
    return null;
  }

  const targetResourceId = uiResourceId(selectedResourceId ?? lastSnapshot.focus.resourceId);
  return resourceForUi(targetResourceId) ?? resourcesForUi()[0] ?? null;
}

function modalDefaultsForResource(resourceId: ResourcePartitionId): {
  sortMode: ModalSortMode;
  viewMode: ModalViewMode;
} {
  if (resourceId === 'images') {
    return {
      sortMode: 'date-desc',
      viewMode: 'grid'
    };
  }

  return {
    sortMode: 'date-desc',
    viewMode: 'list'
  };
}

function loadLocale(): void {
  try {
    const saved = localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      uiLocale = saved;
      return;
    }
  } catch {
    uiLocale = DEFAULT_UI_LOCALE;
  }
  uiLocale = DEFAULT_UI_LOCALE;
}

function saveLocale(): void {
  try {
    localStorage.setItem(UI_LOCALE_STORAGE_KEY, uiLocale);
  } catch {
    // ignore storage failures
  }
}

function loadInfoPanelPreference(): void {
  try {
    // If Chat panel is saved as visible, Info must be hidden (mutually exclusive)
    const chatSaved = localStorage.getItem('clawlibrary-chat-visible');
    if (chatSaved === '1') {
      infoPanelVisible = false;
      return;
    }
    const saved = localStorage.getItem(INFO_PANEL_STORAGE_KEY);
    if (saved === '0') {
      infoPanelVisible = false;
      return;
    }
    if (saved === '1') {
      infoPanelVisible = true;
      return;
    }
    infoPanelVisible = appConfig.ui.defaultInfoPanelVisible;
  } catch {
    infoPanelVisible = appConfig.ui.defaultInfoPanelVisible;
  }
}

function saveInfoPanelPreference(): void {
  try {
    localStorage.setItem(INFO_PANEL_STORAGE_KEY, infoPanelVisible ? '1' : '0');
  } catch {
    // ignore storage failures
  }
}

function loadDebugPanelPreference(): void {
  try {
    const saved = localStorage.getItem(DEBUG_PANEL_STORAGE_KEY);
    debugPanelVisible = saved === null ? appConfig.ui.defaultDebugVisible : saved === '1';
  } catch {
    debugPanelVisible = appConfig.ui.defaultDebugVisible;
  }
}

function saveDebugPanelPreference(): void {
  try {
    localStorage.setItem(DEBUG_PANEL_STORAGE_KEY, debugPanelVisible ? '1' : '0');
  } catch {
    // ignore storage failures
  }
}

function loadActorVariantPreference(): void {
  try {
    actorVariantId = localStorage.getItem(ACTOR_VARIANT_STORAGE_KEY) || appConfig.actor.defaultVariantId;
  } catch {
    actorVariantId = appConfig.actor.defaultVariantId;
  }
}

function saveActorVariantPreference(): void {
  try {
    if (actorVariantId) {
      localStorage.setItem(ACTOR_VARIANT_STORAGE_KEY, actorVariantId);
    } else {
      localStorage.removeItem(ACTOR_VARIANT_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

function shortActorVariantLabel(label: string, locale: UiLocale): string {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes('capy')) {
    return locale === 'zh' ? '水豚·爪' : 'capy·claw';
  }
  if (normalized.includes('cat')) {
    return locale === 'zh' ? '猫咪·爪' : 'cat·claw';
  }
  return label
    .replace(/-?claw/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function updateActorSkinButtonLabel(): void {
  if (!toggleActorSkinButton) {
    return;
  }
  const activeScene = getActiveScene();
  const variantLabel = activeScene?.getActorVariantLabel?.() ?? 'Actor';
  const variantCount = activeScene?.getActorVariants().length ?? 0;
  toggleActorSkinButton.textContent = shortActorVariantLabel(variantLabel, uiLocale);
  toggleActorSkinButton.disabled = variantCount <= 1;
}

function loadModalPrefs(): void {
  try {
    const raw = localStorage.getItem(MODAL_PREFS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    modalPrefsByResource = JSON.parse(raw) as Partial<Record<ResourcePartitionId, ResourceModalPreference>>;
  } catch {
    modalPrefsByResource = {};
  }
}

function saveModalPrefs(): void {
  try {
    localStorage.setItem(MODAL_PREFS_STORAGE_KEY, JSON.stringify(modalPrefsByResource));
  } catch {
    // ignore storage failures
  }
}

function sortItems(items: OpenClawResourceItem[]): OpenClawResourceItem[] {
  const next = [...items];
  if (modalSortMode === 'priority') {
    return next;
  }
  next.sort((left, right) => {
    if (modalSortMode === 'date-desc') {
      return (right.updatedAt ? new Date(right.updatedAt).getTime() : 0) - (left.updatedAt ? new Date(left.updatedAt).getTime() : 0);
    }
    if (modalSortMode === 'date-asc') {
      return (left.updatedAt ? new Date(left.updatedAt).getTime() : 0) - (right.updatedAt ? new Date(right.updatedAt).getTime() : 0);
    }
    if (modalSortMode === 'size-desc') {
      return (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
    }
    return (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0);
  });
  return next;
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchTermsOf(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function highlightMatch(value: string | null | undefined, query: string): string {
  const raw = String(value ?? '');
  const terms = searchTermsOf(query);
  if (terms.length === 0) {
    return escapeHtml(raw);
  }

  const pattern = new RegExp(
    terms
      .sort((left, right) => right.length - left.length)
      .map((term) => escapeRegExp(term))
      .join('|'),
    'ig'
  );
  let cursor = 0;
  let result = '';

  for (const match of raw.matchAll(pattern)) {
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    result += escapeHtml(raw.slice(cursor, index));
    result += `<mark class="search-hit">${escapeHtml(match[0])}</mark>`;
    cursor = index + match[0].length;
  }

  if (!result) {
    return escapeHtml(raw);
  }

  result += escapeHtml(raw.slice(cursor));
  return result;
}

function titleCaseLabel(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const IMAGE_PREVIEW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.log',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.csv',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.sh',
  '.bash',
  '.zsh',
  '.css',
  '.html',
  '.xml',
  '.sql'
]);

function extensionOf(pathValue: string | null | undefined): string {
  const normalized = String(pathValue ?? '');
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0) {
    return '';
  }
  return normalized.slice(dotIndex).toLowerCase();
}

function previewKindOfPath(pathValue: string | null | undefined): PreviewKind | null {
  const ext = extensionOf(pathValue);
  if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (ext === '.md') {
    return 'markdown';
  }
  if (ext === '.json') {
    return 'json';
  }
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return null;
}

function isDirectoryPreviewItem(item: OpenClawResourceItem | null | undefined): boolean {
  if (!item) {
    return false;
  }
  const previewPath = String(item.openPath ?? item.path ?? '');
  const meta = String(item.meta ?? '').toLowerCase();
  if (meta.includes('repository') || meta.includes('project') || meta === 'dir') {
    return true;
  }
  return Boolean(previewPath) && extensionOf(previewPath) === '' && !pathBaseName(previewPath).includes('.');
}

function isPreviewableItem(item: OpenClawResourceItem | null | undefined): boolean {
  if (!item) {
    return false;
  }
  return previewKindOfPath(item.openPath ?? item.path) !== null || isDirectoryPreviewItem(item);
}

function previewUrlForItem(item: OpenClawResourceItem): string {
  return `/api/openclaw/file?path=${encodeURIComponent(item.openPath ?? item.path)}`;
}

function previewNoteForPayload(payload: PreviewPayload): string {
  const kindLabel = payload.kind === 'image'
    ? (uiLocale === 'zh' ? '图片放大预览' : 'Image lightbox')
    : payload.kind === 'markdown'
      ? (uiLocale === 'zh' ? '简化 Markdown 渲染' : 'Simplified Markdown rendering')
      : payload.kind === 'json'
        ? 'JSON'
        : (uiLocale === 'zh' ? '文本预览' : 'Text preview');

  if (payload.truncated && payload.readMode === 'tail') {
    return uiLocale === 'zh'
      ? `${kindLabel} · 仅载入大文件最后一段`
      : `${kindLabel} · showing the latest slice of a large file`;
  }
  if (payload.truncated) {
    return uiLocale === 'zh'
      ? `${kindLabel} · 仅载入文件前一段`
      : `${kindLabel} · showing the first slice of a large file`;
  }
  return kindLabel;
}

function sanitizePreviewUrl(rawUrl: string): string | null {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function renderInlineMarkdown(raw: string): string {
  const tokens: string[] = [];
  const stash = (html: string): string => `__MD_TOKEN_${tokens.push(html) - 1}__`;

  let output = String(raw || '');
  output = output.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizePreviewUrl(url);
    if (!safeUrl) {
      return stash(`${escapeHtml(label)} (${escapeHtml(url)})`);
    }
    return stash(`<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
  });
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return output.replace(/__MD_TOKEN_(\d+)__/g, (_, tokenIndex) => tokens[Number(tokenIndex)] ?? '');
}

function renderMarkdownPreview(raw: string): string {
  const lines = String(raw || '').replaceAll('\r\n', '\n').split('\n');
  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  let listItems: Array<{ ordered: boolean; value: string }> = [];
  let quoteLines: string[] = [];
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
    paragraphLines = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }
    const ordered = listItems[0].ordered;
    const tag = ordered ? 'ol' : 'ul';
    blocks.push(`<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item.value)}</li>`).join('')}</${tag}>`);
    listItems = [];
  };

  const flushQuote = (): void => {
    if (quoteLines.length === 0) {
      return;
    }
    blocks.push(`<blockquote>${renderInlineMarkdown(quoteLines.join(' '))}</blockquote>`);
    quoteLines = [];
  };

  const flushCode = (): void => {
    if (codeLines.length === 0) {
      return;
    }
    blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushList();
        flushQuote();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^([-*_]){3,}$/.test(trimmed.replace(/\s+/g, ''))) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push('<hr />');
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      listItems.push({ ordered: false, value: unorderedMatch[1] });
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      listItems.push({ ordered: true, value: orderedMatch[1] });
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();
  if (inCodeBlock) {
    flushCode();
  }

  return blocks.join('');
}

function kindOrderForResource(resourceId: ResourcePartitionId): string[] {
  if (resourceId === 'images') {
    return ['Actor Art', 'Layer Assets', 'Layout Concepts', 'Project Art', 'Legacy References', 'Run Media', 'Images'];
  }
  if (resourceId === 'skills') {
    return ['Art & Image', 'Browser & Automation', 'Coding & Agent Ops', 'Content & Publishing', 'Finance', 'Utility Skills', 'Skills'];
  }
  if (resourceId === 'document') {
    return ['Task Docs', 'Reports', 'Plans', 'Readmes', 'Data Files', 'Documents'];
  }
  if (resourceId === 'memory') {
    return ['Daily Notes', 'Core Memory', 'Finance Memory', 'Memory Notes'];
  }
  if (resourceId === 'gateway') {
    return ['Queue Status', 'Runtime', 'Connections', 'Providers', 'Devices', 'Auth', 'Models', 'Config', 'MCP'];
  }
  if (resourceId === 'agent') {
    return ['Parallel Runs', 'Sessions', 'Subagent Runs', 'Task Status', 'Agent State'];
  }
  if (resourceId === 'mcp') {
    return ['Code Repositories', 'App Projects'];
  }
  if (resourceId === 'task_queues') {
    return ['Blocked Tasks', 'Paused Tasks', 'Pending Tasks', 'Running Tasks', 'Completed Tasks', 'Deliveries'];
  }
  if (resourceId === 'alarm') {
    return ['Blocked Tasks', 'Failed Deliveries'];
  }
  if (resourceId === 'break_room') {
    return ['Health', 'Maintenance', 'Recovery', 'Upgrade Watch'];
  }
  return [];
}

function statusText(status: OpenClawSnapshot['resources'][number]['status']): string {
  if (status === 'active') return uiText('active', uiLocale);
  if (status === 'alert') return uiText('alert', uiLocale);
  if (status === 'offline') return uiText('offline', uiLocale);
  return uiText('idle', uiLocale);
}

function itemKindGroupOf(resourceId: ResourcePartitionId, entry: OpenClawResourceItem): string {
  const pathValue = (entry.path || '').toLowerCase();
  const titleValue = (entry.title || '').toLowerCase();
  const metaValue = (entry.meta || '').toLowerCase();

  if (resourceId === 'document') {
    if (pathValue.includes('docs/tasks/') || titleValue.includes('todo-')) return 'Task Docs';
    if (titleValue.includes('readme')) return 'Readmes';
    if (titleValue.includes('report') || titleValue.includes('summary')) return 'Reports';
    if (titleValue.includes('plan') || titleValue.includes('proposal')) return 'Plans';
    if (metaValue === 'json' || metaValue === 'csv') return 'Data Files';
    return 'Documents';
  }

  if (resourceId === 'memory') {
    if (/\/\d{4}-\d{2}-\d{2}\.md$/i.test(pathValue) || /^\d{4}-\d{2}-\d{2}\.md$/i.test(pathValue)) return 'Daily Notes';
    if (titleValue === 'memory.md' || titleValue === 'user.md' || titleValue === 'soul.md') return 'Core Memory';
    if (titleValue.includes('finance')) return 'Finance Memory';
    return 'Memory Notes';
  }

  if (resourceId === 'images') {
    if (pathValue.includes('/actors/')) return 'Actor Art';
    if (pathValue.includes('cutout') || pathValue.includes('floor') || pathValue.includes('backwall') || pathValue.includes('midprops') || pathValue.includes('occluder')) return 'Layer Assets';
    if (pathValue.includes('ll3-master-layout')) return 'Layout Concepts';
    if (pathValue.includes('project/clawlibrary')) return 'Project Art';
    if (pathValue.includes('star-office')) return 'Legacy References';
    if (pathValue.includes('tmp/weibo-runs') || pathValue.includes('tmp/zsxq-runs')) return 'Run Media';
    return 'Images';
  }

  if (resourceId === 'skills') {
    const skillText = [pathValue, titleValue, (entry.excerpt || '').toLowerCase()].join(' ');
    if (/(nano|banana|sprite|image|pixel|illustrat|art|gif)/.test(skillText)) return 'Art & Image';
    if (/(playwright|browser|web|cua|scrap|crawl|automation)/.test(skillText)) return 'Browser & Automation';
    if (/(codex|agent|coding|orchestrator|task|runner|subagent)/.test(skillText)) return 'Coding & Agent Ops';
    if (/(weibo|wechat|article|blog|publish|news|media|forge)/.test(skillText)) return 'Content & Publishing';
    if (/(finance|futu|stock|holding|briefing|insight)/.test(skillText)) return 'Finance';
    if (pathValue.startsWith('.openclaw/skills/')) return 'Utility Skills';
    return 'Skills';
  }

  if (resourceId === 'agent') {
    if (metaValue.includes('subagent')) return 'Subagent Runs';
    if (metaValue.includes('session')) return 'Sessions';
    if (metaValue.includes('running') || metaValue.includes('active')) return 'Parallel Runs';
    if (metaValue.includes('blocked') || metaValue.includes('paused') || metaValue.includes('pending') || metaValue.includes('completed') || metaValue.includes('task')) return 'Task Status';
    return 'Agent State';
  }

  if (resourceId === 'gateway') {
    if (metaValue.includes('queue') || metaValue.includes('task') || metaValue.includes('delivery')) return 'Queue Status';
    if (metaValue.includes('runtime') || metaValue.includes('session') || metaValue.includes('run')) return 'Runtime';
    if (metaValue.includes('connection')) return 'Connections';
    if (metaValue.includes('provider')) return 'Providers';
    if (metaValue.includes('device')) return 'Devices';
    if (metaValue.includes('auth')) return 'Auth';
    if (metaValue.includes('model')) return 'Models';
    if (metaValue.includes('mcp')) return 'MCP';
    if (metaValue.includes('config')) return 'Config';
  }

  if (resourceId === 'mcp') {
    if (metaValue.includes('git') || metaValue.includes('repo')) return 'Code Repositories';
    return 'App Projects';
  }

  if (resourceId === 'task_queues') {
    if (metaValue === 'blocked') return 'Blocked Tasks';
    if (metaValue === 'paused') return 'Paused Tasks';
    if (metaValue === 'pending') return 'Pending Tasks';
    if (metaValue === 'running' || metaValue === 'active') return 'Running Tasks';
    if (metaValue === 'completed' || metaValue === 'done') return 'Completed Tasks';
    if (metaValue.includes('delivery')) return 'Deliveries';
  }

  if (resourceId === 'alarm') {
    if (metaValue.includes('failed delivery')) return 'Failed Deliveries';
    if (metaValue === 'blocked') return 'Blocked Tasks';
  }

  if (resourceId === 'break_room') {
    if (metaValue === 'health') return 'Health';
    if (metaValue === 'maintenance') return 'Maintenance';
    if (metaValue === 'recovery' || metaValue === 'idle fallback') return 'Recovery';
    if (metaValue === 'upgrade') return 'Upgrade Watch';
  }

  return titleCaseLabel(entry.meta?.trim() || 'Items');
}

function itemRawMetaLabel(entry: OpenClawResourceItem): string {
  const rawMeta = String(entry.meta ?? '').trim();
  if (!rawMeta) {
    return '';
  }
  if (uiLocale === 'zh') {
    const normalized = rawMeta.toLowerCase();
    if (normalized === 'blocked') return '阻塞';
    if (normalized === 'paused') return '已暂停';
    if (normalized === 'pending') return '待处理';
    if (normalized === 'running' || normalized === 'active') return '运行中';
    if (normalized === 'completed' || normalized === 'done') return '已完成';
    if (normalized === 'queue overview') return '队列概览';
    if (normalized === 'failed delivery') return '失败投递';
    if (normalized === 'health') return '系统状态';
    if (normalized === 'maintenance') return '维护';
    if (normalized === 'recovery') return '恢复';
    if (normalized === 'upgrade') return '升级';
  }
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'md', 'json', 'txt', 'csv', 'pdf']
    .includes(rawMeta.toLowerCase())
    ? rawMeta.toUpperCase()
    : titleCaseLabel(rawMeta);
}

function humanizeTelemetryText(text: string | null | undefined): string {
  const raw = String(text ?? '');
  if (uiLocale !== 'zh' || !raw) {
    return raw;
  }

  return raw
    .replace(/^Paused Task · /, '已暂停任务 · ')
    .replace(/^Blocked Task · /, '阻塞任务 · ')
    .replace(/^Pending Task · /, '待处理任务 · ')
    .replace(/^Running Task · /, '运行中任务 · ')
    .replace(/^Completed Task · /, '已完成任务 · ')
    .replace(/^Parallel Runs$/, '并行运行概览')
    .replace(/^Queue Overview$/, '队列概览')
    .replace(/^System Health$/, '系统状态')
    .replace(/^Maintenance Board$/, '维护看板')
    .replace(/(\d+)\s+blocked tasks?\s+need routing/g, '$1 个阻塞任务待继续处理')
    .replace(/(\d+)\s+blocked tasks?/g, '$1 个阻塞任务')
    .replace(/(\d+)\s+paused tasks?/g, '$1 个已暂停任务')
    .replace(/(\d+)\s+pending/g, '$1 个待处理')
    .replace(/(\d+)\s+running/g, '$1 个运行中')
    .replace(/(\d+)\s+completed/g, '$1 个已完成')
    .replace(/(\d+)\s+failed deliveries/g, '$1 个失败投递')
    .replace(/(\d+)\s+deliveries/g, '$1 个投递项')
    .replace(/(\d+)\s+queue tasks?/g, '$1 个队列任务')
    .replace(/(\d+)\s+tasks?\s+currently running/g, '$1 个任务正在运行')
    .replace(/Paused by user request/gi, '已按用户要求暂停')
    .replace(/failed deliveries or blocked tasks present/gi, '存在投递失败或阻塞任务')
    .replace(/^latest\s+/i, '最新 ');
}

function resourceSummaryEntries(resource: OpenClawSnapshot['resources'][number]): Array<{ id: string; label: string; value: string; color: string }> {
  const groups = kindGroupsOf(resource.id, resource.items ?? []);
  const accent = PARTITION_CSS_COLORS[resource.id] ?? '#7cf0d0';

  const summaryColor = (groupId: string): string => {
    if (resource.id === 'agent') {
      return modalAccentColorForItem(resource.id, {
        id: groupId,
        title: groupId,
        path: '',
        updatedAt: resource.lastAccessAt,
        meta: groupId,
        excerpt: ''
      });
    }
    if (resource.id === 'gateway') {
      return groupId === 'Queue Status' ? '#ffcf63'
        : groupId === 'Runtime' ? '#64d7b0'
        : groupId === 'MCP' ? '#d49cff'
        : '#8ecbff';
    }
    if (resource.id === 'mcp') {
      return groupId === 'Code Repositories' ? '#7cf0d0' : '#ffd27f';
    }
    return accent;
  };

  if (resource.id === 'agent') {
    return groups.slice(0, 4).map((group) => ({
      id: group.id,
      label: kindMenuLabelForResource(resource.id, group.id),
      value: String(group.count),
      color: summaryColor(group.id)
    }));
  }

  if (resource.id === 'gateway' || resource.id === 'mcp') {
    return groups.slice(0, 4).map((group) => ({
      id: group.id,
      label: kindMenuLabelForResource(resource.id, group.id),
      value: String(group.count),
      color: summaryColor(group.id)
    }));
  }

  return groups.slice(0, 4).map((group) => ({
    id: group.id,
    label: kindMenuLabelForResource(resource.id, group.id),
    value: String(group.count),
    color: accent
  }));
}

function resourceUsesStickySummary(resourceId: ResourcePartitionId): boolean {
  return resourceId === 'agent' || resourceId === 'gateway' || resourceId === 'mcp';
}

function kindGroupsOf(resourceId: ResourcePartitionId, items: OpenClawResourceItem[]): Array<{ id: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of items) {
    const kind = itemKindGroupOf(resourceId, entry);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }

  const preferredOrder = kindOrderForResource(resourceId);
  const preferredIndex = new Map(preferredOrder.map((kind, index) => [kind, index]));

  return [...counts.entries()]
    .map(([id, count]) => ({
      id,
      label: `${id} (${count})`,
      count
    }))
    .sort((left, right) => {
      const leftIndex = preferredIndex.get(left.id);
      const rightIndex = preferredIndex.get(right.id);
      const leftHasOrder = leftIndex !== undefined;
      const rightHasOrder = rightIndex !== undefined;

      if (leftHasOrder && rightHasOrder && leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      if (leftHasOrder !== rightHasOrder) {
        return leftHasOrder ? -1 : 1;
      }
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.id.localeCompare(right.id);
    });
}

function filterItems(resourceId: ResourcePartitionId, items: OpenClawResourceItem[]): OpenClawResourceItem[] {
  const terms = searchTermsOf(modalSearchQuery);
  return items.filter((entry) => {
    const kindGroup = itemKindGroupOf(resourceId, entry);
    const matchesKind = modalKindFilter === 'all' || kindGroup === modalKindFilter;
    if (!matchesKind) {
      return false;
    }

    if (terms.length === 0) {
      return true;
    }

    const haystack = [
      entry.title,
      entry.path,
      entry.meta,
      entry.excerpt,
      kindGroup
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function formatSize(sizeBytes?: number): string {
  const size = sizeBytes ?? 0;
  if (size <= 0) {
    return 'size n/a';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function minutesSince(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  return Math.max(0, (Date.now() - time) / 60000);
}

function modalAccentColorForItem(resourceId: ResourcePartitionId, entry: OpenClawResourceItem): string {
  const meta = String(entry.meta ?? '').toLowerCase();
  if (resourceId === 'agent') {
    if (meta.includes('blocked') || meta.includes('error')) return '#ff7b7b';
    if (meta.includes('running') || meta.includes('active')) return '#64d7b0';
    if (meta.includes('pending')) return '#ffcf63';
    if (meta.includes('completed') || meta.includes('done')) return '#8dd7ff';
    if (meta.includes('subagent')) return '#d49cff';
    if (meta.includes('session')) {
      const minutes = minutesSince(entry.updatedAt);
      if (minutes !== null && minutes < 15) return '#7cf0d0';
      if (minutes !== null && minutes < 60) return '#8ecbff';
      return '#93a8c3';
    }
    return '#7cf0d0';
  }

  if (resourceId === 'mcp') {
    if (meta.includes('git')) return '#7cf0d0';
    if (meta.includes('runnable')) return '#ffcf63';
  }

  return PARTITION_CSS_COLORS[resourceId] ?? '#7cf0d0';
}

function modalPillTone(resourceId: ResourcePartitionId, label: string): string {
  const normalized = label.toLowerCase();
  if (resourceId === 'agent') {
    if (normalized.includes('parallel') || normalized.includes('running') || normalized.includes('active')) return 'active';
    if (normalized.includes('session')) return 'cool';
    if (normalized.includes('subagent')) return 'violet';
    if (normalized.includes('blocked') || normalized.includes('error')) return 'danger';
    if (normalized.includes('paused')) return 'cool';
    if (normalized.includes('pending')) return 'warm';
    if (normalized.includes('completed') || normalized.includes('done')) return 'calm';
  }
  if (resourceId === 'gateway') {
    if (normalized.includes('queue')) return 'warm';
    if (normalized.includes('runtime')) return 'active';
    if (normalized.includes('config') || normalized.includes('auth') || normalized.includes('models')) return 'cool';
    if (normalized.includes('mcp')) return 'violet';
  }
  if (resourceId === 'mcp') {
    if (normalized.includes('repository') || normalized.includes('git')) return 'active';
    if (normalized.includes('runnable') || normalized.includes('project')) return 'warm';
  }
  if (normalized === 'hot') return 'active';
  if (normalized === 'recent') return 'cool';
  if (normalized === 'today') return 'calm';
  if (normalized === 'older') return 'muted';
  if (normalized === 'paused') return 'cool';
  return 'neutral';
}

function modalStatTone(resourceId: ResourcePartitionId, tone: string | null | undefined): string {
  if (tone) {
    return tone;
  }
  if (resourceId === 'agent') return 'active';
  if (resourceId === 'gateway') return 'cool';
  if (resourceId === 'mcp') return 'warm';
  return 'neutral';
}

function numericStatSegments(entry: OpenClawResourceItem): Array<{ label: string; value: number; tone: string | null | undefined }> {
  const rows: Array<{ label: string; value: number; tone: string | null | undefined } | null> = (entry.stats ?? [])
    .map((stat) => {
      const parsed = Number(stat.value);
      return Number.isFinite(parsed)
        ? { label: stat.label, value: parsed, tone: stat.tone }
        : null;
    });
  return rows.filter((stat): stat is { label: string; value: number; tone: string | null | undefined } => stat !== null);
}

function statusLabelOf(status: OpenClawSnapshot['resources'][number]['status']): string {
  return statusText(status);
}

function dateTimeOf(value: string | null | undefined): string {
  if (!value) {
    return 'n/a';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function setModalFeedback(message: string, tone: 'info' | 'error' = 'info'): void {
  if (!assetModalFeedback) {
    return;
  }
  assetModalFeedback.textContent = message;
  assetModalFeedback.classList.toggle('error', tone === 'error');
  if (modalFeedbackTimer !== null) {
    window.clearTimeout(modalFeedbackTimer);
  }
  modalFeedbackTimer = window.setTimeout(() => {
    if (assetModalFeedback) {
      assetModalFeedback.textContent = '';
      assetModalFeedback.classList.remove('error');
    }
    modalFeedbackTimer = null;
  }, 2200);
}

function recentEventsForResource(resourceId: ResourcePartitionId, limit = 3) {
  const targetIds = resourceId === 'gateway'
    ? new Set<ResourcePartitionId>(['gateway', 'task_queues'])
    : new Set<ResourcePartitionId>([resourceId]);
  return (lastSnapshot?.recentEvents ?? [])
    ?.filter((event) => targetIds.has(event.resourceId))
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, limit);
}

function renderResourceContext(
  resource: OpenClawSnapshot['resources'][number],
  _topItem: OpenClawResourceItem | null
): string {
  const focus = lastSnapshot?.focus;
  const focusText = focus && uiResourceId(focus.resourceId) === resource.id
    ? `${focus.reason} · ${humanizeTelemetryText(focus.detail)}`
    : (uiLocale === 'zh' ? '当前不是焦点资源' : 'Not current focus');
  const contextCard = (label: string, value: string) => `
    <div class="modal-context-card" title="${escapeHtml(value)}">
      <div class="modal-context-label">${label}</div>
      <div class="modal-context-value">${escapeHtml(value)}</div>
    </div>
  `;

  return [
    `<div class="modal-context-card"><div class="modal-context-label">Status</div><div class="modal-context-value"><span class="status-badge ${escapeHtml(resource.status)}">${escapeHtml(statusLabelOf(resource.status))}</span></div></div>`,
    contextCard('Source', resource.source),
    contextCard('Signal', humanizeTelemetryText(resource.detail)),
    contextCard('Focus', focusText)
  ].join('');
}

function contextSummaryForResource(
  resource: OpenClawSnapshot['resources'][number],
  topItem: OpenClawResourceItem | null,
  options: {
    displayedCount: number;
    filteredCount: number;
    totalCount: number;
    visibleItems: OpenClawResourceItem[];
    kindFilter: string;
    searchQuery: string;
    sortMode: ModalSortMode;
    viewMode: ModalViewMode;
  }
): string {
  const focus = lastSnapshot?.focus;
  const focusText = focus && uiResourceId(focus.resourceId) === resource.id
    ? `${focus.reason} · ${humanizeTelemetryText(focus.detail)}`
    : (uiLocale === 'zh' ? '当前不是焦点资源' : 'Not current focus');
  const recentEvents = recentEventsForResource(resource.id, 3);
  const lines = [
    `${resource.label}`,
    `Status: ${statusLabelOf(resource.status)}`,
    `Items: ${resource.itemCount}`,
    `Showing: ${options.displayedCount} of ${options.filteredCount} filtered (${options.totalCount} total loaded)`,
    `Summary: ${humanizeTelemetryText(resource.summary)}`,
    `Signal: ${humanizeTelemetryText(resource.detail)}`,
    `Source: ${resource.source}`,
    `Focus: ${focusText}`,
    `Last access: ${dateTimeOf(resource.lastAccessAt)}`,
    `Sort: ${options.sortMode}`,
    `View: ${options.viewMode}`,
    `Kind filter: ${options.kindFilter === 'all' ? 'all' : options.kindFilter}`,
    `Search: ${options.searchQuery.trim() || 'none'}`
  ];

  if (topItem) {
    lines.push(`Top item: ${humanizeTelemetryText(topItem.title)}`);
    lines.push(`Top path: ${topItem.path}`);
  }

  if (recentEvents.length > 0) {
    lines.push('Recent events:');
    for (const event of recentEvents) {
      lines.push(`- ${resourceLabel(uiResourceId(event.resourceId), uiLocale)} · ${humanizeTelemetryText(event.detail)} · ${dateTimeOf(event.occurredAt)}`);
    }
  }

  if (options.visibleItems.length > 0) {
    lines.push('Visible items:');
    for (const item of options.visibleItems.slice(0, 5)) {
      lines.push(`- ${humanizeTelemetryText(item.title)} · ${item.path}`);
    }
  }

  return lines.join('\n');
}

function controlLabelFor(resourceId: ResourcePartitionId): string {
  return resourceLabel(uiResourceId(resourceId), uiLocale);
}

function shortcutForResource(resourceId: ResourcePartitionId): string {
  if (resourceId === 'images') return 'I';
  if (resourceId === 'skills') return 'S';
  if (resourceId === 'document') return 'D';
  if (resourceId === 'alarm') return 'A';
  if (resourceId === 'gateway') return 'Q';
  if (resourceId === 'log') return 'L';
  if (resourceId === 'break_room') return 'B';
  return '';
}

function controlTooltipFor(
  resource: OpenClawSnapshot['resources'][number],
  isFocus: boolean,
  topItem: OpenClawResourceItem | null
): string {
  const shortcut = shortcutForResource(resource.id);
  const lines = [
    `${controlLabelFor(resource.id)} · ${statusLabelOf(resource.status)}`,
    shortcut ? `Shortcut: ${shortcut}` : '',
    `${resource.itemCount} items`,
    humanizeTelemetryText(resource.summary),
    humanizeTelemetryText(resource.detail),
    `Last access: ${dateTimeOf(resource.lastAccessAt)}`
  ];

  if (topItem) {
    lines.push(`Top item: ${humanizeTelemetryText(topItem.title)}`);
  }

  if (isFocus && lastSnapshot?.focus) {
    lines.push(`Focus: ${lastSnapshot.focus.reason}`);
  }

  return lines.filter(Boolean).join('\n');
}

function controlDetailFor(resource: OpenClawSnapshot['resources'][number] | undefined): string {
  if (!resource) {
    return `${uiText('waiting', uiLocale)} · --:--`;
  }
  return `${statusLabelOf(resource.status)} · ${clockOf(resource.lastAccessAt)}`;
}

function primarySourcePathOf(source: string | null | undefined): string {
  return String(source ?? '')
    .split('+')
    .map((entry) => entry.trim())
    .find(Boolean) ?? '';
}

function pathBaseName(pathValue: string | null | undefined): string {
  const normalized = String(pathValue ?? '').trim().replace(/\/+$/g, '');
  if (!normalized) {
    return '';
  }
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function normalizeComparablePath(pathValue: string | null | undefined): string {
  return String(pathValue ?? '')
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function pathsLikelyMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`)) {
    return true;
  }
  return pathBaseName(normalizedLeft) === pathBaseName(normalizedRight);
}

function itemForSourcePath(resourceId: ResourcePartitionId, sourcePath: string): OpenClawResourceItem | null {
  const resource = resourceForUi(resourceId);
  if (!resource?.items?.length) {
    return null;
  }
  return resource.items.find((item) =>
    pathsLikelyMatch(item.path, sourcePath)
    || pathsLikelyMatch(item.openPath, sourcePath)
  ) ?? null;
}

function pathHintFromDetail(detail: string): string {
  const match = String(detail || '').match(/([./\w-]+\.[A-Za-z0-9]+)/);
  if (!match) {
    return '';
  }
  return match[1] ?? '';
}

function groupedRecentActivity(limitGroups = 6, eventsPerGroup = 4): RecentActivityGroup[] {
  const grouped = new Map<ResourcePartitionId, OpenClawSnapshot['recentEvents']>();
  const events = [...(lastSnapshot?.recentEvents ?? [])]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());

  for (const event of events) {
    const resourceId = uiResourceId(event.resourceId);
    const bucket = grouped.get(resourceId) ?? [];
    const groupLimit = resourceId === 'gateway' ? 1 : eventsPerGroup;
    if (bucket.length >= groupLimit) {
      continue;
    }
    bucket.push(event);
    grouped.set(resourceId, bucket);
  }

  return [...grouped.entries()]
    .map(([resourceId, resourceEvents]) => ({
      resourceId,
      label: resourceLabel(resourceId, uiLocale),
      events: resourceEvents,
      latestAt: resourceEvents[0]?.occurredAt ?? ''
    }))
    .sort((left, right) => new Date(right.latestAt).getTime() - new Date(left.latestAt).getTime())
    .slice(0, limitGroups);
}

function renderHudStats(): void {
  if (!hudStats) {
    return;
  }

  const resources = lastSnapshot?.resources ?? [];
  const totalAssets = resources.reduce((sum, resource) => sum + resource.itemCount, 0);
  const liveRooms = resources.filter((resource) => resource.status === 'active' || resource.status === 'alert').length;
  const eventsCount = lastSnapshot?.recentEvents.length ?? 0;

  hudStats.innerHTML = [
    { value: totalAssets, label: uiText('statsAssets', uiLocale) },
    { value: liveRooms, label: uiText('statsLive', uiLocale) },
    { value: eventsCount, label: uiText('statsEvents', uiLocale) }
  ].map((stat) => `
    <div class="hud-stat">
      <span class="hud-stat-value">${escapeHtml(String(stat.value))}</span>
      <span class="hud-stat-label">${escapeHtml(stat.label)}</span>
    </div>
  `).join('');
}

function renderActorLiveStatus(): void {
  if (!hudActorStatus) {
    return;
  }

  const activeScene = getActiveScene();
  const status = activeScene?.getWorkStatus();
  const focus = lastSnapshot?.focus;
  if (!status || !focus) {
    hudActorStatus.innerHTML = `
      <strong>${escapeHtml(uiLocale === 'zh' ? '角色状态 · 等待中' : 'Actor · Waiting')}</strong>
      <span>${escapeHtml(uiLocale === 'zh' ? '正在等待实时状态同步。' : 'Waiting for live status.')}</span>
    `;
    return;
  }

  const zoneLabel = status.zone ?? resourceLabel(uiResourceId(focus.resourceId), uiLocale);
  const headline = status.mode === 'moving'
    ? (uiLocale === 'zh' ? `正在前往 ${zoneLabel}` : `Moving to ${zoneLabel}`)
    : status.mode === 'working'
      ? (uiLocale === 'zh' ? `正在处理 ${zoneLabel}` : `Working in ${zoneLabel}`)
      : focus.resourceId === 'break_room'
        ? (uiLocale === 'zh' ? '正在休息室休息' : 'Resting in Break Room')
        : (uiLocale === 'zh' ? `停留在 ${zoneLabel}` : `Holding at ${zoneLabel}`);
  const reasonLabel = uiLocale === 'zh' ? '原因' : 'Reason';
  const detail = humanizeTelemetryText(status.detail || focus.detail || '');

  hudActorStatus.innerHTML = `
    <strong>${escapeHtml(headline)}</strong>
    <span>${escapeHtml(`${reasonLabel} · ${detail}`)}</span>
  `;
}

function renderRecentActivity(): void {
  if (!hudActivityItems) {
    return;
  }
  const groups = groupedRecentActivity();
  if (groups.length === 0) {
    hudActivityItems.innerHTML = `<div class="hud-activity-item"><span>${escapeHtml(uiText('noActivity', uiLocale))}</span></div>`;
    return;
  }

  if (selectedActivityGroupId && !groups.some((group) => group.resourceId === selectedActivityGroupId)) {
    selectedActivityGroupId = null;
  }

  hudActivityItems.innerHTML = groups.map((group) => {
    const isOpen = group.resourceId === selectedActivityGroupId;
    const latestEvent = group.events[0];
    if (!latestEvent) {
      return '';
    }
    if (group.events.length === 1) {
      return `
        <section class="hud-activity-group" data-open="false">
          <button
            class="hud-activity-group-toggle"
            type="button"
            data-activity-resource-id="${escapeHtml(group.resourceId)}"
            data-activity-source="${escapeHtml(primarySourcePathOf(latestEvent.source))}"
            data-activity-detail="${escapeHtml(latestEvent.detail)}"
          >
            <strong style="color:${escapeHtml(PARTITION_CSS_COLORS[group.resourceId])}">${escapeHtml(group.label)}</strong>
            <span>${escapeHtml(humanizeTelemetryText(latestEvent.detail))} · ${escapeHtml(clockOf(group.latestAt))}</span>
          </button>
        </section>
      `;
    }
    return `
      <section class="hud-activity-group" ${isOpen ? 'data-open="true"' : ''}>
        <button
          class="hud-activity-group-toggle"
          type="button"
          data-activity-group-id="${escapeHtml(group.resourceId)}"
        >
          <strong style="color:${escapeHtml(PARTITION_CSS_COLORS[group.resourceId])}">${escapeHtml(group.label)}</strong>
          <span>${escapeHtml(humanizeTelemetryText(latestEvent?.detail ?? ''))} · ${escapeHtml(clockOf(group.latestAt))} · ${escapeHtml(String(group.events.length))}</span>
        </button>
        ${isOpen ? `
          <div class="hud-activity-group-items">
            ${group.events.map((event) => `
              <button
                class="hud-activity-item"
                type="button"
                data-activity-resource-id="${escapeHtml(group.resourceId)}"
                data-activity-source="${escapeHtml(primarySourcePathOf(event.source))}"
                data-activity-detail="${escapeHtml(event.detail)}"
              >
                <strong style="color:${escapeHtml(PARTITION_CSS_COLORS[group.resourceId])}">${escapeHtml(clockOf(event.occurredAt))}</strong>
                <span>${escapeHtml(humanizeTelemetryText(event.detail))}</span>
              </button>
            `).join('')}
          </div>
        ` : ''}
      </section>
    `;
  }).join('');
}

function syncInfoTogglePosition(): void {
  if (!toggleInfoPanelButton) {
    return;
  }
  // If Chat panel is active, hide the Info toggle entirely — no overlap
  const chatActive = localStorage.getItem('clawlibrary-chat-visible') === '1';
  if (chatActive) {
    toggleInfoPanelButton.style.visibility = 'hidden';
    return;
  }
  toggleInfoPanelButton.style.visibility = '';
  if (!infoPanelVisible) {
    toggleInfoPanelButton.style.bottom = '18px';
    return;
  }
  const hud = document.getElementById('hud-activity');
  if (!hud) {
    toggleInfoPanelButton.style.bottom = '18px';
    return;
  }
  const rect = hud.getBoundingClientRect();
  const gap = window.innerWidth <= 700 ? 10 : 12;
  const bottom = Math.max(18, Math.round(window.innerHeight - rect.top + gap));
  toggleInfoPanelButton.style.bottom = `${bottom}px`;
}

function applyInfoPanelVisibility(): void {
  document.body.classList.toggle('info-collapsed', !infoPanelVisible);
  if (toggleInfoPanelButton) {
    toggleInfoPanelButton.hidden = !appConfig.ui.showInfoToggle;
    toggleInfoPanelButton.textContent = infoPanelVisible ? uiText('hideInfo', uiLocale) : uiText('showInfo', uiLocale);
    toggleInfoPanelButton.setAttribute('aria-pressed', infoPanelVisible ? 'true' : 'false');
  }
  syncInfoTogglePosition();
}

function formatDebugPoint(point: DebugPoint): string {
  if (point.clientX === null || point.clientY === null) {
    return '--';
  }
  return `${point.clientX}, ${point.clientY}`;
}

function formatSceneDebugPoint(point: DebugPoint): string {
  if (point.sceneX === null || point.sceneY === null) {
    return '--';
  }
  return `${point.sceneX}, ${point.sceneY}`;
}

function renderDebugOverlay(): void {
  if (!debugOverlay) {
    return;
  }
  debugOverlay.classList.toggle('hidden', !debugPanelVisible);
  debugOverlay.setAttribute('aria-hidden', debugPanelVisible ? 'false' : 'true');
  if (!debugPanelVisible) {
    return;
  }
  const stageState = debugPointer.insideStage ? uiText('stageInside', uiLocale) : uiText('stageOutside', uiLocale);
  debugOverlay.innerHTML = `
    <div class="debug-overlay-head">${escapeHtml(uiText('debug', uiLocale))}</div>
    <div class="debug-overlay-sub">${escapeHtml(stageState)}</div>
    <div class="debug-overlay-grid">
      <div class="debug-overlay-label">${escapeHtml(uiText('client', uiLocale))}</div>
      <div class="debug-overlay-value">${escapeHtml(formatDebugPoint(debugPointer))}</div>
      <div class="debug-overlay-label">${escapeHtml(uiText('scene', uiLocale))}</div>
      <div class="debug-overlay-value">${escapeHtml(formatSceneDebugPoint(debugPointer))}</div>
      <div class="debug-overlay-label">${escapeHtml(uiText('lastClick', uiLocale))}</div>
      <div class="debug-overlay-value">${escapeHtml(formatSceneDebugPoint(debugLastClick))}</div>
      <div class="debug-overlay-label">${escapeHtml(uiText('clickClient', uiLocale))}</div>
      <div class="debug-overlay-value">${escapeHtml(formatDebugPoint(debugLastClick))}</div>
    </div>
  `;
}

function applyDebugPanelVisibility(): void {
  if (toggleDebugButton) {
    toggleDebugButton.hidden = !appConfig.ui.showDebugToggle;
    toggleDebugButton.textContent = uiText('debug', uiLocale);
    toggleDebugButton.setAttribute('aria-pressed', debugPanelVisible ? 'true' : 'false');
    toggleDebugButton.dataset.active = debugPanelVisible ? 'true' : 'false';
  }
  getActiveScene()?.setDebugVisualsVisible(debugPanelVisible);
  renderDebugOverlay();
}

function refreshDebugPointerProjection(): void {
  if (debugPointer.clientX !== null && debugPointer.clientY !== null) {
    debugPointer = scenePointFromClientPoint({ x: debugPointer.clientX, y: debugPointer.clientY });
  }
  if (debugLastClick.clientX !== null && debugLastClick.clientY !== null) {
    debugLastClick = scenePointFromClientPoint({ x: debugLastClick.clientX, y: debugLastClick.clientY });
  }
  renderDebugOverlay();
}

function applyLocaleToChrome(): void {
  document.body.dataset.uiLocale = uiLocale;
  if (hudTitleMain) {
    hudTitleMain.textContent = uiText('title', uiLocale);
  }
  if (hudTitleSub) {
    hudTitleSub.textContent = uiLocale === 'zh'
      ? '面向 OpenClaw 生成资产与运行流的像素游戏风档案馆。'
      : "A pixel-game archive for OpenClaw's generated assets and runtime flows.";
  }
  if (hudActivityTitle) {
    hudActivityTitle.textContent = uiText('recentActivity', uiLocale);
  }
  if (menuPanelStamp) {
    menuPanelStamp.textContent = uiText('archiveLive', uiLocale);
  }
  if (menuPanelSub) {
    menuPanelSub.textContent = uiText('quickRooms', uiLocale);
  }
  if (toggleLocaleButton) {
    toggleLocaleButton.textContent = uiLocale === 'zh' ? '中 / EN' : 'EN / 中';
  }
  applyDebugPanelVisibility();
  if (assetModalCopyContext) {
    assetModalCopyContext.textContent = uiText('copyContext', uiLocale);
  }
  if (assetModalClose) {
    assetModalClose.textContent = uiText('close', uiLocale);
  }
  if (assetModalView) {
    assetModalView.textContent = modalViewMode === 'list' ? uiText('grid', uiLocale) : uiText('list', uiLocale);
  }
  if (cycleThemeButton) {
    cycleThemeButton.hidden = !appConfig.ui.showThemeToggle;
  }
  updateActorSkinButtonLabel();
  if (assetModalSearch && selectedResourceId) {
    assetModalSearch.placeholder = searchPlaceholderForResource(selectedResourceId);
  }
  if (previewModalFolder) {
    previewModalFolder.textContent = uiText('openFolder', uiLocale);
  }
  if (previewModalClose) {
    previewModalClose.textContent = uiText('close', uiLocale);
  }
  applyInfoPanelVisibility();
  renderHudStats();
  renderRecentActivity();
  renderPreviewModal();
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function searchPlaceholderForResource(resourceId: ResourcePartitionId): string {
  if (uiLocale === 'zh') {
    if (resourceId === 'images') return '搜索角色、房间图层、布局…';
    if (resourceId === 'skills') return '搜索技能、能力、流程…';
    if (resourceId === 'document') return '搜索任务、报告、计划…';
    if (resourceId === 'memory') return '搜索笔记、主题、日期…';
    if (resourceId === 'log') return '搜索错误、超时、ws…';
    if (resourceId === 'alarm') return '搜索失败、阻塞任务…';
    if (resourceId === 'task_queues') return '搜索任务、队列、投递…';
    if (resourceId === 'agent') return '搜索代码仓库、git、项目…';
    if (resourceId === 'gateway') return '搜索接口、连接、队列、设备…';
    if (resourceId === 'mcp') return '搜索代码库、项目、README…';
    if (resourceId === 'break_room') return '搜索健康、维护、升级…';
    return '搜索条目…';
  }
  if (resourceId === 'images') return 'Search actor, room layer, layout…';
  if (resourceId === 'skills') return 'Search skill, capability, workflow…';
  if (resourceId === 'document') return 'Search task, report, plan…';
  if (resourceId === 'memory') return 'Search note, topic, date…';
  if (resourceId === 'log') return 'Search error, timeout, ws…';
  if (resourceId === 'alarm') return 'Search failure, blocked task…';
  if (resourceId === 'task_queues') return 'Search task, queue, delivery…';
  if (resourceId === 'agent') return 'Search repository, git, project…';
  if (resourceId === 'gateway') return 'Search interface, queue, device…';
  if (resourceId === 'mcp') return 'Search code repo, project, README…';
  if (resourceId === 'break_room') return 'Search health, maintenance, upgrade…';
  return 'Search items…';
}

async function copySelectedResourceContext(): Promise<void> {
  const resource = getSelectedResource();
  if (!resource) {
    return;
  }
  const filteredItems = sortItems(filterItems(resource.id, resource.items ?? []));
  const items = filteredItems.slice(0, 48);
  try {
    await navigator.clipboard.writeText(contextSummaryForResource(resource, items[0] ?? null, {
      displayedCount: items.length,
      filteredCount: filteredItems.length,
      totalCount: resource.items?.length ?? 0,
      visibleItems: items,
      kindFilter: modalKindFilter,
      searchQuery: modalSearchQuery,
      sortMode: modalSortMode,
      viewMode: modalViewMode
    }));
    setModalFeedback(`Copied context · ${resource.label}`);
  } catch (error) {
    setModalFeedback(`Copy context failed · ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function syncResourceControls(): void {
  const resources = resourcesForUi();
  const resourceMap = new Map(resources.map((resource) => [resource.id, resource] as const));
  const focusResourceId = lastSnapshot?.focus.resourceId ? uiResourceId(lastSnapshot.focus.resourceId) : null;
  if (!resourceMenu) {
    renderHudStats();
    renderActorLiveStatus();
    renderRecentActivity();
    syncInfoTogglePosition();
    return;
  }

  resourceMenu.innerHTML = MENU_RESOURCE_IDS.map((resourceId) => {
    const resource = resourceMap.get(resourceId);
    const isFocus = focusResourceId === resourceId;
    const isSelected = selectedResourceId === resourceId && (modalVisible || categoryMenuVisible);
    const topItem = resource?.items?.[0] ?? null;
    const tooltip = resource
      ? controlTooltipFor(resource, isFocus, topItem)
      : `${controlLabelFor(resourceId)} · ${uiText('waiting', uiLocale)}`;

    return `
      <button
        type="button"
        data-resource-id="${escapeHtml(resourceId)}"
        style="--accent-color:${escapeHtml(PARTITION_CSS_COLORS[resourceId])}"
        ${resource ? `data-status="${escapeHtml(resource.status)}"` : ''}
        ${isFocus ? 'data-focus="true"' : ''}
        ${isSelected ? 'data-selected="true"' : ''}
        ${resource ? '' : 'disabled'}
        title="${escapeHtml(tooltip)}"
        aria-label="${escapeHtml(tooltip)}"
        aria-pressed="${isSelected ? 'true' : 'false'}"
      >
        <span class="resource-menu-main">
          <span class="resource-menu-name">${escapeHtml(controlLabelFor(resourceId))}</span>
          <span class="resource-menu-detail">${escapeHtml(controlDetailFor(resource))}</span>
        </span>
        <span class="resource-menu-count">${escapeHtml(resource ? String(resource.itemCount) : '--')}</span>
      </button>
    `;
  }).join('');

  renderHudStats();
  renderActorLiveStatus();
  renderRecentActivity();
  syncInfoTogglePosition();
}

function getActiveScene(): LibraryScene | null {
  if (!game.scene.isActive('LibraryScene')) {
    return null;
  }
  return game.scene.getScene('LibraryScene') as LibraryScene;
}

function resetModalFilters(): void {
  modalKindFilter = 'all';
  modalSearchQuery = '';
  if (assetModalKind) {
    assetModalKind.value = 'all';
  }
  if (assetModalSearch) {
    assetModalSearch.value = '';
  }
}

function applyModalDefaultsForResource(resourceId: ResourcePartitionId): void {
  const defaults = modalDefaultsForResource(resourceId);
  const saved = modalPrefsByResource[resourceId];
  modalSortMode = saved?.sortMode ?? defaults.sortMode;
  modalViewMode = saved?.viewMode ?? defaults.viewMode;
  if (assetModalSort) {
    assetModalSort.value = modalSortMode;
  }
}

function rememberModalPreferenceForSelectedResource(): void {
  if (!selectedResourceId) {
    return;
  }
  modalPrefsByResource[selectedResourceId] = {
    sortMode: modalSortMode,
    viewMode: modalViewMode
  };
  saveModalPrefs();
}

function openResourceModal(
  resourceId: ResourcePartitionId,
  options?: {
    anchor?: MenuAnchor | null;
    forceModal?: boolean;
    kindId?: string;
    searchQuery?: string;
  }
): void {
  resourceId = uiResourceId(resourceId);
  closePreviewModal();
  if (resourceUsesExternalKindMenu(resourceId) && !options?.forceModal) {
    void openResourceKindMenu(resourceId, options?.anchor ?? null);
    return;
  }
  closeCategoryMenu();
  if (selectedResourceId !== resourceId) {
    resetModalFilters();
    applyModalDefaultsForResource(resourceId);
  }
  selectedResourceId = resourceId;
  if (options?.kindId) {
    modalKindFilter = options.kindId;
    if (assetModalKind) {
      assetModalKind.value = options.kindId;
    }
  }
  if (typeof options?.searchQuery === 'string') {
    modalSearchQuery = options.searchQuery;
    if (assetModalSearch) {
      assetModalSearch.value = options.searchQuery;
    }
  }
  modalVisible = true;
  void ensureResourceDetail(resourceId)
    .then(() => {
      if (selectedResourceId === resourceId && modalVisible) {
        renderRoomModal();
      }
    })
    .catch(() => {
      renderRoomModal();
    });
  syncResourceControls();
  renderRoomModal();
}

function ensureSceneBindings(): void {
  const activeScene = getActiveScene();
  if (!activeScene) {
    return;
  }

  activeScene.setLocale(uiLocale);
  activeScene.setDebugVisualsVisible(debugPanelVisible);
  if (actorVariantId && activeScene.getActorVariantId() !== actorVariantId) {
    activeScene.setActorVariant(actorVariantId);
  }
  actorVariantId = activeScene.getActorVariantId() ?? actorVariantId;
  updateActorSkinButtonLabel();

  if (sceneEventsBound) {
    return;
  }

  activeScene.events.on('select-resource', (event: string | ResourceSelectEvent) => {
    const payload = typeof event === 'string'
      ? { resourceId: event as ResourcePartitionId }
      : event;
    openResourceModal(payload.resourceId, payload.anchor ? {
      anchor: {
        ...clientPointFromScenePoint(payload.anchor),
        scenePoint: payload.anchor,
        source: 'scene'
      }
    } : undefined);
  });

  sceneEventsBound = true;
}

async function openFolderPath(item: OpenClawResourceItem): Promise<void> {
  const response = await fetch('/api/openclaw/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openPath: item.folderPath ?? item.openPath ?? item.path })
  });

  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
}

async function openPreviewForItem(item: OpenClawResourceItem): Promise<void> {
  const previewPath = item.openPath ?? item.path;
  if (!previewPath) {
    setModalFeedback(uiLocale === 'zh' ? `无法预览 · ${item.title}` : `Preview unavailable · ${item.title}`, 'error');
    return;
  }
  const kind = previewKindOfPath(previewPath);

  const requestId = ++previewRequestId;
  previewState = {
    status: 'loading',
    item,
    payload: null,
    error: ''
  };
  renderPreviewModal();

  if (kind === 'image') {
    if (requestId !== previewRequestId) {
      return;
    }
    previewState = {
      status: 'ready',
      item,
      payload: {
        kind: 'image',
        path: item.path,
        contentType: 'image/*',
        url: item.thumbnailPath || previewUrlForItem(item),
        readMode: 'full',
        truncated: false
      },
      error: ''
    };
    renderPreviewModal();
    return;
  }

  try {
    const response = await fetch(`/api/openclaw/preview?path=${encodeURIComponent(previewPath)}`, {
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const payload = (await response.json()) as PreviewPayload;
    if (requestId !== previewRequestId) {
      return;
    }
    previewState = {
      status: 'ready',
      item,
      payload,
      error: ''
    };
  } catch (error) {
    if (requestId !== previewRequestId) {
      return;
    }
    previewState = {
      status: 'error',
      item,
      payload: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  renderPreviewModal();
}

function closePreviewModal(): void {
  previewRequestId += 1;
  previewState = {
    status: 'idle',
    item: null,
    payload: null,
    error: ''
  };
  previewModal?.classList.add('hidden');
  previewModal?.setAttribute('aria-hidden', 'true');
}

function renderPreviewModal(): void {
  if (!previewModal || !previewModalTitle || !previewModalSub || !previewModalNote || !previewModalBody) {
    return;
  }

  if (previewState.status === 'idle') {
    previewModal.classList.add('hidden');
    previewModal.setAttribute('aria-hidden', 'true');
    return;
  }

  previewModalTitle.textContent = previewState.item.title;
  previewModalSub.textContent = previewState.item.path;
  if (previewModalFolder) {
    previewModalFolder.textContent = uiText('openFolder', uiLocale);
    previewModalFolder.disabled = false;
  }
  if (previewModalClose) {
    previewModalClose.textContent = uiText('close', uiLocale);
  }

  if (previewState.status === 'loading') {
    previewModalNote.textContent = uiText('loadingPreview', uiLocale);
    previewModalBody.innerHTML = `<div class="preview-empty">${escapeHtml(uiText('loadingPreview', uiLocale))}</div>`;
  } else if (previewState.status === 'error') {
    previewModalNote.textContent = uiLocale === 'zh' ? '预览失败' : 'Preview failed';
    previewModalBody.innerHTML = `<div class="preview-empty">${escapeHtml(previewState.error)}</div>`;
  } else if (previewState.payload) {
    previewModalNote.textContent = previewNoteForPayload(previewState.payload);
    if (previewState.payload.kind === 'image' && previewState.payload.url) {
      previewModalBody.innerHTML = `
        <div class="preview-image-stage">
          <img class="preview-image" src="${escapeHtml(previewState.payload.url)}" alt="${escapeHtml(previewState.item.title)}" />
        </div>
      `;
    } else if (previewState.payload.kind === 'markdown') {
      previewModalBody.innerHTML = `<article class="preview-markdown">${renderMarkdownPreview(previewState.payload.content ?? '')}</article>`;
    } else {
      previewModalBody.innerHTML = `<pre class="preview-text">${escapeHtml(previewState.payload.content ?? '')}</pre>`;
    }
  }

  previewModal.classList.remove('hidden');
  previewModal.setAttribute('aria-hidden', 'false');
}

function closeRoomModal(): void {
  closePreviewModal();
  modalVisible = false;
  closeCategoryMenu();
  assetModal?.classList.add('hidden');
  assetModal?.setAttribute('aria-hidden', 'true');
  if (assetModalFeedback) {
    assetModalFeedback.textContent = '';
    assetModalFeedback.classList.remove('error');
  }
  if (modalFeedbackTimer !== null) {
    window.clearTimeout(modalFeedbackTimer);
    modalFeedbackTimer = null;
  }
  if (assetModalContext) {
    assetModalContext.innerHTML = '';
  }
  syncResourceControls();
}

async function openRecentActivityEntry(
  resourceId: ResourcePartitionId,
  sourcePath: string,
  detail: string
): Promise<void> {
  const normalizedResourceId = uiResourceId(resourceId);
  resetModalFilters();
  applyModalDefaultsForResource(normalizedResourceId);
  const hintedPath = pathHintFromDetail(detail);
  const matchedItem = (sourcePath ? itemForSourcePath(normalizedResourceId, sourcePath) : null)
    ?? (hintedPath ? itemForSourcePath(normalizedResourceId, hintedPath) : null);
  const previewPath = matchedItem?.openPath
    || matchedItem?.path
    || (previewKindOfPath(hintedPath) ? hintedPath : '')
    || (previewKindOfPath(sourcePath) ? sourcePath : '');

  if (previewPath && previewKindOfPath(previewPath)) {
    await openPreviewForItem({
      id: previewPath,
      title: matchedItem?.title ?? pathBaseName(previewPath) ?? resourceLabel(normalizedResourceId, uiLocale),
      path: matchedItem?.path ?? previewPath,
      openPath: previewPath,
      folderPath: matchedItem?.folderPath ?? (previewPath.includes('/') ? previewPath.split('/').slice(0, -1).join('/') : previewPath),
      meta: matchedItem?.meta ?? '',
      updatedAt: matchedItem?.updatedAt ?? null,
      excerpt: matchedItem?.excerpt ?? detail
    });
    return;
  }

  const kindId = matchedItem ? itemKindGroupOf(normalizedResourceId, matchedItem) : undefined;
  const searchQuery = matchedItem?.title
    ?? pathBaseName(hintedPath)
    ?? pathBaseName(sourcePath)
    ?? detail.split(/\s+/).slice(0, 3).join(' ');

  openResourceModal(normalizedResourceId, {
    forceModal: true,
    kindId,
    searchQuery
  });
}

function renderRoomModal(): void {
  if (!assetModal || !assetModalTitle || !assetModalSub || !assetModalItems) {
    return;
  }

  if (!modalVisible) {
    assetModal.classList.add('hidden');
    assetModal.setAttribute('aria-hidden', 'true');
    return;
  }

  const resource = getSelectedResource();
  if (!resource) {
    assetModalTitle.textContent = 'Loading';
    assetModalTitle.style.color = 'rgba(244, 255, 247, 0.94)';
    assetModalSub.textContent = 'Waiting for OpenClaw snapshot…';
    if (assetModalFeedback) {
      assetModalFeedback.textContent = '';
      assetModalFeedback.classList.remove('error');
    }
    if (assetModalSearch) {
      assetModalSearch.placeholder = 'Search items…';
    }
    if (assetModalContext) {
      assetModalContext.innerHTML = '';
    }
    if (assetModalSummary) {
      assetModalSummary.innerHTML = '';
    }
    assetModalItems.innerHTML = '<div class="modal-empty">waiting for snapshot…</div>';
    assetModal.classList.remove('hidden');
    assetModal.setAttribute('aria-hidden', 'false');
    return;
  }

  const resourceItems = resource.items ?? [];
  const detailReady = hasLoadedResourceDetail(resource.id) || resource.itemCount === 0;
  const detailError = resourceDetailErrorsById.get(resource.id) ?? '';
  const kindGroups = detailReady ? kindGroupsOf(resource.id, resourceItems) : [];
  if (!detailReady && !resourceDetailRequestsById.has(resource.id)) {
    void ensureResourceDetail(resource.id)
      .then(() => {
        if (selectedResourceId === resource.id && modalVisible) {
          renderRoomModal();
        }
      })
      .catch(() => {
        if (selectedResourceId === resource.id && modalVisible) {
          renderRoomModal();
        }
      });
  }

  assetModalTitle.textContent = resource.label;
  assetModalTitle.style.color = PARTITION_CSS_COLORS[resource.id] ?? 'rgba(244, 255, 247, 0.94)';
  const defaults = modalDefaultsForResource(resource.id);
  const filterNotes = [
    modalKindFilter !== 'all' ? (uiLocale === 'zh' ? `分类 ${kindMenuLabelForResource(resource.id, modalKindFilter)}` : `kind ${modalKindFilter}`) : '',
    modalSearchQuery.trim() ? (uiLocale === 'zh' ? `搜索 “${modalSearchQuery.trim()}”` : `search “${modalSearchQuery.trim()}”`) : '',
    modalViewMode !== defaults.viewMode ? (uiLocale === 'zh' ? `${modalViewMode === 'grid' ? '网格' : '列表'}视图` : `${modalViewMode} view`) : '',
    modalSortMode !== defaults.sortMode ? (uiLocale === 'zh' ? `排序 ${modalSortMode}` : `sort ${modalSortMode}`) : ''
  ].filter(Boolean);
  assetModalSub.textContent = `${resource.itemCount} items · ${humanizeTelemetryText(resource.summary)}${filterNotes.length ? ` · ${filterNotes.join(' · ')}` : ''} · ${clockOf(resource.lastAccessAt)}`;
  if (assetModalContext) {
    assetModalContext.innerHTML = renderResourceContext(resource, detailReady ? resourceItems[0] ?? null : null);
  }
  if (assetModalSummary) {
    assetModalSummary.classList.toggle('sticky', resourceUsesStickySummary(resource.id));
    assetModalSummary.dataset.hasSelection = modalKindFilter !== 'all' ? 'true' : 'false';
    assetModalSummary.innerHTML = detailReady ? resourceSummaryEntries(resource).map((entry) => `
      <button
        class="modal-summary-chip"
        type="button"
        data-summary-kind="${escapeHtml(entry.id)}"
        data-selected="${entry.id === modalKindFilter ? 'true' : 'false'}"
        style="--chip-color:${escapeHtml(entry.color)};"
      >
        <strong>${escapeHtml(entry.value)}</strong>
        <span>${escapeHtml(entry.label)}</span>
      </button>
    `).join('') : '';
  }
  if (assetModalKind) {
    assetModalKind.hidden = resourceUsesExternalKindMenu(resource.id);
    assetModalKind.innerHTML = [
      `<option value="all">${escapeHtml(uiText('allKinds', uiLocale))} (${resourceItems.length})</option>`,
      ...kindGroups.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    ].join('');
    assetModalKind.value = modalKindFilter;
    assetModalKind.disabled = resourceUsesExternalKindMenu(resource.id);
  }
  if (assetModalSort) {
    assetModalSort.value = modalSortMode;
  }
  if (assetModalView) {
    assetModalView.textContent = modalViewMode === 'list' ? uiText('grid', uiLocale) : uiText('list', uiLocale);
  }
  if (assetModalSearch) {
    if (assetModalSearch.value !== modalSearchQuery) {
      assetModalSearch.value = modalSearchQuery;
    }
    assetModalSearch.placeholder = searchPlaceholderForResource(resource.id);
  }
  if (!detailReady) {
    assetModalItems.classList.toggle('grid', false);
    assetModalItems.innerHTML = detailError
      ? `<div class="modal-empty">${escapeHtml(detailError)}<div class="modal-item-actions"><button class="asset-action" type="button" data-retry-detail="${escapeHtml(resource.id)}">Retry</button></div></div>`
      : `<div class="modal-empty">${uiLocale === 'zh' ? '正在加载资源条目…' : 'Loading resource items…'}</div>`;
    assetModal.classList.remove('hidden');
    assetModal.setAttribute('aria-hidden', 'false');
    return;
  }
  const availableKinds = kindGroups.map((entry) => entry.id);
  if (modalKindFilter !== 'all' && !availableKinds.includes(modalKindFilter)) {
    modalKindFilter = 'all';
  }
  const filteredItems = sortItems(filterItems(resource.id, resourceItems));
  const items = filteredItems.slice(0, 48);
  const hasActiveFilters = modalKindFilter !== 'all' || modalSearchQuery.trim().length > 0;
  const activeFilterSummary = [
    modalKindFilter !== 'all' ? (uiLocale === 'zh' ? `分类：${kindMenuLabelForResource(resource.id, modalKindFilter)}` : `kind: ${modalKindFilter}`) : '',
    modalSearchQuery.trim() ? (uiLocale === 'zh' ? `搜索：“${modalSearchQuery.trim()}”` : `search: “${modalSearchQuery.trim()}”`) : ''
  ].filter(Boolean).join(' · ');
  const showingLabel = filteredItems.length > items.length
    ? (uiLocale === 'zh' ? `显示 ${items.length} / ${filteredItems.length}` : `showing ${items.length} of ${filteredItems.length}`)
    : (uiLocale === 'zh' ? `显示 ${items.length}` : `showing ${items.length}`);
  assetModalSub.textContent = `${resource.itemCount} ${uiLocale === 'zh' ? '项' : 'items'} · ${showingLabel} · ${humanizeTelemetryText(resource.summary)}${filterNotes.length ? ` · ${filterNotes.join(' · ')}` : ''} · ${clockOf(resource.lastAccessAt)}`;
  assetModalItems.classList.toggle('grid', modalViewMode === 'grid');
  assetModalItems.innerHTML = items.length
    ? items.map((entry, index) => {
        const displayTitle = humanizeTelemetryText(entry.title);
        const title = escapeHtml(displayTitle);
        const titleMarkup = highlightMatch(displayTitle, modalSearchQuery);
        const pathMarkup = highlightMatch(entry.path, modalSearchQuery);
        const previewable = isPreviewableItem(entry);
        const thumb = entry.thumbnailPath ? `<img class="modal-thumb" src="${escapeHtml(entry.thumbnailPath)}" alt="${title}" />` : '';
        const updatedLabel = entry.updatedAt ? `updated ${clockOf(entry.updatedAt)}` : '';
        const sizeLabel = formatSize(entry.sizeBytes);
        const accentColor = modalAccentColorForItem(resource.id, entry);
        const kindLabel = kindMenuLabelForResource(resource.id, itemKindGroupOf(resource.id, entry));
        const previousKindLabel = index > 0
          ? kindMenuLabelForResource(resource.id, itemKindGroupOf(resource.id, items[index - 1]))
          : '';
        const rawMetaLabel = itemRawMetaLabel(entry);
        const railSegments = numericStatSegments(entry);
        const railTotal = railSegments.reduce((sum, stat) => sum + stat.value, 0);
        const isHeroItem = resource.id === 'agent' && index === 0;
        const isCompactItem = resource.id === 'agent' && index > 0;
        const heroLabel = isHeroItem
          ? `<div class="modal-item-herohead">${uiLocale === 'zh' ? '运行总览' : 'Operational Overview'}</div>`
          : '';
        const blockedStat = entry.stats?.find((stat) => stat.label === 'blocked');
        const pendingStat = entry.stats?.find((stat) => stat.label === 'pending');
        const blockedCount = Number(blockedStat?.value ?? 0);
        const pendingCount = Number(pendingStat?.value ?? 0);
        const heroPriorityTone = blockedCount > 0 ? 'danger' : pendingCount > 0 ? 'warm' : 'calm';
        const heroPriorityText = blockedCount > 0
          ? (uiLocale === 'zh' ? '需要立即处理' : 'Needs attention')
          : pendingCount > 0
            ? (uiLocale === 'zh' ? '队列有积压' : 'Queue pressure')
            : (uiLocale === 'zh' ? '运行稳定' : 'Running smoothly');
        const heroAlert = isHeroItem
          ? `
            <div class="modal-item-heroalert">
              <span class="modal-item-herostatus" data-tone="${escapeHtml(heroPriorityTone)}">${escapeHtml(heroPriorityText)}</span>
              ${blockedCount > 0 ? `<span class="modal-item-pill" data-tone="danger">${escapeHtml(uiLocale === 'zh' ? `阻塞 ${blockedCount}` : `Blocked ${blockedCount}`)}</span>` : ''}
              ${pendingCount > 0 ? `<span class="modal-item-pill" data-tone="warm">${escapeHtml(uiLocale === 'zh' ? `排队 ${pendingCount}` : `Pending ${pendingCount}`)}</span>` : ''}
              ${blockedCount === 0 && pendingCount === 0 ? `<span class="modal-item-pill" data-tone="calm">${escapeHtml(uiLocale === 'zh' ? '队列顺畅' : 'Queue clear')}</span>` : ''}
            </div>
          `
          : '';
        const sectionHeader = resource.id === 'agent' && !isHeroItem && kindLabel !== previousKindLabel
          ? `<div class="modal-item-section">${escapeHtml(kindLabel)}</div>`
          : '';
        const statsRow = entry.stats?.length
          ? `
            <div class="modal-item-stats">
              ${entry.stats.map((stat) => `
                <div class="modal-item-stat${isHeroItem && (stat.label === 'blocked' || stat.label === 'pending') ? ' priority' : ''}" data-tone="${escapeHtml(modalStatTone(resource.id, stat.tone))}">
                  <strong>${escapeHtml(stat.value)}</strong>
                  <span>${escapeHtml(stat.label)}</span>
                </div>
              `).join('')}
            </div>
          `
          : '';
        const railRow = railSegments.length >= 2 && railTotal > 0
          ? `
            <div class="modal-item-rail">
              ${railSegments.map((stat) => `
                <span
                  class="modal-item-rail-segment"
                  data-tone="${escapeHtml(modalStatTone(resource.id, stat.tone))}"
                  title="${escapeHtml(`${stat.label}: ${stat.value}`)}"
                  style="--segment-share:${escapeHtml(String(stat.value / railTotal))};"
                ></span>
              `).join('')}
            </div>
          `
          : '';
        const showKindPill = modalKindFilter === 'all' && !resourceUsesExternalKindMenu(resource.id) && resource.id !== 'agent';
        const metaTokens = [
          rawMetaLabel && rawMetaLabel.toLowerCase() !== kindLabel.toLowerCase()
            ? `<span class="modal-item-pill" data-tone="${escapeHtml(modalPillTone(resource.id, rawMetaLabel))}">${escapeHtml(rawMetaLabel)}</span>`
            : '',
          showKindPill
            ? `<span class="modal-item-pill kind" data-tone="${escapeHtml(modalPillTone(resource.id, kindLabel))}">${escapeHtml(kindLabel)}</span>`
            : '',
          updatedLabel
            ? `<span class="modal-item-updated">${escapeHtml(updatedLabel)}</span>`
            : '',
          `<span class="modal-item-updated">${escapeHtml(sizeLabel)}</span>`
        ].filter(Boolean);
        const metaRow = metaTokens.length
          ? `<div class="modal-item-meta-row">${metaTokens.join('')}</div>`
          : '';
        const displayExcerpt = humanizeTelemetryText(entry.excerpt);
        const excerptMarkup = displayExcerpt ? `<div class="modal-item-excerpt">${highlightMatch(displayExcerpt, modalSearchQuery)}</div>` : '';
        const previewArea = previewable
          ? `
            <button
              class="modal-item-preview"
              type="button"
              data-preview-path="${escapeHtml(entry.openPath ?? entry.path)}"
              data-preview-title="${title}"
              data-preview-folder="${escapeHtml(entry.folderPath ?? entry.path)}"
              data-preview-meta="${escapeHtml(entry.meta ?? '')}"
            >
              <div class="modal-item-main">
                <div class="modal-item-titleblock">
                  <strong class="modal-item-title">${titleMarkup}</strong>
                  ${metaRow}
                </div>
              </div>
              ${statsRow}
              ${railRow}
              <div class="modal-item-path">${pathMarkup}</div>
              ${excerptMarkup}
              ${thumb}
            </button>
          `
          : `
            <div class="modal-item-preview">
              <div class="modal-item-main">
                <div class="modal-item-titleblock">
                  <strong class="modal-item-title">${titleMarkup}</strong>
                  ${metaRow}
                </div>
              </div>
              ${statsRow}
              ${railRow}
              <div class="modal-item-path">${pathMarkup}</div>
              ${excerptMarkup}
              ${thumb}
            </div>
          `;
        return `
          ${sectionHeader}
          <article
            class="modal-item${isHeroItem ? ' hero' : ''}${isCompactItem ? ' compact' : ''}${previewable ? ' previewable' : ''}"
            data-panel="${escapeHtml(resource.id)}"
            data-state-tone="${escapeHtml(modalPillTone(resource.id, kindLabel))}"
            style="--item-accent-color:${escapeHtml(accentColor)};"
          >
            ${heroLabel}
            ${heroAlert}
            ${previewArea}
          </article>
        `;
      }).join('')
    : `
      <div class="modal-empty">
        ${hasActiveFilters ? (uiLocale === 'zh' ? '当前筛选条件下没有匹配条目。' : 'No items match the current filters.') : (uiLocale === 'zh' ? '这个房间暂时还没有历史条目。' : 'No history items available yet for this room.')}
        ${hasActiveFilters && activeFilterSummary ? `<div class="modal-item-meta">${escapeHtml(uiLocale === 'zh' ? `当前筛选 · ${activeFilterSummary}` : `Current filters · ${activeFilterSummary}`)}</div>` : ''}
        ${hasActiveFilters ? `<div class="modal-item-actions"><button class="asset-action" type="button" data-reset-filters="1">${uiLocale === 'zh' ? '清除筛选' : 'Clear Filters'}</button></div>` : ''}
      </div>
    `;

  assetModal.classList.remove('hidden');
  assetModal.setAttribute('aria-hidden', 'false');
}

function syncGrowth(): void {
  const activeScene = getActiveScene();
  if (!activeScene) {
    return;
  }
  activeScene.events.emit('set-growth', { ...state });
  syncResourceControls();
  renderRoomModal();
}

async function refreshTelemetry(): Promise<void> {
  const query = forceMock ? '?mock=1' : '';
  try {
    const response = await fetch(`/api/openclaw/snapshot${query}`, {
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    lastSnapshot = (await response.json()) as OpenClawSnapshot;
    const activeScene = getActiveScene();
    activeScene?.applyTelemetrySnapshot(lastSnapshot);

    // Diff activeAgents to spawn/despawn secondary actors (subagents)
    const currentAgents = lastSnapshot.activeAgents ?? [];
    const currentAgentIds = new Set(currentAgents.map((agent) => agent.id));
    if (activeScene) {
      for (const agent of currentAgents) {
        if (!prevActiveAgentIds.has(agent.id)) {
          activeScene.spawnAgentActor(agent.id, agent.label, 'subagent');
        }
      }
      for (const prevId of prevActiveAgentIds) {
        if (!currentAgentIds.has(prevId)) {
          activeScene.despawnAgentActor(prevId);
        }
      }
      prevActiveAgentIds = currentAgentIds;
    }

    // Apply focus zones from focus-*.json files (written by subagents/processes)
    void (async () => {
      try {
        const focusResponse = await fetch('/api/openclaw/agent-focus', { cache: 'no-store' });
        if (!focusResponse.ok) return;
        const focusData = (await focusResponse.json()) as {
          ok: boolean;
          focuses: Array<{ runId: string; resourceId: string; detail?: string }>;
        };
        if (!focusData.ok) return;
        const sceneReady = getActiveScene();
        if (!sceneReady) return;
        const focusMap = new Map(focusData.focuses.map((f) => [f.runId, f]));
        // Apply to subagents — match by id first, then fallback to label
        for (const agent of currentAgents) {
          const focus = focusMap.get(agent.id) ?? focusMap.get(agent.label);
          sceneReady.setAgentActorFocus(agent.id, (focus?.resourceId as ResourcePartitionId) ?? null);
          sceneReady.setAgentActorStatus(agent.id, focus?.detail ?? '');
        }
        // Apply to exec-processes (prefixed with proc:)
        for (const [procId] of prevActiveProcessIds.entries()) {
          const focus = focusMap.get(procId);
          sceneReady.setAgentActorFocus(`proc:${procId}`, (focus?.resourceId as ResourcePartitionId) ?? null);
          sceneReady.setAgentActorStatus(`proc:${procId}`, focus?.detail ?? '');
        }
      } catch { /* best-effort */ }
    })();

    // Diff activeProcesses to spawn/despawn exec-process actors (amber capys, slow)
    void (async () => {
      try {
        const procResponse = await fetch('/api/openclaw/processes', { cache: 'no-store' });
        if (!procResponse.ok) return;
        const procData = (await procResponse.json()) as { ok: boolean; processes: ActiveExecProcess[] };
        if (!procData.ok) return;
        const currentProcesses = procData.processes.filter((p) => p.status === 'running');
        const currentProcIds = new Set(currentProcesses.map((p) => p.id));
        const sceneReady = getActiveScene();
        if (sceneReady) {
          for (const proc of currentProcesses) {
            if (!prevActiveProcessIds.has(proc.id)) {
              // Use a process-scoped id to avoid collision with subagent ids
              sceneReady.spawnAgentActor(`proc:${proc.id}`, proc.label, 'exec-process');
            }
          }
          for (const prevId of prevActiveProcessIds) {
            if (!currentProcIds.has(prevId)) {
              sceneReady.despawnAgentActor(`proc:${prevId}`);
            }
          }
          prevActiveProcessIds = currentProcIds;
        }
      } catch {
        // ignore — process endpoint is best-effort
      }
    })();

    ensureSceneBindings();
    syncResourceControls();
    renderRoomModal();
  } catch (error) {
    if (assetModalItems && modalVisible) {
      assetModalItems.innerHTML = `<div class="modal-empty">${error instanceof Error ? error.message : String(error)}</div>`;
    }
  }
}

cycleThemeButton?.addEventListener('click', () => {
  const activeScene = getActiveScene();
  activeScene?.events.emit('cycle-theme');
});

toggleActorSkinButton?.addEventListener('click', () => {
  const activeScene = getActiveScene();
  if (!activeScene) {
    return;
  }
  const variants = activeScene.getActorVariants();
  if (variants.length <= 1) {
    return;
  }
  const currentId = activeScene.getActorVariantId();
  const currentIndex = variants.findIndex((variant) => variant.id === currentId);
  const next = variants[(currentIndex + 1 + variants.length) % variants.length] ?? variants[0];
  actorVariantId = next.id;
  activeScene.setActorVariant(next.id);
  saveActorVariantPreference();
  updateActorSkinButtonLabel();
});

toggleLocaleButton?.addEventListener('click', () => {
  uiLocale = uiLocale === 'zh' ? 'en' : 'zh';
  saveLocale();
  applyLocaleToChrome();
  getActiveScene()?.setLocale(uiLocale);
  syncResourceControls();
  renderRoomModal();
});

toggleDebugButton?.addEventListener('click', () => {
  debugPanelVisible = !debugPanelVisible;
  saveDebugPanelPreference();
  applyDebugPanelVisibility();
});

toggleInfoPanelButton?.addEventListener('click', () => {
  infoPanelVisible = !infoPanelVisible;
  saveInfoPanelPreference();
  applyInfoPanelVisibility();
});

gatewayCategoryMenu?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const button = target.closest('button[data-kind-id]');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const kindId = button.dataset.kindId;
  if (!kindId) {
    return;
  }
  if (!categoryMenuResourceId) {
    return;
  }
  openResourceKind(categoryMenuResourceId, kindId);
});

window.addEventListener('pointerdown', (event) => {
  debugPointer = scenePointFromClientPoint({ x: event.clientX, y: event.clientY });
  debugLastClick = debugPointer;
  renderDebugOverlay();
  if (!categoryMenuVisible) {
    return;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    closeCategoryMenu();
    return;
  }
  if (target.closest('#gateway-category-menu')) {
    return;
  }
  closeCategoryMenu();
});

window.addEventListener('pointermove', (event) => {
  debugPointer = scenePointFromClientPoint({ x: event.clientX, y: event.clientY });
  if (debugPanelVisible) {
    renderDebugOverlay();
  }
});

window.addEventListener('resize', () => {
  syncInfoTogglePosition();
  refreshDebugPointerProjection();
  if (categoryMenuVisible && categoryMenuResourceId) {
    void openResourceKindMenu(categoryMenuResourceId, pendingCategoryMenuAnchor);
  }
});

resourceMenu?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest('button[data-resource-id]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }

  const resourceId = button.dataset.resourceId as ResourcePartitionId | undefined;
  if (!resourceId) {
    return;
  }

  openResourceModal(resourceId);
});

hudActivityItems?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const groupButton = target.closest('button[data-activity-group-id]');
  if (groupButton instanceof HTMLButtonElement) {
    const groupId = groupButton.dataset.activityGroupId as ResourcePartitionId | undefined;
    if (!groupId) {
      return;
    }
    selectedActivityGroupId = selectedActivityGroupId === groupId ? null : groupId;
    renderRecentActivity();
    return;
  }

  const button = target.closest('button[data-activity-resource-id]');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const resourceId = button.dataset.activityResourceId as ResourcePartitionId | undefined;
  if (!resourceId) {
    return;
  }

  const sourcePath = button.dataset.activitySource ?? '';
  const detail = button.dataset.activityDetail ?? '';
  await openRecentActivityEntry(resourceId, sourcePath, detail);
});

assetModalClose?.addEventListener('click', closeRoomModal);
assetModalKind?.addEventListener('change', () => {
  modalKindFilter = assetModalKind.value || 'all';
  renderRoomModal();
});
assetModalSort?.addEventListener('change', () => {
  modalSortMode = (assetModalSort.value as typeof modalSortMode) || 'priority';
  rememberModalPreferenceForSelectedResource();
  renderRoomModal();
});
assetModalCopyContext?.addEventListener('click', async () => {
  await copySelectedResourceContext();
});
assetModalView?.addEventListener('click', () => {
  modalViewMode = modalViewMode === 'list' ? 'grid' : 'list';
  rememberModalPreferenceForSelectedResource();
  renderRoomModal();
});
assetModalSearch?.addEventListener('input', () => {
  modalSearchQuery = assetModalSearch.value;
  renderRoomModal();
});
assetModal?.addEventListener('click', (event) => {
  if (event.target === assetModal) {
    closeRoomModal();
  }
});

previewModalClose?.addEventListener('click', closePreviewModal);
previewModalFolder?.addEventListener('click', async () => {
  if (previewState.status === 'idle') {
    return;
  }
  try {
    await openFolderPath(previewState.item);
  } catch (error) {
    setModalFeedback(`Open folder failed · ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
});
previewModal?.addEventListener('click', (event) => {
  if (event.target === previewModal) {
    closePreviewModal();
  }
});

assetModalSummary?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const button = target.closest('button[data-summary-kind]');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const nextKind = button.dataset.summaryKind;
  if (!nextKind) {
    return;
  }
  modalKindFilter = modalKindFilter === nextKind ? 'all' : nextKind;
  renderRoomModal();
});

assetModalContext?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const eventCopyButton = target.closest('button[data-context-copy-event]');
  if (eventCopyButton instanceof HTMLButtonElement) {
    const detail = eventCopyButton.dataset.contextCopyEvent;
    const title = eventCopyButton.dataset.contextCopyEventTitle ?? 'event';
    if (!detail) {
      return;
    }
    try {
      await navigator.clipboard.writeText(detail);
      setModalFeedback(`Copied event detail · ${title}`);
    } catch (error) {
      setModalFeedback(`Copy event detail failed · ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    return;
  }

  const previewButton = target.closest('button[data-context-preview-path]');
  if (previewButton instanceof HTMLButtonElement) {
    const openPath = previewButton.dataset.contextPreviewPath;
    const title = previewButton.dataset.contextPreviewTitle ?? openPath ?? 'item';
    if (!openPath) {
      return;
    }
    await openPreviewForItem({
      id: openPath,
      title,
      path: openPath,
      openPath,
      folderPath: previewButton.dataset.contextPreviewFolder ?? openPath,
      meta: previewButton.dataset.contextPreviewMeta ?? '',
      updatedAt: null
    });
    return;
  }

});

assetModalItems?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const retryButton = target.closest('button[data-retry-detail]');
  if (retryButton instanceof HTMLButtonElement) {
    const resourceId = retryButton.dataset.retryDetail as ResourcePartitionId | undefined;
    if (!resourceId) {
      return;
    }
    resourceDetailErrorsById.delete(resourceId);
    resourceDetailLoadedById.delete(resourceId);
    resourceDetailItemsById.delete(resourceId);
    void ensureResourceDetail(resourceId)
      .then(() => {
        if (selectedResourceId === resourceId && modalVisible) {
          renderRoomModal();
        }
      })
      .catch(() => {
        if (selectedResourceId === resourceId && modalVisible) {
          renderRoomModal();
        }
      });
    renderRoomModal();
    return;
  }

  const resetButton = target.closest('button[data-reset-filters]');
  if (resetButton instanceof HTMLButtonElement) {
    resetModalFilters();
    renderRoomModal();
    return;
  }

  const previewButton = target.closest('button[data-preview-path]');
  if (previewButton instanceof HTMLButtonElement) {
    const openPath = previewButton.dataset.previewPath;
    const title = previewButton.dataset.previewTitle ?? openPath ?? 'item';
    if (!openPath) {
      return;
    }
    await openPreviewForItem({
      id: openPath,
      title,
      path: openPath,
      openPath,
      folderPath: previewButton.dataset.previewFolder ?? openPath,
      meta: previewButton.dataset.previewMeta ?? '',
      updatedAt: null
    });
    return;
  }
});

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  if (isTypingTarget(event.target)) {
    if (event.key === 'Escape' && previewState.status !== 'idle') {
      closePreviewModal();
      return;
    }
    if (event.key === 'Escape' && modalVisible) {
      closeRoomModal();
    }
    return;
  }

  if (event.key === 'Escape' && previewState.status !== 'idle') {
    closePreviewModal();
    return;
  }
  if (event.key === 'Escape' && modalVisible) {
    closeRoomModal();
    return;
  }
  if (event.key === 'Escape' && categoryMenuVisible) {
    closeCategoryMenu();
    return;
  }

  if (modalVisible && event.key === '/') {
    event.preventDefault();
    assetModalSearch?.focus();
    assetModalSearch?.select();
    return;
  }

  if (modalVisible && event.key === 'C' && event.shiftKey) {
    event.preventDefault();
    void copySelectedResourceContext();
    return;
  }

  const key = event.key.toLowerCase();
  if (key === 'i') {
    openResourceModal('images');
    return;
  }
  if (key === 's') {
    openResourceModal('skills');
    return;
  }
  if (key === 'd') {
    openResourceModal('document');
    return;
  }
  if (key === 'a') {
    openResourceModal('alarm');
    return;
  }
  if (key === 'q') {
    openResourceModal('gateway');
    return;
  }
  if (key === 'l') {
    openResourceModal('log');
    return;
  }
  if (key === 'b') {
    openResourceModal('break_room');
    return;
  }
});

loadLocale();
loadInfoPanelPreference();
loadDebugPanelPreference();
loadActorVariantPreference();
loadModalPrefs();
applyLocaleToChrome();
syncGrowth();
syncResourceControls();
renderRoomModal();
const bindSceneTimer = window.setInterval(() => {
  ensureSceneBindings();
  if (sceneEventsBound) {
    window.clearInterval(bindSceneTimer);
  }
}, 250);
void refreshTelemetry();
window.setInterval(() => {
  void refreshTelemetry();
}, TELEMETRY_POLL_MS);
window.setInterval(() => {
  renderActorLiveStatus();
}, 250);

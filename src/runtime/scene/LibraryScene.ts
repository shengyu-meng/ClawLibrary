import Phaser from 'phaser';
import type {
  ActorVariantDef,
  AssetDef,
  GrowthState,
  InterfaceDef,
  LobsterStateId,
  OpenClawAccessEvent,
  OpenClawResourceTelemetry,
  OpenClawSnapshot,
  OutputCategoryDef,
  Point,
  ResourcePartitionId,
  ResourceTelemetryStatus,
  SceneGlobalLayerDef,
  RoomArtSlice,
  RoomSliceLayerDef,
  ThemePack,
  WorkMode,
  WorkOutputEvent,
  WorkStateProfile,
  WorkStatus,
  WorkZone,
  WorkZoneType
} from '../../core/types';
import { pointInPolygon } from '../../core/geometry';
import { computeRoute } from '../../core/pathfinder';
import { computeVisibleAssetIds } from '../systems/growth';
import { loadProtocols } from '../systems/protocolStore';
import { configureTouch } from '../systems/touchController';
import type { UiLocale } from '../../ui/locale';
import { resourceLabel } from '../../ui/locale';
import { PARTITION_COLORS } from '../../ui/palette';

const INITIAL_GROWTH: GrowthState = {
  assetsCount: 0,
  skillsCount: 0,
  textOutputs: 0
};

const CAMERA_SCROLL_X = 0;

const LEGACY_BACKGROUND = {
  textureKey: 'll3-master-layout-v1',
  path: '/assets/generated/ll3/2026-03-07/ll3-master-layout-v1.png',
  displaySize: { width: 1920, height: 1072 },
  anchor: { x: 960, y: 540 }
} as const;

const PROP_SHADOW_OFFSET = { x: 4, y: 4 } as const;
const PROP_SHADOW_ALPHA = 0.16;

type RenderedAsset = {
  def: AssetDef;
  body: Phaser.GameObjects.Rectangle;
  pulseTween: Phaser.Tweens.Tween | null;
};

type RenderedSliceLayer = {
  slice: RoomArtSlice;
  layer: RoomSliceLayerDef;
  shadowImage: Phaser.GameObjects.Image | null;
  image: Phaser.GameObjects.Image;
};

type RenderedGlobalLayer = {
  layer: SceneGlobalLayerDef;
  shadowImage: Phaser.GameObjects.Image | null;
  image: Phaser.GameObjects.Image;
};

type ZoneState = 'idle' | 'moving' | 'working' | 'done';

type RouteContext = {
  resourceId: ResourcePartitionId;
  detail: string;
  source?: string;
  status?: ResourceTelemetryStatus;
};

type ResourceSelectEvent = {
  resourceId: ResourcePartitionId;
  anchor?: Point;
};

type AgentActorKind = 'subagent' | 'exec-process';

type AgentActor = {
  id: string;
  label: string;
  kind: AgentActorKind;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc | null;
  route: Point[];
  activeZoneId: ResourcePartitionId | null;
  focusZoneId: ResourcePartitionId | null;
  workCursor: number;
  nameTag: Phaser.GameObjects.Text | null;
  /** Current visual mode — only used for subagents (exec-processes stay static) */
  visualMode: WorkMode;
  /** Timestamp (ms) when working animation should end and revert to idle */
  workingUntil: number;
};

export class LibraryScene extends Phaser.Scene {
  private readonly protocols = loadProtocols();
  private growthState: GrowthState = { ...INITIAL_GROWTH };
  private currentThemeIndex = 0;

  private lobster!: Phaser.GameObjects.Container;
  private lobsterBody: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc | null = null;
  private lobsterRoute: Point[] = [];
  private lobsterContextBar: Phaser.GameObjects.Graphics | null = null;
  private lobsterContextRemaining = 1; // 0–1, starts full
  private agentActors: AgentActor[] = [];

  private roomLayer!: Phaser.GameObjects.Graphics;
  private zoneLayer!: Phaser.GameObjects.Graphics;
  private occluderLayer!: Phaser.GameObjects.Graphics;
  private hitLayer!: Phaser.GameObjects.Graphics;
  private legacyBackgroundImage: Phaser.GameObjects.Image | null = null;
  private renderedGlobalLayers: RenderedGlobalLayer[] = [];
  private walkableMaskData: Uint8ClampedArray | null = null;
  private walkableMaskWidth = 0;
  private walkableMaskHeight = 0;
  private walkableGrid: Uint8Array | null = null;
  private walkableGridCols = 0;
  private walkableGridRows = 0;
  private readonly walkableGridStep = 12;
  private reachableWalkableGrid: Uint8Array | null = null;

  private workStatusText!: Phaser.GameObjects.Text;
  private lobsterThoughtText!: Phaser.GameObjects.Text;

  private renderLayerDepths = new Map<string, number>();
  private queuedTextureKeys = new Set<string>();
  private renderedAssets: RenderedAsset[] = [];
  private renderedRoomSlices: RenderedSliceLayer[] = [];
  private ambientPropFx: Phaser.GameObjects.GameObject[] = [];
  private roomTitleBackplates = new Map<ResourcePartitionId, Phaser.GameObjects.Graphics>();
  private roomTitleLabels = new Map<ResourcePartitionId, Phaser.GameObjects.Text>();
  private zoneLabels = new Map<ResourcePartitionId, Phaser.GameObjects.Text>();
  private zoneState = new Map<ResourcePartitionId, ZoneState>();
  private stateCursorByZoneType = new Map<WorkZoneType, number>();
  private telemetryResources = new Map<ResourcePartitionId, OpenClawResourceTelemetry>();
  private telemetryQueue: OpenClawAccessEvent[] = [];
  private processedEventIds = new Set<string>();

  private workMode: WorkMode = 'idle';
  private activeZoneId: ResourcePartitionId | null = null;
  private lastReachedZoneId: ResourcePartitionId | null = null;
  private workCursor = 0;
  private outputCursor = 0;
  private pendingStateProfile: WorkStateProfile | null = null;
  private pendingRouteContext: RouteContext | null = null;

  private liveMode: OpenClawSnapshot['mode'] = 'mock';
  private focusResourceId: ResourcePartitionId = 'break_room';
  private focusDetail = 'warming up the library';
  private lastTelemetryAt: string | null = null;
  private locale: UiLocale = 'en';
  private debugVisualsVisible = false;
  private hoveredRoomId: ResourcePartitionId | null = null;
  private actorVariantId: string | null = null;
  private celebrationUntil = 0;
  private actorVisualCursorByContext = new Map<string, number>();
  private actorVisualSelectionByContext = new Map<string, { textureKey: string; holdUntil: number }>();

  private lastOutput: WorkOutputEvent = {
    stateId: 'idle',
    stateLabel: 'Standby',
    outputCategoryId: 'document',
    outputCategoryLabel: 'Document',
    interfaceId: 'gateway',
    interfaceLabel: 'Gateway Switchboard',
    interfaceEndpoint: '.openclaw/openclaw.json',
    content: 'waiting for next access'
  };

  constructor() {
    super('LibraryScene');
  }

  preload(): void {
    this.preloadSceneArt();
  }

  create(): void {
    configureTouch(this);
    this.cameras.main.setScroll(CAMERA_SCROLL_X, 0);

    this.initializeRenderLayerDepths();

    this.spawnSceneBaseArt();

    this.roomLayer = this.add.graphics();
    this.roomLayer.setDepth(this.getRenderLayerDepth('floor'));

    this.zoneLayer = this.add.graphics();
    this.zoneLayer.setDepth(this.getRenderLayerDepth('mid_props') + 3);

    this.hitLayer = this.add.graphics();
    this.hitLayer.setDepth(this.getRenderLayerDepth('mid_props') + 9);

    this.occluderLayer = this.add.graphics();
    this.occluderLayer.setDepth(this.getRenderLayerDepth('fg_occluder'));

    this.workStatusText = this.add.text(30, 20, '', {
      color: '#d7e2ff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontSize: '16px',
      lineSpacing: 3
    });
    this.workStatusText.setDepth(this.getRenderLayerDepth('fx_overlay') + 10);
    this.workStatusText.setVisible(false);

    this.lobsterThoughtText = this.add.text(0, 0, '', {
      color: '#f3fff9',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontSize: '12px',
      lineSpacing: 3,
      align: 'center',
      backgroundColor: 'rgba(9, 24, 22, 0.82)',
      padding: { left: 10, right: 10, top: 7, bottom: 7 }
    });
    this.lobsterThoughtText.setOrigin(0.5, 1);
    this.lobsterThoughtText.setDepth(this.getRenderLayerDepth('fx_overlay') + 12);
    this.lobsterThoughtText.setStroke('#04100f', 3);

    this.drawRooms();
    this.spawnRoomSlices();
    this.initializeWalkableMask();
    this.spawnAssets();
    this.createActorAnimations();
    this.spawnLobster();
    this.snapWorkZonesToReachableWalkable({ x: this.lobster.x, y: this.lobster.y });
    this.initializeRoomLabels();
    this.initializeWorkZones();
    this.drawOccluders();
    this.spawnAmbientPropFx();
    this.applyDebugVisualLayerVisibility();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerDown(pointer.worldX, pointer.worldY);
    });

    this.events.on('set-growth', (next: GrowthState) => {
      this.growthState = next;
      this.applyGrowthState();
    });

    this.events.on('cycle-theme', () => {
      this.currentThemeIndex = (this.currentThemeIndex + 1) % this.protocols.themePack.themes.length;
      this.drawRooms();
      this.applyGlobalLayerTheme();
      this.applyRoomSliceTheme();
      this.syncRoomLabels();
      this.drawWorkZones();
      this.drawOccluders();
      this.syncWorkStatus();
    });

    this.time.addEvent({
      delay: 4200,
      callback: () => this.enqueueAutoWork(),
      loop: true
    });

    this.lastOutput = this.materializeOutput(this.resolveStateProfile('idle'), {
      resourceId: 'document',
      detailOverride: 'waiting for next access'
    });

    this.applyGrowthState();
    this.syncRoomLabels();
    this.updateResourceAnimations();
    this.updateLobsterVisual('idle');
    this.syncWorkStatus();
  }

  update(_time: number, delta: number): void {
    this.advanceLobster(delta);
    this.positionThoughtBubble();
    for (const actor of this.agentActors) {
      this.advanceAgentActor(actor, delta);
    }
  }

  public getGrowthState(): GrowthState {
    return this.growthState;
  }

  public getWorkStatus(): WorkStatus {
    const zone = this.activeZoneId ? this.zoneLabel(this.activeZoneId) : this.lastReachedZoneId ? this.zoneLabel(this.lastReachedZoneId) : null;
    return {
      mode: this.workMode,
      zone,
      stateId: this.lastOutput.stateId,
      stateLabel: this.lastOutput.stateLabel,
      outputCategory: this.lastOutput.outputCategoryLabel,
      interfaceTarget: `${this.lastOutput.interfaceLabel} · ${this.lastOutput.interfaceEndpoint}`,
      detail: this.lastOutput.content
    };
  }

  public applyTelemetrySnapshot(snapshot: OpenClawSnapshot): void {
    this.liveMode = snapshot.mode;
    this.lastTelemetryAt = snapshot.generatedAt;
    this.focusResourceId = snapshot.focus.resourceId;
    this.focusDetail = snapshot.focus.detail;

    // Update context bar if data available
    if (snapshot.mainActorContext) {
      const remaining = snapshot.mainActorContext.remaining;
      if (this.lobsterContextRemaining !== remaining) {
        this.lobsterContextRemaining = remaining;
        this.drawContextBar(remaining);
      }
    }

    this.telemetryResources.clear();
    for (const resource of snapshot.resources) {
      this.telemetryResources.set(resource.id, resource);
    }

    const hasLiveWorkSignal = snapshot.resources.some((resource) => resource.status === 'alert' || resource.status === 'active');
    if (!hasLiveWorkSignal) {
      this.telemetryQueue = [];
    } else {
      this.telemetryQueue = this.telemetryQueue.filter((event) => event.status === 'alert' || event.status === 'active');
    }

    for (const event of snapshot.recentEvents) {
      if (event.status !== 'alert' && event.status !== 'active') {
        continue;
      }
      if (this.processedEventIds.has(event.id)) {
        continue;
      }
      this.processedEventIds.add(event.id);
      this.telemetryQueue.push(event);
    }

    if (this.processedEventIds.size > 64) {
      const recentIds = new Set(this.telemetryQueue.slice(-24).map((item) => item.id));
      for (const id of [...this.processedEventIds]) {
        if (!recentIds.has(id)) {
          this.processedEventIds.delete(id);
        }
      }
    }

    this.drawRooms();
    this.syncRoomLabels();
    this.drawWorkZones();
    this.updateResourceAnimations();
    this.syncWorkStatus();
    this.maybeProcessTelemetryQueue();
  }

  public spawnAgentActor(runId: string, label: string, kind: AgentActorKind = 'subagent'): void {
    if (this.agentActors.some((actor) => actor.id === runId)) {
      return;
    }
    const nodes = this.protocols.mapLogic.walkGraph.nodes;
    if (nodes.length === 0) {
      return;
    }

    // exec-processes spawn inside the break_room (bottom-right room — Run Dock / Documents Archive)
    // subagents pick any node far from the primary actor
    let startNode = nodes[0];
    if (kind === 'exec-process') {
      const breakRoom = this.protocols.mapLogic.rooms.find((r) => r.id === 'break_room');
      if (breakRoom) {
        const [rx, ry, rw, rh] = breakRoom.bounds;
        const roomNodes = nodes.filter((n) => n.x >= rx && n.x <= rx + rw && n.y >= ry && n.y <= ry + rh);
        startNode = roomNodes[Math.floor(Math.random() * roomNodes.length)] ?? nodes[0];
      }
    } else {
      const usableNodes = nodes.filter((node) => {
        const dx = node.x - this.lobster.x;
        const dy = node.y - this.lobster.y;
        return Math.hypot(dx, dy) > 80;
      });
      startNode = usableNodes[Math.floor(Math.random() * usableNodes.length)] ?? nodes[0];
    }

    const children: Phaser.GameObjects.GameObject[] = [];
    const actor = this.protocols.sceneArt.actor;
    const variant = this.resolveActorVariant();
    const idleVisual = this.resolveActorMode('idle');

    // Subtle shadow
    if (actor?.shadow) {
      const shadow = this.add.ellipse(0, actor.shadow.offsetY, actor.shadow.width * 0.85, actor.shadow.height * 0.85, 0x081018, actor.shadow.alpha * 0.7);
      children.push(shadow);
    }

    // Visual style: subagents = cool blue tint, exec-processes = warm amber tint (smaller, slower)
    const isExecProcess = kind === 'exec-process';
    const scaleFactor = isExecProcess ? 0.72 : 0.88;
    const tintColor = isExecProcess ? 0xffd080 : 0xaad4ff;
    const fallbackColor = isExecProcess ? 0xe8a830 : 0x4fa8e8;
    const nameTagColor = isExecProcess ? '#ffe4a0' : '#b8d8ff';
    const nameTagBg = isExecProcess ? 'rgba(28, 18, 4, 0.76)' : 'rgba(4, 12, 28, 0.72)';
    const nameTagPrefix = isExecProcess ? '⚙ ' : '';

    let body: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc | null = null;
    if (actor && variant && idleVisual) {
      const sprite = this.add.sprite(actor.anchorOffset?.x ?? 0, actor.anchorOffset?.y ?? 0, idleVisual.textureKey);
      sprite.setDisplaySize(actor.displaySize.width * scaleFactor, actor.displaySize.height * scaleFactor);
      sprite.setTint(tintColor);
      children.push(sprite);
      body = sprite;
    } else {
      const fallback = this.add.circle(0, 0, isExecProcess ? 11 : 14, fallbackColor, 1);
      fallback.setStrokeStyle(2, isExecProcess ? 0x2a1800 : 0x0a1a2e, 0.8);
      children.push(fallback);
      body = fallback;
    }

    const container = this.add.container(startNode.x, startNode.y, children);
    container.setDepth(this.layerToDepth('actor', startNode.y) - 0.5);
    container.setAlpha(0);
    this.tweens.add({ targets: container, alpha: 1, duration: 600, ease: 'Sine.Out' });

    // Floating name tag
    const shortLabel = `${nameTagPrefix}${label.slice(0, 14)}`;
    const nameTag = this.add.text(startNode.x, startNode.y - 36, shortLabel, {
      color: nameTagColor,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '13px',
      backgroundColor: nameTagBg,
      padding: { left: 5, right: 5, top: 3, bottom: 3 }
    });
    nameTag.setOrigin(0.5, 1);
    nameTag.setDepth(this.layerToDepth('fx_overlay') + 11);

    const agentActor: AgentActor = {
      id: runId,
      label,
      kind,
      container,
      body,
      route: [],
      activeZoneId: null,
      focusZoneId: null,
      workCursor: Math.floor(Math.random() * 100),
      nameTag,
      visualMode: 'idle',
      workingUntil: 0
    };

    // Set initial animation for subagents
    if (kind === 'subagent') {
      this.updateAgentActorVisual(agentActor, 'idle');
    }

    this.agentActors.push(agentActor);
  }

  public setAgentActorFocus(runId: string, focusZoneId: ResourcePartitionId | null): void {
    const actor = this.agentActors.find((a) => a.id === runId);
    if (!actor) return;
    if (actor.focusZoneId === focusZoneId) return;
    actor.focusZoneId = focusZoneId;
    // Clear current route so next tick picks up the new focus zone
    actor.route = [];
    actor.activeZoneId = null;
  }

  public despawnAgentActor(runId: string): void {
    const index = this.agentActors.findIndex((actor) => actor.id === runId);
    if (index === -1) {
      return;
    }
    const actor = this.agentActors[index];
    this.tweens.add({
      targets: actor.container,
      alpha: 0,
      duration: 400,
      ease: 'Sine.In',
      onComplete: () => {
        actor.container.destroy();
      }
    });
    actor.nameTag?.destroy();
    this.agentActors.splice(index, 1);
  }

  // Rooms considered "bottom floor" — exec-processes wander freely inside these
  private readonly BOTTOM_ROOM_IDS: ReadonlyArray<string> = ['document', 'agent', 'break_room'];

  private advanceAgentActor(actor: AgentActor, deltaMs: number): void {
    // Update name tag position
    if (actor.nameTag) {
      const bounds = actor.container.getBounds();
      actor.nameTag.setPosition(actor.container.x, bounds.top - 4);
    }

    if (actor.route.length === 0) {
      // Subagent visual: if working timer expired, revert to idle
      if (actor.kind === 'subagent') {
        const targetMode: WorkMode = actor.workingUntil > 0 && Date.now() < actor.workingUntil ? 'working' : 'idle';
        if (actor.visualMode !== targetMode) {
          actor.visualMode = targetMode;
          this.updateAgentActorVisual(actor, targetMode);
        }
      }

      // Pick next zone to wander to — exclude zones claimed by primary or other agents
      const claimedZones = new Set<string>();
      if (this.activeZoneId) {
        claimedZones.add(this.activeZoneId);
      }
      if (this.lastReachedZoneId) {
        claimedZones.add(this.lastReachedZoneId);
      }
      for (const other of this.agentActors) {
        if (other.id !== actor.id && other.activeZoneId) {
          claimedZones.add(other.activeZoneId);
        }
      }

      // exec-processes roam only inside the bottom-floor rooms (break_room / document / agent)
      // subagents roam wherever their focusZoneId points, or all zones
      const candidateZones = actor.kind === 'exec-process'
        ? this.protocols.mapLogic.workZones.filter(
            (zone) => this.BOTTOM_ROOM_IDS.includes(zone.id) && !claimedZones.has(zone.id)
          )
        : this.protocols.mapLogic.workZones.filter((zone) => !claimedZones.has(zone.id));

      const allZones = candidateZones.length > 0
        ? candidateZones
        : (actor.kind === 'exec-process'
            ? this.protocols.mapLogic.workZones.filter((zone) => this.BOTTOM_ROOM_IDS.includes(zone.id))
            : this.protocols.mapLogic.workZones);

      if (allZones.length === 0) {
        return;
      }

      // subagents: if they have a focusZoneId, always route there first
      const focusZone = actor.focusZoneId
        ? (allZones.find((z) => z.id === actor.focusZoneId) ?? allZones[actor.workCursor % allZones.length])
        : allZones[actor.workCursor % allZones.length];

      const zone = focusZone;
      actor.workCursor += 1;
      actor.activeZoneId = zone.id;

      const maskRoute = this.computeMaskRoute({ x: actor.container.x, y: actor.container.y }, zone.anchor);
      if (maskRoute && maskRoute.length > 0) {
        actor.route = maskRoute;
      } else {
        const route = computeRoute(
          this.protocols.mapLogic.walkGraph,
          { x: actor.container.x, y: actor.container.y },
          zone.anchor,
          this.protocols.mapLogic.collisionPolygons,
          this.protocols.mapLogic.walkableZones ?? [],
          (sample) => this.isWalkablePoint(sample)
        );
        actor.route = this.routePointsForTarget(route, zone.anchor);
      }

      if (actor.route.length === 0) {
        actor.activeZoneId = null;
      }
      return;
    }

    const target = actor.route[0];
    // exec-processes: slow drift (they're background tasks). subagents: calm walk.
    const speedPerMs = actor.kind === 'exec-process' ? 0.055 : 0.098;
    const step = speedPerMs * deltaMs;
    const dx = target.x - actor.container.x;
    const dy = target.y - actor.container.y;
    const distance = Math.hypot(dx, dy);

    if (actor.body instanceof Phaser.GameObjects.Sprite) {
      actor.body.setFlipX(dx < 0);
    }

    // Subagent: switch to moving animation while walking
    if (actor.kind === 'subagent' && actor.visualMode !== 'moving') {
      actor.visualMode = 'moving';
      this.updateAgentActorVisual(actor, 'moving');
    }

    if (distance <= step) {
      actor.container.x = target.x;
      actor.container.y = target.y;
      actor.container.setDepth(this.layerToDepth('actor', actor.container.y) - 0.5);
      actor.route.shift();

      if (actor.route.length === 0) {
        // Arrived — subagent plays working animation briefly, then idle
        if (actor.kind === 'subagent') {
          actor.visualMode = 'working';
          actor.workingUntil = Date.now() + 1400;
          this.updateAgentActorVisual(actor, 'working');
        }
        // linger briefly then clear zone so next frame picks new destination
        actor.activeZoneId = null;
      }
    } else {
      actor.container.x += (dx / distance) * step;
      actor.container.y += (dy / distance) * step;
      actor.container.setDepth(this.layerToDepth('actor', actor.container.y) - 0.5);
    }
  }

  public setLocale(nextLocale: UiLocale): void {
    this.locale = nextLocale;
    this.syncRoomLabels();
    this.drawWorkZones();
  }

  public setDebugVisualsVisible(visible: boolean): void {
    this.debugVisualsVisible = visible;
    this.applyDebugVisualLayerVisibility();
  }

  public getActorVariants(): Array<{ id: string; label: string }> {
    return this.resolveActorVariants().map((variant) => ({
      id: variant.id,
      label: variant.label
    }));
  }

  public getActorVariantId(): string | null {
    return this.resolveActorVariant()?.id ?? null;
  }

  public getActorVariantLabel(): string {
    return this.resolveActorVariant()?.label ?? 'Actor';
  }

  public setActorVariant(nextVariantId: string): void {
    const variant = this.resolveActorVariants().find((entry) => entry.id === nextVariantId);
    if (!variant) {
      return;
    }
    if (this.actorVariantId === variant.id) {
      return;
    }
    this.actorVariantId = variant.id;
    this.actorVisualSelectionByContext.clear();
    this.updateLobsterVisual(this.currentActorVisualMode());
  }

  private preloadSceneArt(): void {
    if ((this.protocols.sceneArt.globalLayers?.length ?? 0) === 0) {
      this.loadTextureAsset(LEGACY_BACKGROUND);
    }

    for (const layer of this.protocols.sceneArt.globalLayers ?? []) {
      this.loadTextureAsset(layer);
    }

    for (const slice of this.protocols.sceneArt.roomSlices) {
      for (const layer of slice.layers) {
        this.loadTextureAsset(layer);
      }
    }

    for (const variant of this.resolveActorVariants()) {
      for (const mode of variant.modes ?? []) {
        this.loadTextureAsset(mode);
      }
    }

    for (const ref of this.protocols.sceneArt.conceptRefs ?? []) {
      this.loadTextureAsset({
        textureKey: ref.id,
        path: ref.path,
        kind: 'image'
      });
    }
  }

  private loadTextureAsset(asset: {
    textureKey: string;
    path: string;
    kind?: 'image' | 'svg' | 'spritesheet';
    frameWidth?: number;
    frameHeight?: number;
    frameCount?: number;
    margin?: number;
    spacing?: number;
  }): void {
    if (this.textures.exists(asset.textureKey) || this.queuedTextureKeys.has(asset.textureKey)) {
      return;
    }
    this.queuedTextureKeys.add(asset.textureKey);

    const inferredKind = asset.kind ?? (asset.path.toLowerCase().endsWith('.svg') ? 'svg' : 'image');
    if (inferredKind === 'svg') {
      this.load.svg(asset.textureKey, asset.path);
      return;
    }

    if (inferredKind === 'spritesheet') {
      this.load.spritesheet(asset.textureKey, asset.path, {
        frameWidth: asset.frameWidth ?? 1,
        frameHeight: asset.frameHeight ?? 1,
        endFrame: Math.max(0, (asset.frameCount ?? 1) - 1),
        margin: asset.margin ?? 0,
        spacing: asset.spacing ?? 0
      });
      return;
    }

    this.load.image(asset.textureKey, asset.path);
  }

  private spawnLegacyBackground(): void {
    if (!this.textures.exists(LEGACY_BACKGROUND.textureKey)) {
      return;
    }

    this.legacyBackgroundImage = this.add.image(
      LEGACY_BACKGROUND.anchor.x,
      LEGACY_BACKGROUND.anchor.y,
      LEGACY_BACKGROUND.textureKey
    );
    this.legacyBackgroundImage.setDisplaySize(
      LEGACY_BACKGROUND.displaySize.width,
      LEGACY_BACKGROUND.displaySize.height
    );
    this.legacyBackgroundImage.setDepth(0);
  }

  private spawnSceneBaseArt(): void {
    this.legacyBackgroundImage = null;
    for (const rendered of this.renderedGlobalLayers) {
      rendered.shadowImage?.destroy();
      rendered.image.destroy();
    }
    this.renderedGlobalLayers = [];

    const globalLayers = this.protocols.sceneArt.globalLayers ?? [];
    if (globalLayers.length === 0) {
      this.spawnLegacyBackground();
      return;
    }

    for (const layer of globalLayers) {
      const baseDepth = this.layerToDepth(layer.renderLayer, layer.anchor.y) - (layer.renderLayer === 'floor' ? 0.5 : 0.1);
      const shadowImage = this.createLayerShadowImage(layer.textureKey, layer.renderLayer, layer.anchor, layer.displaySize, baseDepth);
      const image = this.add.image(layer.anchor.x, layer.anchor.y, layer.textureKey);
      image.setDisplaySize(layer.displaySize.width, layer.displaySize.height);
      image.setAlpha(layer.alpha ?? 1);
      image.setDepth(baseDepth);
      this.renderedGlobalLayers.push({ layer, shadowImage, image });
    }
    this.applyGlobalLayerTheme();
  }

  private applyGlobalLayerTheme(): void {
    const theme = this.getTheme();
    for (const rendered of this.renderedGlobalLayers) {
      rendered.shadowImage?.setTintFill(0x000000);
      if (rendered.layer.tintWithTheme) {
        rendered.image.setTint(theme.tint);
      } else {
        rendered.image.clearTint();
      }
    }
  }

  private hasSceneBaseArt(): boolean {
    return Boolean(this.legacyBackgroundImage) || this.renderedGlobalLayers.length > 0;
  }

  private cssColor(color: number, alpha: number): string {
    const rgb = Phaser.Display.Color.IntegerToRGB(color);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  private initializeWalkableMask(): void {
    const walkableRef = (this.protocols.sceneArt.conceptRefs ?? []).find((ref) => ref.id.includes('walkable-ref'));
    if (!walkableRef || !this.textures.exists(walkableRef.id)) {
      this.walkableMaskData = null;
      this.walkableMaskWidth = 0;
      this.walkableMaskHeight = 0;
      this.walkableGrid = null;
      this.walkableGridCols = 0;
      this.walkableGridRows = 0;
      return;
    }

    const sourceImage = this.textures.get(walkableRef.id).getSourceImage() as CanvasImageSource & { width: number; height: number };
    const canvas = document.createElement('canvas');
    canvas.width = sourceImage.width;
    canvas.height = sourceImage.height;
    const context = canvas.getContext('2d');
    if (!context) {
      this.walkableMaskData = null;
      this.walkableMaskWidth = 0;
      this.walkableMaskHeight = 0;
      return;
    }

    context.drawImage(sourceImage, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    this.walkableMaskData = imageData.data;
    this.walkableMaskWidth = canvas.width;
    this.walkableMaskHeight = canvas.height;
    this.initializeWalkableGrid();
    this.snapRuntimeAnchorsToWalkable();
  }

  private initializeWalkableGrid(): void {
    const baseWidth = this.protocols.mapLogic.meta.baseResolution.width;
    const baseHeight = this.protocols.mapLogic.meta.baseResolution.height;
    this.walkableGridCols = Math.ceil(baseWidth / this.walkableGridStep);
    this.walkableGridRows = Math.ceil(baseHeight / this.walkableGridStep);
    this.walkableGrid = new Uint8Array(this.walkableGridCols * this.walkableGridRows);

    for (let row = 0; row < this.walkableGridRows; row += 1) {
      for (let col = 0; col < this.walkableGridCols; col += 1) {
        const samplePoint = {
          x: Math.min(baseWidth - 1, col * this.walkableGridStep + this.walkableGridStep / 2),
          y: Math.min(baseHeight - 1, row * this.walkableGridStep + this.walkableGridStep / 2)
        };
        if (this.isWalkableByMask(samplePoint)) {
          this.walkableGrid[row * this.walkableGridCols + col] = 1;
        }
      }
    }
    this.reachableWalkableGrid = null;
  }

  private scenePointToBaseArtPixel(point: Point): { x: number; y: number } | null {
    const baseLayer = this.renderedGlobalLayers[0];
    const displayWidth = baseLayer?.image.displayWidth ?? this.legacyBackgroundImage?.displayWidth ?? 0;
    const displayHeight = baseLayer?.image.displayHeight ?? this.legacyBackgroundImage?.displayHeight ?? 0;
    const centerX = baseLayer?.image.x ?? this.legacyBackgroundImage?.x ?? 0;
    const centerY = baseLayer?.image.y ?? this.legacyBackgroundImage?.y ?? 0;
    if (!displayWidth || !displayHeight || !this.walkableMaskWidth || !this.walkableMaskHeight) {
      return null;
    }

    const left = centerX - displayWidth / 2;
    const top = centerY - displayHeight / 2;
    const normalizedX = (point.x - left) / displayWidth;
    const normalizedY = (point.y - top) / displayHeight;
    if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
      return null;
    }

    return {
      x: Math.max(0, Math.min(this.walkableMaskWidth - 1, Math.round(normalizedX * (this.walkableMaskWidth - 1)))),
      y: Math.max(0, Math.min(this.walkableMaskHeight - 1, Math.round(normalizedY * (this.walkableMaskHeight - 1))))
    };
  }

  private baseArtPixelToScenePoint(pixel: { x: number; y: number }): Point | null {
    const baseLayer = this.renderedGlobalLayers[0];
    const displayWidth = baseLayer?.image.displayWidth ?? this.legacyBackgroundImage?.displayWidth ?? 0;
    const displayHeight = baseLayer?.image.displayHeight ?? this.legacyBackgroundImage?.displayHeight ?? 0;
    const centerX = baseLayer?.image.x ?? this.legacyBackgroundImage?.x ?? 0;
    const centerY = baseLayer?.image.y ?? this.legacyBackgroundImage?.y ?? 0;
    if (!displayWidth || !displayHeight || !this.walkableMaskWidth || !this.walkableMaskHeight) {
      return null;
    }
    const left = centerX - displayWidth / 2;
    const top = centerY - displayHeight / 2;
    return {
      x: left + (pixel.x / (this.walkableMaskWidth - 1)) * displayWidth,
      y: top + (pixel.y / (this.walkableMaskHeight - 1)) * displayHeight
    };
  }

  private isWalkableByMask(point: Point): boolean | null {
    if (!this.walkableMaskData || !this.walkableMaskWidth || !this.walkableMaskHeight) {
      return null;
    }
    const pixel = this.scenePointToBaseArtPixel(point);
    if (!pixel) {
      return false;
    }
    const index = (pixel.y * this.walkableMaskWidth + pixel.x) * 4;
    const r = this.walkableMaskData[index];
    const g = this.walkableMaskData[index + 1];
    const b = this.walkableMaskData[index + 2];
    const a = this.walkableMaskData[index + 3];
    return a > 0 && r > 180 && g < 120 && b < 120;
  }

  private findNearestWalkablePoint(point: Point, maxSceneRadius = 140): Point | null {
    if (!this.walkableMaskData || !this.walkableMaskWidth || !this.walkableMaskHeight) {
      return null;
    }
    const origin = this.scenePointToBaseArtPixel(point);
    if (!origin) {
      return null;
    }

    const baseLayer = this.renderedGlobalLayers[0];
    const displayWidth = baseLayer?.image.displayWidth ?? this.legacyBackgroundImage?.displayWidth ?? 0;
    if (!displayWidth) {
      return null;
    }
    const scale = this.walkableMaskWidth / displayWidth;
    const maxRadius = Math.max(6, Math.round(maxSceneRadius * scale));
    let best: { x: number; y: number; dist: number } | null = null;

    for (let dy = -maxRadius; dy <= maxRadius; dy += 1) {
      const py = origin.y + dy;
      if (py < 0 || py >= this.walkableMaskHeight) {
        continue;
      }
      for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
        const px = origin.x + dx;
        if (px < 0 || px >= this.walkableMaskWidth) {
          continue;
        }
        const dist = dx * dx + dy * dy;
        if (dist > maxRadius * maxRadius || (best && dist >= best.dist)) {
          continue;
        }
        const index = (py * this.walkableMaskWidth + px) * 4;
        const r = this.walkableMaskData[index];
        const g = this.walkableMaskData[index + 1];
        const b = this.walkableMaskData[index + 2];
        const a = this.walkableMaskData[index + 3];
        if (a > 0 && r > 180 && g < 120 && b < 120) {
          best = { x: px, y: py, dist };
        }
      }
    }

    return best ? this.baseArtPixelToScenePoint(best) : null;
  }

  private resolveRequestedWalkTarget(point: Point, snapRadius = 72): Point | null {
    if (this.isWalkablePoint(point)) {
      return point;
    }
    const snapped = this.findNearestWalkablePoint(point, snapRadius);
    if (!snapped) {
      return null;
    }
    const distance = Math.hypot(snapped.x - point.x, snapped.y - point.y);
    return distance <= snapRadius ? snapped : null;
  }

  private snapRuntimeAnchorsToWalkable(): void {
    for (const node of this.protocols.mapLogic.walkGraph.nodes) {
      const snapped = this.findNearestWalkablePoint({ x: node.x, y: node.y }, 120);
      if (snapped) {
        node.x = Math.round(snapped.x);
        node.y = Math.round(snapped.y);
      }
    }

    for (const zone of this.protocols.mapLogic.workZones) {
      const snapped = this.findNearestWalkablePoint(zone.anchor, 120);
      if (snapped) {
        zone.anchor = { x: Math.round(snapped.x), y: Math.round(snapped.y) };
      }
    }
  }

  private routePointsForTarget(routeNodes: Point[], target: Point): Point[] {
    const route = routeNodes.map((node) => ({ x: node.x, y: node.y }));
    const tail = route.at(-1);
    if (!tail) {
      return route;
    }
    const alreadyAtTarget = Math.hypot(tail.x - target.x, tail.y - target.y) < 2;
    if (!alreadyAtTarget && this.isWalkablePoint(target)) {
      route.push({ x: target.x, y: target.y });
    }
    return route;
  }

  private gridIndex(col: number, row: number): number {
    return row * this.walkableGridCols + col;
  }

  private isWalkableCell(col: number, row: number): boolean {
    if (!this.walkableGrid || col < 0 || row < 0 || col >= this.walkableGridCols || row >= this.walkableGridRows) {
      return false;
    }
    return this.walkableGrid[this.gridIndex(col, row)] === 1;
  }

  private isReachableWalkableCell(col: number, row: number): boolean {
    if (!this.reachableWalkableGrid || col < 0 || row < 0 || col >= this.walkableGridCols || row >= this.walkableGridRows) {
      return false;
    }
    return this.reachableWalkableGrid[this.gridIndex(col, row)] === 1;
  }

  private scenePointToGrid(point: Point): { col: number; row: number } {
    return {
      col: Math.max(0, Math.min(this.walkableGridCols - 1, Math.floor(point.x / this.walkableGridStep))),
      row: Math.max(0, Math.min(this.walkableGridRows - 1, Math.floor(point.y / this.walkableGridStep)))
    };
  }

  private findNearestWalkableCell(point: Point, maxSceneRadius = 80): { col: number; row: number } | null {
    if (!this.walkableGrid) {
      return null;
    }
    const origin = this.scenePointToGrid(point);
    const maxRadius = Math.max(1, Math.ceil(maxSceneRadius / this.walkableGridStep));
    let best: { col: number; row: number; dist: number } | null = null;
    for (let dy = -maxRadius; dy <= maxRadius; dy += 1) {
      for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
        const col = origin.col + dx;
        const row = origin.row + dy;
        if (!this.isWalkableCell(col, row)) {
          continue;
        }
        const dist = dx * dx + dy * dy;
        if (best && dist >= best.dist) {
          continue;
        }
        best = { col, row, dist };
      }
    }
    return best ? { col: best.col, row: best.row } : null;
  }

  private gridToScenePoint(col: number, row: number): Point {
    return {
      x: Math.min(this.protocols.mapLogic.meta.baseResolution.width - 1, col * this.walkableGridStep + this.walkableGridStep / 2),
      y: Math.min(this.protocols.mapLogic.meta.baseResolution.height - 1, row * this.walkableGridStep + this.walkableGridStep / 2)
    };
  }

  private initializeReachableWalkableGrid(origin: Point): void {
    if (!this.walkableGrid) {
      this.reachableWalkableGrid = null;
      return;
    }
    this.reachableWalkableGrid = new Uint8Array(this.walkableGrid.length);
    const startPoint = this.resolveRequestedWalkTarget(origin, 140) ?? origin;
    const start = this.scenePointToGrid(startPoint);
    const queue: Array<{ col: number; row: number }> = [];
    if (this.isWalkableCell(start.col, start.row)) {
      this.reachableWalkableGrid[this.gridIndex(start.col, start.row)] = 1;
      queue.push(start);
    }

    const neighbors = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ] as const;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const [dx, dy] of neighbors) {
        const nextCol = current.col + dx;
        const nextRow = current.row + dy;
        if (!this.isWalkableCell(nextCol, nextRow) || this.isReachableWalkableCell(nextCol, nextRow)) {
          continue;
        }
        if (dx !== 0 && dy !== 0) {
          if (!this.isWalkableCell(current.col + dx, current.row) || !this.isWalkableCell(current.col, current.row + dy)) {
            continue;
          }
        }
        this.reachableWalkableGrid[this.gridIndex(nextCol, nextRow)] = 1;
        queue.push({ col: nextCol, row: nextRow });
      }
    }
  }

  private snapWorkZonesToReachableWalkable(origin: Point): void {
    this.initializeReachableWalkableGrid(origin);
    if (!this.reachableWalkableGrid) {
      return;
    }

    for (const zone of this.protocols.mapLogic.workZones) {
      const room = this.protocols.mapLogic.rooms.find((candidate) => candidate.id === zone.id);
      const labelAnchor = room?.labelAnchor ?? (room ? {
        x: room.bounds[0] + room.bounds[2] / 2,
        y: room.bounds[1] + 20
      } : zone.anchor);
      const preferredTarget = zone.anchor;
      let best: { point: Point; dist: number } | null = null;

      for (let row = 0; row < this.walkableGridRows; row += 1) {
        for (let col = 0; col < this.walkableGridCols; col += 1) {
          if (!this.isReachableWalkableCell(col, row)) {
            continue;
          }
          const point = this.gridToScenePoint(col, row);
          if (room) {
            const [x, y, width, height] = room.bounds;
            const margin = 18;
            if (point.x < x + margin || point.x > x + width - margin || point.y < y + margin || point.y > y + height - margin) {
              continue;
            }
          }
          const dist = Phaser.Math.Distance.Between(point.x, point.y, preferredTarget.x, preferredTarget.y);
          const belowPenalty = point.y < labelAnchor.y + 20 ? 500 : 0;
          const sidePenalty = Math.abs(point.x - preferredTarget.x) * 0.15;
          const score = dist + belowPenalty + sidePenalty;
          if (!best || score < best.dist) {
            best = { point, dist: score };
          }
        }
      }

      if (best) {
        zone.anchor = { x: Math.round(best.point.x), y: Math.round(best.point.y) };
      }
    }
  }

  private simplifyRoute(points: Point[]): Point[] {
    if (points.length <= 2) {
      return points;
    }
    const simplified: Point[] = [points[0]];
    for (let index = 1; index < points.length - 1; index += 1) {
      const prev = simplified[simplified.length - 1];
      const current = points[index];
      const next = points[index + 1];
      const dx1 = Math.sign(current.x - prev.x);
      const dy1 = Math.sign(current.y - prev.y);
      const dx2 = Math.sign(next.x - current.x);
      const dy2 = Math.sign(next.y - current.y);
      if (dx1 !== dx2 || dy1 !== dy2) {
        simplified.push(current);
      }
    }
    simplified.push(points[points.length - 1]);
    return simplified;
  }

  private segmentWalkableOnMask(from: Point, to: Point): boolean {
    const samples = Math.max(8, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 12));
    for (let index = 0; index <= samples; index += 1) {
      const t = index / samples;
      const point = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t
      };
      if (!this.isWalkablePoint(point)) {
        return false;
      }
    }
    return true;
  }

  private simplifyRouteBySight(points: Point[]): Point[] {
    if (points.length <= 2) {
      return points;
    }
    const simplified: Point[] = [points[0]];
    let anchorIndex = 0;

    while (anchorIndex < points.length - 1) {
      let nextIndex = points.length - 1;
      while (nextIndex > anchorIndex + 1) {
        if (this.segmentWalkableOnMask(points[anchorIndex], points[nextIndex])) {
          break;
        }
        nextIndex -= 1;
      }
      simplified.push(points[nextIndex]);
      anchorIndex = nextIndex;
    }

    return simplified;
  }

  private computeMaskRoute(from: Point, to: Point): Point[] | null {
    if (!this.walkableGrid || this.walkableGridCols === 0 || this.walkableGridRows === 0) {
      return null;
    }
    const startPoint = this.isWalkablePoint(from) ? from : this.findNearestWalkablePoint(from, 140);
    const endPoint = this.isWalkablePoint(to) ? to : this.findNearestWalkablePoint(to, 140);
    if (!startPoint || !endPoint) {
      return null;
    }

    const start = this.findNearestWalkableCell(startPoint, 80) ?? this.scenePointToGrid(startPoint);
    const end = this.findNearestWalkableCell(endPoint, 80) ?? this.scenePointToGrid(endPoint);
    const startKey = `${start.col},${start.row}`;
    const endKey = `${end.col},${end.row}`;
    const open = [startKey];
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startKey, 0]]);
    const fScore = new Map<string, number>([[startKey, Math.hypot(end.col - start.col, end.row - start.row)]]);

    const neighborOffsets = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ] as const;

    const parseKey = (key: string) => {
      const [col, row] = key.split(',').map(Number);
      return { col, row };
    };

    while (open.length > 0) {
      open.sort((left, right) => (fScore.get(left) ?? Infinity) - (fScore.get(right) ?? Infinity));
      const currentKey = open.shift();
      if (!currentKey) {
        break;
      }
      if (currentKey === endKey) {
        const reversed: Point[] = [endPoint];
        let cursor: string | undefined = currentKey;
        while (cursor) {
          const { col, row } = parseKey(cursor);
          reversed.push(this.gridToScenePoint(col, row));
          cursor = cameFrom.get(cursor);
        }
        reversed.push(startPoint);
        return this.simplifyRouteBySight(this.simplifyRoute(reversed.reverse()));
      }

      const current = parseKey(currentKey);
      for (const [dx, dy] of neighborOffsets) {
        const nextCol = current.col + dx;
        const nextRow = current.row + dy;
        if (!this.isWalkableCell(nextCol, nextRow)) {
          continue;
        }
        if (dx !== 0 && dy !== 0) {
          if (!this.isWalkableCell(current.col + dx, current.row) || !this.isWalkableCell(current.col, current.row + dy)) {
            continue;
          }
        }
        const nextKey = `${nextCol},${nextRow}`;
        const stepCost = dx !== 0 && dy !== 0 ? 1.414 : 1;
        const tentative = (gScore.get(currentKey) ?? Infinity) + stepCost;
        if (tentative >= (gScore.get(nextKey) ?? Infinity)) {
          continue;
        }
        cameFrom.set(nextKey, currentKey);
        gScore.set(nextKey, tentative);
        fScore.set(nextKey, tentative + Math.hypot(end.col - nextCol, end.row - nextRow));
        if (!open.includes(nextKey)) {
          open.push(nextKey);
        }
      }
    }

    return null;
  }

  private drawRooms(): void {
    const theme = this.getTheme();
    this.roomLayer.clear();
    const hasBaseArt = this.hasSceneBaseArt();

    const slicedFloorRooms = new Set(
      this.protocols.sceneArt.roomSlices
        .filter((slice) => slice.replacesLayers.includes('floor'))
        .map((slice) => slice.roomId)
    );

    for (const room of this.protocols.mapLogic.rooms) {
      const [x, y, width, height] = room.bounds;
      const resource = this.telemetryResources.get(room.id);
      const accent = PARTITION_COLORS[room.id];
      const isFocus = this.focusResourceId === room.id;
      const status = resource?.status ?? (room.id === 'break_room' ? 'idle' : 'offline');
      const suppressStatusRoomOverlay = room.id === 'alarm' || room.id === 'gateway';
      const fillAlpha = hasBaseArt ? 0 : (slicedFloorRooms.has(room.id) ? 0.14 : 0.92);

      this.roomLayer.fillStyle(theme.roomFill, fillAlpha);
      this.roomLayer.fillRect(x, y, width, height);

      const overlayAlpha = hasBaseArt
        ? (
            status === 'alert' && !suppressStatusRoomOverlay
              ? 0.1
              : status === 'active' && !suppressStatusRoomOverlay
                ? 0.05
                : isFocus
                  ? 0.035
                  : 0
          )
        : (
            status === 'alert' && !suppressStatusRoomOverlay
              ? 0.2
              : status === 'active' && !suppressStatusRoomOverlay
                ? 0.12
                : room.id === 'break_room'
                  ? 0.08
                  : 0.04
          );
      this.roomLayer.fillStyle(accent, overlayAlpha);
      if (overlayAlpha > 0) {
        this.roomLayer.fillRect(x, y, width, height);
      }

      const strokeColor = status === 'alert' && !suppressStatusRoomOverlay ? 0xffa0ad : isFocus ? accent : theme.roomStroke;
      const strokeWidth = isFocus ? 4 : hasBaseArt ? 1.1 : 2;
      const strokeAlpha = hasBaseArt
        ? (
            isFocus
              ? 0.72
              : status === 'alert' && !suppressStatusRoomOverlay
                ? 0.32
                : status === 'active' && !suppressStatusRoomOverlay
                  ? 0.16
                  : 0.06
          )
        : 0.96;
      if (!hasBaseArt || isFocus || ((status === 'active' || status === 'alert') && !suppressStatusRoomOverlay)) {
        this.roomLayer.lineStyle(strokeWidth, strokeColor, strokeAlpha);
        this.roomLayer.strokeRect(x, y, width, height);
      }
    }

    if (this.protocols.mapLogic.walkableZones?.length) {
      this.roomLayer.lineStyle(2, 0xffffff, 0.06);
      this.roomLayer.fillStyle(0xffffff, 0.02);
      for (const zone of this.protocols.mapLogic.walkableZones) {
        if (zone.points.length < 3) {
          continue;
        }
        this.roomLayer.beginPath();
        this.roomLayer.moveTo(zone.points[0].x, zone.points[0].y);
        for (let index = 1; index < zone.points.length; index += 1) {
          this.roomLayer.lineTo(zone.points[index].x, zone.points[index].y);
        }
        this.roomLayer.closePath();
        this.roomLayer.fillPath();
        this.roomLayer.strokePath();
      }
    }
    this.applyDebugVisualLayerVisibility();
  }

  private initializeRoomLabels(): void {
    for (const room of this.protocols.mapLogic.rooms) {
      if (room.id === 'task_queues') {
        continue;
      }
      const [x, y, width] = room.bounds;
      const titleX = room.labelAnchor?.x ?? x + width / 2;
      const titleY = room.labelAnchor?.y ?? y + 18;
      const labelColor = this.cssColor(PARTITION_COLORS[room.id], 1);
      const backplate = this.add.graphics();
      backplate.setDepth(this.getRenderLayerDepth('mid_props') + 3.5);
      this.roomTitleBackplates.set(room.id, backplate);

      const title = this.add.text(titleX, titleY, resourceLabel(room.id, this.locale), {
        color: labelColor,
        fontFamily: this.displayFontFamily(),
        fontSize: '24px',
        fontStyle: '400',
        align: 'center'
      });
      title.setOrigin(0.5, 0);
      title.setPadding(10, 1, 10, 0);
      title.setStroke('#05100e', 4);
      title.setShadow(0, 0, '#010403', 4, false, true);
      title.setDepth(this.getRenderLayerDepth('mid_props') + 4);
      title.setInteractive({ useHandCursor: true });
      title.on('pointerover', () => {
        this.hoveredRoomId = room.id;
        this.syncRoomLabels();
      });
      title.on('pointerout', () => {
        if (this.hoveredRoomId === room.id) {
          this.hoveredRoomId = null;
          this.syncRoomLabels();
        }
      });
      title.on('pointerdown', (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.emitResourceSelection(room.id, { x: titleX, y: titleY + title.displayHeight / 2 });
      });
      this.roomTitleLabels.set(room.id, title);
    }
  }

  private syncRoomLabels(): void {
    for (const room of this.protocols.mapLogic.rooms) {
      const backplate = this.roomTitleBackplates.get(room.id);
      const title = this.roomTitleLabels.get(room.id);
      const telemetry = this.telemetryResources.get(room.id);
      const isFocus = this.focusResourceId === room.id;

      if (title) {
        const isHovered = this.hoveredRoomId === room.id;
        title.setText(resourceLabel(room.id, this.locale));
        title.setFontFamily(this.displayFontFamily());
        title.setColor(
          isHovered
            ? '#f6fff9'
            : telemetry?.status === 'offline'
            ? '#8ca197'
            : telemetry?.status === 'alert'
              ? '#ffd5de'
              : isFocus
                ? '#ffffff'
                : this.cssColor(PARTITION_COLORS[room.id], 1)
        );
        title.setScale(isHovered ? 1.045 : 1);
        title.setDepth(this.getRenderLayerDepth('mid_props') + (isHovered ? 5 : 4));
        title.setShadow(0, 0, isHovered ? this.cssColor(PARTITION_COLORS[room.id], 0.72) : '#010403', isHovered ? 8 : 4, false, true);
        if (backplate) {
          const fillColor = isHovered
            ? PARTITION_COLORS[room.id]
            : telemetry?.status === 'alert'
              ? 0x4e191f
              : isFocus
                ? PARTITION_COLORS[room.id]
                : 0x102622;
          const fillAlpha = isHovered
            ? 0.34
            : telemetry?.status === 'alert'
              ? 0.62
              : isFocus
                ? 0.22
                : room.id === 'memory' || room.id === 'document'
                  ? 0.5
                  : 0.34;
          this.drawRoomTitleBackplate(backplate, title, fillColor, fillAlpha);
        }
      }
    }
  }

  private drawRoomTitleBackplate(
    backplate: Phaser.GameObjects.Graphics,
    title: Phaser.GameObjects.Text,
    fillColor: number,
    fillAlpha: number
  ): void {
    const bounds = title.getBounds();
    const padX = 6;
    const padY = 3;
    backplate.clear();
    backplate.fillStyle(fillColor, fillAlpha);
    backplate.fillRoundedRect(bounds.x - padX, bounds.y - padY, bounds.width + padX * 2, bounds.height + padY * 2, 12);
    backplate.lineStyle(1, 0xffffff, 0.05);
    backplate.strokeRoundedRect(bounds.x - padX, bounds.y - padY, bounds.width + padX * 2, bounds.height + padY * 2, 12);
    backplate.setDepth(title.depth - 0.1);
    backplate.setAlpha(1);
    backplate.setVisible(true);
  }

  private emitResourceSelection(resourceId: ResourcePartitionId, anchor?: Point): void {
    const payload: ResourceSelectEvent = { resourceId };
    if (anchor) {
      payload.anchor = anchor;
    }
    this.events.emit('select-resource', payload);
  }

  private spawnRoomSlices(): void {
    for (const renderedLayer of this.renderedRoomSlices) {
      renderedLayer.shadowImage?.destroy();
      renderedLayer.image.destroy();
    }
    this.renderedRoomSlices = [];

    for (const slice of this.protocols.sceneArt.roomSlices) {
      for (const layer of slice.layers) {
        const baseDepth = this.layerToDepth(layer.renderLayer, layer.anchor.y);
        const shadowImage = this.createLayerShadowImage(layer.textureKey, layer.renderLayer, layer.anchor, layer.displaySize, baseDepth);
        const image = this.add.image(layer.anchor.x, layer.anchor.y, layer.textureKey);
        image.setDisplaySize(layer.displaySize.width, layer.displaySize.height);
        image.setAlpha(layer.alpha ?? 1);
        image.setDepth(baseDepth);
        this.renderedRoomSlices.push({ slice, layer, shadowImage, image });
      }
    }

    this.applyRoomSliceTheme();
  }

  private applyRoomSliceTheme(): void {
    const theme = this.getTheme();
    for (const renderedLayer of this.renderedRoomSlices) {
      renderedLayer.shadowImage?.setTintFill(0x000000);
      if (renderedLayer.layer.tintWithTheme) {
        renderedLayer.image.setTint(theme.tint);
      } else {
        renderedLayer.image.clearTint();
      }
    }
  }

  private createLayerShadowImage(
    textureKey: string,
    renderLayer: SceneGlobalLayerDef['renderLayer'] | RoomSliceLayerDef['renderLayer'],
    anchor: Point,
    displaySize: { width: number; height: number },
    baseDepth: number
  ): Phaser.GameObjects.Image | null {
    if (renderLayer !== 'mid_props') {
      return null;
    }
    if (!this.textures.exists(textureKey)) {
      return null;
    }
    const shadow = this.add.image(anchor.x + PROP_SHADOW_OFFSET.x, anchor.y + PROP_SHADOW_OFFSET.y, textureKey);
    shadow.setDisplaySize(displaySize.width, displaySize.height);
    shadow.setTintFill(0x000000);
    shadow.setAlpha(PROP_SHADOW_ALPHA);
    shadow.setDepth(baseDepth - 0.08);
    return shadow;
  }

  private drawOccluders(): void {
    this.occluderLayer.clear();
    const theme = this.getTheme();
    this.occluderLayer.fillStyle(theme.tint, 0.36);

    for (const occluder of this.protocols.mapLogic.occluders) {
      if (this.isOccluderHandledBySlice(occluder.x, occluder.y, occluder.width, occluder.height)) {
        continue;
      }
      this.occluderLayer.fillRect(occluder.x, occluder.y, occluder.width, occluder.height);
    }
  }

  private initializeWorkZones(): void {
    for (const zone of this.protocols.mapLogic.workZones) {
      this.zoneState.set(zone.id, 'idle');
      const label = this.add.text(zone.anchor.x, zone.anchor.y + zone.radius + 8, `${zone.label}\nidle`, {
        color: '#9eb8ff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        fontSize: '11px',
        align: 'center'
      });
      label.setOrigin(0.5, 0);
      label.setDepth(this.getRenderLayerDepth('mid_props') + 6);
      this.zoneLabels.set(zone.id, label);
    }
    this.drawWorkZones();
  }

  private drawWorkZones(): void {
    this.zoneLayer.clear();

    for (const zone of this.protocols.mapLogic.workZones) {
      const state = this.zoneState.get(zone.id) ?? 'idle';
      const resource = this.telemetryResources.get(zone.id);
      const baseColor = PARTITION_COLORS[zone.id];

      if (state === 'working') {
        this.zoneLayer.fillStyle(baseColor, 0.56);
        this.zoneLayer.lineStyle(3, 0xffffff, 0.96);
      } else if (state === 'moving') {
        this.zoneLayer.fillStyle(baseColor, 0.38);
        this.zoneLayer.lineStyle(2, 0xf3f6ff, 0.92);
      } else if (state === 'done') {
        this.zoneLayer.fillStyle(baseColor, 0.28);
        this.zoneLayer.lineStyle(2, 0xcbffea, 0.95);
      } else if (resource?.status === 'alert') {
        this.zoneLayer.fillStyle(baseColor, 0.34);
        this.zoneLayer.lineStyle(2, 0xffd5dc, 0.98);
      } else if (resource?.status === 'active') {
        this.zoneLayer.fillStyle(baseColor, 0.22);
        this.zoneLayer.lineStyle(2, baseColor, 0.94);
      } else {
        this.zoneLayer.fillStyle(baseColor, 0.14);
        this.zoneLayer.lineStyle(2, baseColor, 0.84);
      }

      this.zoneLayer.fillCircle(zone.anchor.x, zone.anchor.y, zone.radius);
      this.zoneLayer.strokeCircle(zone.anchor.x, zone.anchor.y, zone.radius);

      const label = this.zoneLabels.get(zone.id);
      if (label) {
        const statusText =
          state === 'working'
            ? 'accessing'
            : state === 'moving'
              ? 'routing'
              : resource?.status === 'alert'
                ? 'alert'
                : resource?.status === 'active'
                  ? `live · ${resource.itemCount}`
                  : zone.id === 'break_room'
                    ? 'rest'
                    : 'idle';
        if (this.hasSceneBaseArt()) {
          label.setText('');
          label.setVisible(false);
        } else {
          label.setVisible(true);
          label.setText(`${resourceLabel(zone.id, this.locale)}\n${statusText}`);
          label.setColor(state === 'working' ? '#ffffff' : resource?.status === 'alert' ? '#ffd8e0' : '#9eb8ff');
        }
      }
    }
    this.applyDebugVisualLayerVisibility();
  }

  private applyDebugVisualLayerVisibility(): void {
    this.roomLayer.setVisible(this.debugVisualsVisible);
    this.zoneLayer.setVisible(this.debugVisualsVisible);
    this.occluderLayer.setVisible(this.debugVisualsVisible);
  }

  private spawnAssets(): void {
    for (const asset of this.protocols.assetManifest.assets) {
      const colorByKind = {
        book: 0xa9d0ff,
        tool: 0x91f0cc,
        art: 0xf6c48f,
        marker: 0xc8a4ff
      } as const;

      const width = asset.displaySize?.width ?? asset.size.width;
      const height = asset.displaySize?.height ?? asset.size.height;
      const drawPoint = asset.footpoint ?? asset.anchor;
      const body = this.add.rectangle(asset.anchor.x, asset.anchor.y, width, height, colorByKind[asset.kind], 0.92);
      body.setDepth(this.layerToDepth(asset.layer, drawPoint.y, asset.depthBand));
      body.setStrokeStyle(2, 0x223050, 0.82);
      if (asset.roomId === 'break_room') {
        body.setFillStyle(0xd5b798, 0.92);
      }
      if (this.hasSceneBaseArt() || this.roomHasSliceLayer(asset.roomId, 'mid_props')) {
        body.setVisible(false);
      }
      this.renderedAssets.push({ def: asset, body, pulseTween: null });
    }
  }

  private spawnLobster(): void {
    const firstNode =
      this.protocols.mapLogic.walkGraph.nodes.find((node) => node.id === 'BR1')
      ?? this.protocols.mapLogic.walkGraph.nodes[0];
    const children: Phaser.GameObjects.GameObject[] = [];
    const actor = this.protocols.sceneArt.actor;
    const variant = this.resolveActorVariant();

    if (actor?.shadow) {
      const shadow = this.add.ellipse(0, actor.shadow.offsetY, actor.shadow.width, actor.shadow.height, 0x081018, actor.shadow.alpha);
      children.push(shadow);
    }

    const idleVisual = this.resolveActorMode('idle');
    if (actor && variant && idleVisual) {
      const sprite = this.add.sprite(actor.anchorOffset?.x ?? 0, actor.anchorOffset?.y ?? 0, idleVisual.textureKey);
      sprite.setDisplaySize(actor.displaySize.width, actor.displaySize.height);
      children.push(sprite);
      this.lobsterBody = sprite;
    } else {
      const fallback = this.add.circle(0, 0, 16, 0xff6f48, 1);
      fallback.setStrokeStyle(3, 0x2a0f05, 0.8);
      children.push(fallback);
      this.lobsterBody = fallback;
    }

    this.lobster = this.add.container(firstNode.x, firstNode.y, children);
    this.lobster.setDepth(this.layerToDepth('actor', firstNode.y));
    this.lastReachedZoneId = firstNode.roomId;
    this.updateLobsterVisual('idle');

    // Context bar — lives inside the lobster container, drawn above the sprite
    this.lobsterContextBar = this.add.graphics();
    this.lobsterContextBar.setRotation(-5 * (Math.PI / 180)); // level the bar (~-5 deg)
    this.lobster.add(this.lobsterContextBar);
    this.drawContextBar(1); // starts full/green
  }

  private spawnAmbientPropFx(): void {
    const alarmPositions = [
      { x: 1625, y: 88 },
      { x: 1712, y: 92 },
      { x: 1794, y: 104 },
      { x: 1848, y: 142 }
    ];
    alarmPositions.forEach((position, index) => {
      const glow = this.add.circle(position.x, position.y, 12, 0xff4b5f, 0.12);
      glow.setDepth(this.layerToDepth('mid_props', position.y) + 1.6);
      glow.setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: glow,
        alpha: { from: 0.08, to: 0.3 },
        scaleX: { from: 0.9, to: 1.5 },
        scaleY: { from: 0.9, to: 1.5 },
        duration: 760,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.InOut',
        delay: index * 120
      });
      this.ambientPropFx.push(glow);
    });

    const steamOffsets = [0, 24, 48];
    steamOffsets.forEach((offset, index) => {
      const puff = this.add.ellipse(1655 + offset, 751, 18, 28, 0xcfe7df, 0.22);
      puff.setDepth(this.layerToDepth('mid_props', 751) + 1.4);
      this.tweens.add({
        targets: puff,
        y: puff.y - 28,
        x: puff.x + (index % 2 === 0 ? -8 : 8),
        alpha: { from: 0.26, to: 0 },
        scaleX: { from: 0.9, to: 1.26 },
        scaleY: { from: 0.9, to: 1.38 },
        duration: 2100,
        repeat: -1,
        delay: index * 520,
        ease: 'Sine.Out'
      });
      this.ambientPropFx.push(puff);
    });

    const ledPositions = [
      { x: 1008, y: 176, color: 0x7dff8a },
      { x: 1008, y: 198, color: 0x8efff3 },
      { x: 1096, y: 176, color: 0x7dff8a },
      { x: 1096, y: 198, color: 0xffcf63 },
      { x: 1710, y: 482, color: 0x7dff8a },
      { x: 1710, y: 506, color: 0xffcf63 }
    ];
    ledPositions.forEach((position, index) => {
      const led = this.add.rectangle(position.x, position.y, 8, 5, position.color, 0.3);
      led.setDepth(this.layerToDepth('mid_props', position.y) + 1.3);
      this.tweens.add({
        targets: led,
        alpha: { from: 0.14, to: 0.88 },
        duration: 420 + index * 20,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.InOut',
        delay: index * 140
      });
      this.ambientPropFx.push(led);
    });
  }

  private handlePointerDown(x: number, y: number): void {
    const point = { x, y };
    const hitAsset = this.findHitAsset(point);

    if (hitAsset) {
      this.emitResourceSelection(hitAsset.roomId, point);
      this.drawHitOverlay(hitAsset);
      return;
    }

    this.hitLayer.clear();

    const hitZone = this.findWorkZone(point);
    if (hitZone) {
      this.emitResourceSelection(hitZone.id, hitZone.anchor);
      return;
    }

    const hitRoom = this.findRoomByPoint(point);
    if (hitRoom) {
      this.emitResourceSelection(hitRoom.id, hitRoom.labelAnchor ?? point);
    }
  }

  private advanceLobster(deltaMs: number): void {
    if (this.lobsterRoute.length === 0) {
      this.updateLobsterVisual(this.workMode === 'working' ? 'working' : 'idle');
      return;
    }

    const target = this.lobsterRoute[0];
    const speedPerMs = 0.32;
    const step = speedPerMs * deltaMs;

    const dx = target.x - this.lobster.x;
    const dy = target.y - this.lobster.y;
    const distance = Math.hypot(dx, dy);

    if (this.lobsterBody instanceof Phaser.GameObjects.Sprite) {
      this.lobsterBody.setFlipX(dx < 0);
    }

    if (distance <= step) {
      this.lobster.x = target.x;
      this.lobster.y = target.y;
      this.lobster.setDepth(this.layerToDepth('actor', this.lobster.y));
      this.lobsterRoute.shift();

      if (this.lobsterRoute.length === 0 && this.activeZoneId && this.workMode === 'moving') {
        this.startWorking(this.activeZoneId);
      } else if (this.lobsterRoute.length === 0 && !this.activeZoneId) {
        this.workMode = 'idle';
        this.lastOutput = this.materializeOutput(this.resolveStateProfile('idle'), {
          resourceId: this.focusResourceId,
          detailOverride: 'manual route completed'
        });
        this.updateLobsterVisual('idle');
        this.syncWorkStatus();
        this.maybeProcessTelemetryQueue();
      }
      return;
    }

    this.lobster.x += (dx / distance) * step;
    this.lobster.y += (dy / distance) * step;
    this.lobster.setDepth(this.layerToDepth('actor', this.lobster.y));
    this.updateLobsterVisual('moving');
  }

  private beginWorkRoute(zone: WorkZone, routeContext?: RouteContext): void {
    this.clearZoneStates();
    this.zoneState.set(zone.id, 'moving');
    this.drawWorkZones();

    this.activeZoneId = zone.id;
    this.workMode = 'moving';
    this.pendingStateProfile = this.pickStateProfile(zone.type);
    this.pendingRouteContext = routeContext ?? {
      resourceId: zone.id,
      detail: `routing into ${zone.label.toLowerCase()}`
    };

    this.lastOutput = this.materializeOutput(this.pendingStateProfile, {
      resourceId: this.pendingRouteContext.resourceId,
      detailOverride: `moving to ${zone.label} · ${this.pendingRouteContext.detail}`
    });

    const maskRoute = this.computeMaskRoute({ x: this.lobster.x, y: this.lobster.y }, zone.anchor);
    if (maskRoute && maskRoute.length > 0) {
      this.lobsterRoute = maskRoute;
    } else {
      const route = computeRoute(
        this.protocols.mapLogic.walkGraph,
        { x: this.lobster.x, y: this.lobster.y },
        zone.anchor,
        this.protocols.mapLogic.collisionPolygons,
        this.protocols.mapLogic.walkableZones ?? [],
        (sample) => this.isWalkablePoint(sample)
      );
      this.lobsterRoute = this.routePointsForTarget(route, zone.anchor);
    }
    this.updateLobsterVisual('moving');

    if (this.lobsterRoute.length === 0) {
      this.startWorking(zone.id);
    }

    this.syncWorkStatus();
  }

  private startWorking(zoneId: ResourcePartitionId): void {
    this.clearZoneStates();
    this.zoneState.set(zoneId, 'working');
    this.drawWorkZones();

    this.workMode = 'working';
    this.lastReachedZoneId = zoneId;

    const zone = this.protocols.mapLogic.workZones.find((item) => item.id === zoneId);
    const profile = zone ? this.pendingStateProfile ?? this.pickStateProfile(zone.type) : this.resolveStateProfile('executing');
    const routeContext = this.pendingRouteContext ?? {
      resourceId: zoneId,
      detail: zone ? `accessing ${zone.label.toLowerCase()}` : 'running task'
    };

    this.lastOutput = this.materializeOutput(profile, {
      resourceId: routeContext.resourceId,
      detailOverride: routeContext.detail
    });
    this.updateLobsterVisual('working');
    this.updateResourceAnimations();
    this.syncWorkStatus();

    this.tweens.add({
      targets: this.lobster,
      scaleX: { from: 1, to: 1.08 },
      scaleY: { from: 1, to: 1.08 },
      yoyo: true,
      duration: 260,
      repeat: zoneId === 'break_room' ? 5 : 3,
      ease: 'Sine.InOut'
    });

    if (/(alert|blocked|failed|error|alarm)/i.test(this.lastOutput.content)) {
      this.tweens.add({
        targets: this.lobster,
        angle: { from: -4, to: 4 },
        yoyo: true,
        repeat: 7,
        duration: 80,
        ease: 'Sine.InOut'
      });
    }

    this.time.delayedCall(zoneId === 'break_room' ? 2100 : 1500, () => this.finishWorking(zoneId));
  }

  private finishWorking(zoneId: ResourcePartitionId): void {
    this.clearZoneStates();
    this.zoneState.set(zoneId, 'done');
    this.drawWorkZones();

    this.activeZoneId = null;
    this.pendingStateProfile = null;
    this.pendingRouteContext = null;
    this.workMode = 'idle';

    if (zoneId === 'break_room') {
      this.lastOutput = this.materializeOutput(this.resolveStateProfile('resting'), {
        resourceId: 'break_room',
        detailOverride: this.focusDetail || 'cooling claws in the break room'
      });
      this.updateLobsterVisual('idle');
      this.updateResourceAnimations();
      this.syncWorkStatus();
      return;
    }

    const zone = this.protocols.mapLogic.workZones.find((item) => item.id === zoneId);
    const completionProfile = zone ? this.pickStateProfile(zone.type) : this.resolveStateProfile('documenting');
    this.lastOutput = this.materializeOutput(completionProfile, {
      resourceId: zoneId,
      detailOverride: `access completed in ${this.zoneLabel(zoneId)}`
    });

    this.celebrationUntil = Date.now() + 2200;
    this.updateLobsterVisual('idle');
    this.updateResourceAnimations();
    this.syncWorkStatus();

    this.tweens.add({
      targets: this.lobster,
      y: { from: this.lobster.y, to: this.lobster.y - 10 },
      yoyo: true,
      duration: 180,
      repeat: 1,
      ease: 'Quad.Out'
    });

    this.time.delayedCall(900, () => {
      this.clearZoneStates();
      this.drawWorkZones();
      this.lastOutput = this.materializeOutput(this.resolveStateProfile('idle'), {
        resourceId: this.focusResourceId,
        detailOverride: 'waiting for the next access'
      });
      this.syncWorkStatus();
      this.maybeProcessTelemetryQueue();
    });
  }

  private maybeProcessTelemetryQueue(): void {
    if (this.workMode === 'working' || this.lobsterRoute.length > 0 || this.activeZoneId) {
      return;
    }

    const nextEvent = this.telemetryQueue.shift();
    if (nextEvent) {
      const zone = this.protocols.mapLogic.workZones.find((item) => item.id === nextEvent.resourceId);
      if (zone) {
        this.beginWorkRoute(zone, {
          resourceId: nextEvent.resourceId,
          detail: nextEvent.detail,
          source: nextEvent.source,
          status: nextEvent.status
        });
      }
      return;
    }

    if (this.liveMode !== 'live') {
      return;
    }

    if (this.focusResourceId === 'break_room') {
      if (this.lastReachedZoneId !== 'break_room') {
        const breakZone = this.protocols.mapLogic.workZones.find((item) => item.id === 'break_room');
        if (breakZone) {
          this.beginWorkRoute(breakZone, {
            resourceId: 'break_room',
            detail: this.focusDetail || 'system quiet, lobster cooling claws'
          });
        }
        return;
      }

      if (this.lastOutput.stateId !== 'resting') {
        this.clearZoneStates();
        this.drawWorkZones();
        this.lastOutput = this.materializeOutput(this.resolveStateProfile('resting'), {
          resourceId: 'break_room',
          detailOverride: this.focusDetail || 'system quiet, lobster cooling claws'
        });
        this.updateLobsterVisual('idle');
        this.updateResourceAnimations();
        this.syncWorkStatus();
      }
      return;
    }

    if (this.focusResourceId !== this.lastReachedZoneId) {
      const zone = this.protocols.mapLogic.workZones.find((item) => item.id === this.focusResourceId);
      if (zone) {
        this.beginWorkRoute(zone, {
          resourceId: this.focusResourceId,
          detail: this.focusDetail
        });
      }
    }
  }

  private enqueueAutoWork(): void {
    if (this.liveMode === 'live' || this.workMode === 'working' || this.lobsterRoute.length > 0) {
      return;
    }

    const zones = this.protocols.mapLogic.workZones.filter((zone) => zone.id !== 'break_room');
    if (zones.length === 0) {
      return;
    }

    const zone = zones[this.workCursor % zones.length];
    this.workCursor += 1;
    this.beginWorkRoute(zone, {
      resourceId: zone.id,
      detail: `mock patrol into ${zone.label.toLowerCase()}`
    });
  }

  private clearZoneStates(): void {
    for (const zone of this.protocols.mapLogic.workZones) {
      this.zoneState.set(zone.id, 'idle');
    }
  }

  private syncWorkStatus(): void {
    const activeZone = this.activeZoneId
      ? this.zoneLabel(this.activeZoneId)
      : this.lastReachedZoneId
        ? this.zoneLabel(this.lastReachedZoneId)
        : 'None';

    this.workStatusText.setText(
      [
        `state: ${this.lastOutput.stateLabel} · ${this.workMode}`,
        `zone: ${activeZone} · focus ${this.zoneLabel(this.focusResourceId)}`,
        `feed: ${this.liveMode} · queue ${this.telemetryQueue.length} · update ${this.formatClock(this.lastTelemetryAt)}`,
        `detail: ${this.lastOutput.content}`
      ].join('\n')
    );
    this.syncThoughtBubble();
  }

  private syncThoughtBubble(): void {
    const lowerDetail = this.lastOutput.content.toLowerCase();
    const isAlertish = /(alert|blocked|failed|error|panic|alarm)/.test(lowerDetail);
    const isHappyMoment = Date.now() < this.celebrationUntil || /completed|done|access completed/.test(lowerDetail);

    let lines: string[];
    if (this.workMode === 'moving') {
      lines = this.locale === 'zh'
        ? ['出发啦', '爪力冲刺中']
        : ['On my way', 'claw express'];
    } else if (this.workMode === 'working' && isAlertish) {
      lines = this.locale === 'zh'
        ? ['抓狂中', '别慌我来修']
        : ['Mild panic', 'I can fix this'];
    } else if (this.workMode === 'working') {
      lines = this.locale === 'zh'
        ? ['认真工作', '让我想想']
        : ['Deep focus', 'thinking with claws'];
    } else if (isHappyMoment) {
      lines = this.locale === 'zh'
        ? ['搞定啦', '今天很开心']
        : ['Done!', 'tiny victory'];
    } else if (this.focusResourceId === 'break_room') {
      lines = this.locale === 'zh'
        ? ['打个瞌睡', '等下一份工作']
        : ['Tiny claw nap', 'waiting for work'];
    } else if (isAlertish) {
      lines = this.locale === 'zh'
        ? ['糟糕怎么办', '先冷静一下']
        : ['Uh oh...', 'stay calm'];
    } else {
      lines = this.locale === 'zh'
        ? ['我在待命', '下一单是什么']
        : ['Standing by', 'what next?'];
    }

    this.lobsterThoughtText.setText(lines.join('\n'));
    this.positionThoughtBubble();
  }

  private positionThoughtBubble(): void {
    if (!this.lobster || !this.lobsterThoughtText) {
      return;
    }
    const bubbleY = this.lobster.getBounds().top - 12;
    this.lobsterThoughtText.setPosition(this.lobster.x, bubbleY);
    this.lobsterThoughtText.setDepth(this.layerToDepth('fx_overlay') + 12);
  }

  private findWorkZone(point: Point): WorkZone | null {
    for (const zone of this.protocols.mapLogic.workZones) {
      const dx = point.x - zone.anchor.x;
      const dy = point.y - zone.anchor.y;
      if (dx * dx + dy * dy <= zone.radius * zone.radius) {
        return zone;
      }
    }
    return null;
  }

  private findHitAsset(point: Point): AssetDef | null {
    if (this.hasSceneBaseArt()) {
      return null;
    }
    const visibleIds = computeVisibleAssetIds(this.protocols.assetManifest, this.growthState);

    for (const asset of this.protocols.assetManifest.assets) {
      if (!visibleIds.has(asset.id)) {
        continue;
      }
      if (pointInPolygon(point, asset.hitPolygon)) {
        return asset;
      }
    }

    return null;
  }

  private findRoomByPoint(point: Point) {
    return this.protocols.mapLogic.rooms.find((room) => {
      const [x, y, width, height] = room.bounds;
      return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
    }) ?? null;
  }

  private isWalkablePoint(point: Point): boolean {
    const maskDecision = this.isWalkableByMask(point);
    if (maskDecision !== null) {
      return maskDecision;
    }
    const walkableZones = this.protocols.mapLogic.walkableZones ?? [];
    if (walkableZones.length === 0) {
      return true;
    }

    return walkableZones.some((zone) => zone.points.length >= 3 && pointInPolygon(point, zone.points));
  }

  private drawHitOverlay(asset: AssetDef): void {
    this.hitLayer.clear();
    this.hitLayer.fillStyle(PARTITION_COLORS[asset.roomId], 0.2);
    this.hitLayer.lineStyle(3, 0xe9f2ff, 0.95);

    this.hitLayer.beginPath();
    this.hitLayer.moveTo(asset.hitPolygon[0].x, asset.hitPolygon[0].y);
    for (let index = 1; index < asset.hitPolygon.length; index += 1) {
      this.hitLayer.lineTo(asset.hitPolygon[index].x, asset.hitPolygon[index].y);
    }
    this.hitLayer.closePath();
    this.hitLayer.fillPath();
    this.hitLayer.strokePath();
  }

  private applyGrowthState(): void {
    if (this.hasSceneBaseArt()) {
      for (const asset of this.renderedAssets) {
        asset.body.setVisible(false);
      }
      return;
    }

    const visibleAssetIds = computeVisibleAssetIds(this.protocols.assetManifest, this.growthState);

    for (const asset of this.renderedAssets) {
      const shouldShow = visibleAssetIds.has(asset.def.id);
      asset.body.setVisible(shouldShow);
      if (shouldShow) {
        this.tweens.add({
          targets: asset.body,
          scaleX: { from: 0.85, to: 1 },
          scaleY: { from: 0.85, to: 1 },
          alpha: { from: 0.3, to: 1 },
          duration: 260,
          ease: 'Sine.Out'
        });
      }
    }
  }

  private updateResourceAnimations(): void {
    const activeResource = this.activeZoneId;
    for (const asset of this.renderedAssets) {
      const telemetry = this.telemetryResources.get(asset.def.roomId);
      const isActive = activeResource === asset.def.roomId || telemetry?.status === 'active' || telemetry?.status === 'alert';
      if (isActive) {
        if (!asset.pulseTween) {
          asset.pulseTween = this.tweens.add({
            targets: asset.body,
            scaleX: { from: 1, to: 1.05 },
            scaleY: { from: 1, to: 1.05 },
            yoyo: true,
            duration: 620,
            repeat: -1,
            ease: 'Sine.InOut'
          });
        }
        asset.body.setStrokeStyle(3, PARTITION_COLORS[asset.def.roomId], telemetry?.status === 'alert' ? 1 : 0.95);
      } else {
        asset.pulseTween?.stop();
        asset.pulseTween = null;
        asset.body.setScale(1);
        asset.body.setStrokeStyle(2, 0x223050, 0.82);
      }
    }
  }

  private resolveStateProfile(stateId: LobsterStateId): WorkStateProfile {
    return this.protocols.workOutput.states.find((item) => item.id === stateId) ?? this.protocols.workOutput.states[0];
  }

  private pickStateProfile(zoneType: WorkZoneType): WorkStateProfile {
    const candidates = this.protocols.workOutput.states.filter((item) => item.zoneTypes.includes(zoneType) && item.id !== 'idle');
    if (candidates.length === 0) {
      return this.resolveStateProfile(zoneType === 'break_room' ? 'resting' : 'executing');
    }

    const cursor = this.stateCursorByZoneType.get(zoneType) ?? 0;
    const profile = candidates[cursor % candidates.length];
    this.stateCursorByZoneType.set(zoneType, cursor + 1);
    return profile;
  }

  private resolveCategory(categoryId: string): OutputCategoryDef {
    return this.protocols.workOutput.outputCategories.find((item) => item.id === categoryId) ?? this.protocols.workOutput.outputCategories[0];
  }

  private resolveInterface(interfaceId: string): InterfaceDef {
    return this.protocols.workOutput.interfaces.find((item) => item.id === interfaceId) ?? this.protocols.workOutput.interfaces[0];
  }

  private materializeOutput(
    profile: WorkStateProfile,
    options: {
      resourceId?: ResourcePartitionId;
      detailOverride?: string;
    } = {}
  ): WorkOutputEvent {
    const resourceId = options.resourceId;
    const categoryId =
      resourceId && profile.outputCategoryIds.includes(resourceId)
        ? resourceId
        : this.pick(profile.outputCategoryIds);
    const interfaceId =
      resourceId && profile.interfaceIds.includes(resourceId)
        ? resourceId
        : this.pick(profile.interfaceIds);

    const category = this.resolveCategory(categoryId);
    const iface = this.resolveInterface(interfaceId);
    const detail = options.detailOverride ?? `${this.pick(profile.detailTemplates)} (${this.pick(category.sampleContents)})`;

    this.outputCursor += 1;

    return {
      stateId: profile.id,
      stateLabel: profile.label,
      outputCategoryId: category.id,
      outputCategoryLabel: category.label,
      interfaceId: iface.id,
      interfaceLabel: iface.label,
      interfaceEndpoint: iface.endpoint,
      content: detail
    };
  }

  private pick<T>(list: T[]): T {
    const index = this.outputCursor % list.length;
    return list[index];
  }

  private zoneLabel(zoneId: ResourcePartitionId): string {
    return this.protocols.mapLogic.workZones.find((zone) => zone.id === zoneId)?.label ?? zoneId;
  }

  private formatClock(value: string | null): string {
    if (!value) {
      return '--:--';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '--:--';
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private getTheme(): ThemePack['themes'][number] {
    return this.protocols.themePack.themes[this.currentThemeIndex];
  }

  private initializeRenderLayerDepths(): void {
    const defaults = {
      floor: 1,
      back_walls: 8,
      mid_props: 20,
      actor: 30,
      fg_occluder: 50,
      fx_overlay: 70
    } as const;

    for (const [layerId, depth] of Object.entries(defaults)) {
      this.renderLayerDepths.set(layerId, depth);
    }

    for (const layer of this.protocols.mapLogic.renderLayers ?? []) {
      this.renderLayerDepths.set(layer.id, layer.depth);
    }
  }

  private getRenderLayerDepth(layerId: string): number {
    return this.renderLayerDepths.get(layerId) ?? 0;
  }

  private sansFontFamily(): string {
    return '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  }

  private displayFontFamily(): string {
    return this.locale === 'zh'
      ? this.sansFontFamily()
      : '"VT323", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  }

  private roomHasSliceLayer(roomId: ResourcePartitionId, layerId: RoomSliceLayerDef['renderLayer']): boolean {
    return this.protocols.sceneArt.roomSlices.some(
      (slice) => slice.roomId === roomId && slice.replacesLayers.includes(layerId)
    );
  }

  private layerToDepth(layer: AssetDef['layer'] | RoomSliceLayerDef['renderLayer'], footY?: number, depthBand?: number): number {
    if (layer === 'ground' || layer === 'floor') {
      return this.getRenderLayerDepth('floor');
    }
    if (layer === 'mid' || layer === 'mid_props') {
      const base = this.getRenderLayerDepth('mid_props');
      return base + (depthBand ?? 0) * 0.1 + (footY ?? 0) * 0.0001;
    }
    if (layer === 'actor') {
      const base = this.getRenderLayerDepth('actor');
      return base + (footY ?? 0) * 0.001;
    }
    if (layer === 'back_walls') {
      return this.getRenderLayerDepth('back_walls');
    }
    if (layer === 'fx_overlay') {
      return this.getRenderLayerDepth('fx_overlay');
    }
    return this.getRenderLayerDepth('fg_occluder') + (depthBand ?? 0) * 0.01;
  }

  private isOccluderHandledBySlice(x: number, y: number, width: number, height: number): boolean {
    const center = { x: x + width / 2, y: y + height / 2 };
    return this.protocols.sceneArt.roomSlices.some((slice) => {
      if (!slice.replacesLayers.includes('fg_occluder')) {
        return false;
      }
      const room = this.protocols.mapLogic.rooms.find((candidate) => candidate.id === slice.roomId);
      if (!room) {
        return false;
      }
      const [left, top, roomWidth, roomHeight] = room.bounds;
      return center.x >= left && center.x <= left + roomWidth && center.y >= top && center.y <= top + roomHeight;
    });
  }

  private resolveActorVariants(): ActorVariantDef[] {
    const actor = this.protocols.sceneArt.actor;
    if (!actor) {
      return [];
    }
    if (Array.isArray(actor.variants) && actor.variants.length > 0) {
      return actor.variants;
    }
    if (Array.isArray(actor.modes) && actor.modes.length > 0) {
      return [{
        id: actor.defaultVariantId ?? actor.id,
        label: 'Default',
        modes: actor.modes
      }];
    }
    return [];
  }

  private resolveActorVariant(): ActorVariantDef | null {
    const variants = this.resolveActorVariants();
    if (variants.length === 0) {
      return null;
    }
    if (this.actorVariantId) {
      const matched = variants.find((variant) => variant.id === this.actorVariantId);
      if (matched) {
        return matched;
      }
    }
    const actor = this.protocols.sceneArt.actor;
    const preferredId = actor?.defaultVariantId;
    if (preferredId) {
      const matched = variants.find((variant) => variant.id === preferredId);
      if (matched) {
        this.actorVariantId = matched.id;
        return matched;
      }
    }
    this.actorVariantId = variants[0].id;
    return variants[0];
  }

  private actorAnimationKey(variantId: string, textureKey: string): string {
    return `actor:${variantId}:${textureKey}`;
  }

  private createActorAnimations(): void {
    for (const variant of this.resolveActorVariants()) {
      for (const mode of variant.modes ?? []) {
        if (mode.kind !== 'spritesheet' || !mode.frameCount) {
          continue;
        }
        const key = this.actorAnimationKey(variant.id, mode.textureKey);
        if (this.anims.exists(key)) {
          continue;
        }
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(mode.textureKey, {
            start: 0,
            end: mode.frameCount - 1
          }),
          frameRate: mode.animation?.fps ?? 10,
          repeat: mode.animation?.repeat ?? -1
        });
      }
    }
  }

  private resolveActorMode(mode: WorkMode) {
    const variant = this.resolveActorVariant();
    if (!variant) {
      return null;
    }
    const stateId = this.lastOutput.stateId;
    const candidates = variant.modes.filter((candidate) => candidate.mode === mode);
    if (candidates.length === 0) {
      return variant.modes[0] ?? null;
    }

    const exactCandidates = candidates.filter((candidate) => candidate.stateIds?.includes(stateId));
    const fallbackCandidates = exactCandidates.length > 0
      ? exactCandidates
      : candidates.filter((candidate) => !candidate.stateIds || candidate.stateIds.length === 0);
    const usable = fallbackCandidates.length > 0 ? fallbackCandidates : candidates;
    const contextKey = `${variant.id}:${mode}:${stateId}`;
    const now = Date.now();
    const heldSelection = this.actorVisualSelectionByContext.get(contextKey);
    if (heldSelection) {
      const matched = usable.find((candidate) => candidate.textureKey === heldSelection.textureKey);
      if (matched && (usable.length <= 1 || now < heldSelection.holdUntil)) {
        return matched;
      }
    }

    const cursor = this.actorVisualCursorByContext.get(contextKey) ?? 0;
    const selected = usable[cursor % usable.length] ?? usable[0];
    this.actorVisualCursorByContext.set(contextKey, cursor + 1);
    this.actorVisualSelectionByContext.set(contextKey, {
      textureKey: selected.textureKey,
      holdUntil: usable.length > 1 ? now + 60_000 : Number.POSITIVE_INFINITY
    });
    return selected;
  }

  private currentActorVisualMode(): WorkMode {
    if (this.workMode === 'working') {
      return 'working';
    }
    if (this.workMode === 'moving' || this.lobsterRoute.length > 0) {
      return 'moving';
    }
    return 'idle';
  }

  /**
   * Draw (or redraw) the context-window bar above the main lobster.
   * @param remaining — fraction 0–1 (1 = full context available, 0 = exhausted)
   */
  private drawContextBar(remaining: number): void {
    if (!this.lobsterContextBar) {
      return;
    }
    const actor = this.protocols.sceneArt.actor;
    const barWidth = actor ? Math.round(actor.displaySize.width * 0.72) : 44;
    const barHeight = 5;
    const barX = -Math.round(barWidth / 2);

    // Vertically position above the sprite — use anchorOffset if defined
    const anchorOffsetY = actor?.anchorOffset?.y ?? 0;
    const spriteHalfH = actor ? Math.round(actor.displaySize.height / 2) : 24;
    const barY = anchorOffsetY - spriteHalfH - 10;

    // Interpolate color: green → lime → yellow → orange → red
    const pct = Math.max(0, Math.min(1, remaining));
    let barColor: number;
    if (pct >= 0.70) {
      barColor = 0x44ff88; // green
    } else if (pct >= 0.45) {
      barColor = 0xaaff44; // lime
    } else if (pct >= 0.25) {
      barColor = 0xffcc00; // yellow
    } else if (pct >= 0.10) {
      barColor = 0xff8800; // orange
    } else {
      barColor = 0xff4444; // red
    }

    this.lobsterContextBar.clear();

    // Background track
    this.lobsterContextBar.fillStyle(0x000000, 0.36);
    this.lobsterContextBar.fillRoundedRect(barX - 1, barY - 1, barWidth + 2, barHeight + 2, 3);

    // Fill
    const fillWidth = Math.max(2, Math.round(barWidth * pct));
    this.lobsterContextBar.fillStyle(barColor, 0.92);
    this.lobsterContextBar.fillRoundedRect(barX, barY, fillWidth, barHeight, 2);

    // Subtle border
    this.lobsterContextBar.lineStyle(1, 0xffffff, 0.18);
    this.lobsterContextBar.strokeRoundedRect(barX, barY, barWidth, barHeight, 2);
  }

  private updateLobsterVisual(mode: WorkMode): void {
    const actor = this.protocols.sceneArt.actor;
    const variant = this.resolveActorVariant();
    const actorMode = this.resolveActorMode(mode);
    if (!actor || !variant || !actorMode || !(this.lobsterBody instanceof Phaser.GameObjects.Sprite)) {
      return;
    }

    this.lobsterBody.setDisplaySize(actor.displaySize.width, actor.displaySize.height);

    const animationKey = this.actorAnimationKey(variant.id, actorMode.textureKey);
    if (actorMode.kind === 'spritesheet' && actorMode.frameCount && this.anims.exists(animationKey)) {
      if (this.lobsterBody.anims.currentAnim?.key !== animationKey) {
        this.lobsterBody.play(animationKey);
      }
      return;
    }

    this.lobsterBody.stop();
    if (this.lobsterBody.texture.key !== actorMode.textureKey) {
      this.lobsterBody.setTexture(actorMode.textureKey);
    }
    this.lobsterBody.setFrame(0);
  }

  /** Apply the correct animation to a subagent actor sprite, mirroring updateLobsterVisual. */
  private updateAgentActorVisual(agentActor: AgentActor, mode: WorkMode): void {
    if (!(agentActor.body instanceof Phaser.GameObjects.Sprite)) {
      return;
    }
    const actorDef = this.protocols.sceneArt.actor;
    const variant = this.resolveActorVariant();
    if (!actorDef || !variant) {
      return;
    }

    // Resolve the mode entry — reuse resolveActorMode which reads from variant.modes
    const candidates = variant.modes.filter((m) => m.mode === mode);
    const fallback = variant.modes.filter((m) => m.mode === 'idle');
    const modeEntry = (candidates.length > 0 ? candidates : fallback)[0] ?? variant.modes[0];
    if (!modeEntry) {
      return;
    }

    const scaleFactor = 0.88; // same as spawn scale
    agentActor.body.setDisplaySize(actorDef.displaySize.width * scaleFactor, actorDef.displaySize.height * scaleFactor);

    const animationKey = this.actorAnimationKey(variant.id, modeEntry.textureKey);
    if (modeEntry.kind === 'spritesheet' && modeEntry.frameCount && this.anims.exists(animationKey)) {
      if (agentActor.body.anims.currentAnim?.key !== animationKey) {
        agentActor.body.play(animationKey);
      }
      return;
    }

    agentActor.body.stop();
    if (agentActor.body.texture.key !== modeEntry.textureKey) {
      agentActor.body.setTexture(modeEntry.textureKey);
    }
    agentActor.body.setFrame(0);
  }
}
